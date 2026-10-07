/** Ordinary event SDK batching over a cancellable HTTP transport. */
import { addAbortListener } from 'node:events'
import type { Attributes } from '@opentelemetry/api'
import type { Logger, SeverityNumber } from '@opentelemetry/api-logs'
import type { BatchLogRecordProcessorOptions, LoggerProvider } from '@opentelemetry/sdk-logs'
import type { SessionLogOptions } from './session-log.ts'
import { SdkLoad } from './sdk-load.ts'

/**
 * SDK entry points the ordinary-event pipeline needs. Whole module namespaces are
 * kept so every value is read at call time and a test can replace one export.
 */
interface EventLogSdk {
  apiLogs: typeof import('@opentelemetry/api-logs')
  core: typeof import('@opentelemetry/core')
  resources: typeof import('@opentelemetry/resources')
  sdkLogs: typeof import('@opentelemetry/sdk-logs')
  transport: typeof import('./event-transport.ts')
}

let loading: Promise<EventLogSdk> | undefined
let loaded: EventLogSdk | undefined

/**
 * Import the OTLP SDK and `got` graph once, at the first report instead of at
 * mount. Mounting creates no SDK object; a failed load is not memoized.
 * @returns the shared SDK entry points.
 */
function loadSdk(): Promise<EventLogSdk> {
  const pending = loading
  if (pending !== undefined) return pending
  const started = Promise.all([
    import('@opentelemetry/api-logs'),
    import('@opentelemetry/core'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/sdk-logs'),
    import('./event-transport.ts'),
  ]).then(([apiLogs, core, resources, sdkLogs, transport]) => {
    const sdk: EventLogSdk = { apiLogs, core, resources, sdkLogs, transport }
    loaded = sdk
    return sdk
  })
  loading = started
  void started.catch(() => { loading = undefined })
  return started
}

/** The SDK batch processor's default queue bound, applied to records reported before the SDK loads. */
const DEFAULT_MAX_QUEUE_SIZE = 2048

/** One ordinary event with the observation time assigned when it was reported. */
interface EventLogEntry {
  record: OTelEventRecord
  observedTimestamp: number
}

/** Scalar values accepted by the collector's Arrow attributes map. */
export type OTelEventScalar = string | number | boolean

/** Explicitly selected analytics fields; object values may contain scalars only. */
export interface OTelEventRecord {
  /** Product/DA-owned event name. */
  eventName: string
  /** Human-readable summary; never a prompt, response, credential, or file contents. */
  body: string
  /** Event occurrence time in Unix milliseconds. Observation time is assigned on enqueue. */
  timestamp: number
  /** OTel severity; omitted values use INFO. */
  severityNumber?: SeverityNumber
  /** Business fields selected by the caller; no automatic device or account identity. */
  attributes?: Record<string, OTelEventScalar | Record<string, OTelEventScalar>>
}

/** Ordinary-event transport, resource, scope, and count-batching options. */
export interface EventLogOptions {
  exporter: SessionLogOptions['exporter']
  resourceAttributes: Attributes
  scope: { name: string; version?: string }
  processor: Omit<BatchLogRecordProcessorOptions, 'exporter'>
  onFailure: SessionLogOptions['onFailure']
}

/**
 * One caller-owned ordinary-event queue, independent of every Session-log queue.
 * The constructor creates no SDK or `got` state: the pipeline is imported and
 * built on the first report, or by a shutdown that follows one.
 */
export class EventLogReporter {
  private shutdownExporter: (() => Promise<void>) | undefined
  private provider: LoggerProvider | undefined
  private logger: Logger | undefined
  /** This reporter's SDK import, started by the first report and awaited by shutdown. */
  private readonly sdkLoad: SdkLoad<EventLogSdk>
  /** Records reported before the pipeline existed; delivered in report order. */
  private readonly pending: EventLogEntry[] = []
  private readonly cancellation = new AbortController()
  private shutdownPromise: Promise<void> | undefined
  private readonly options: EventLogOptions

  /** @param options - explicit transport, resource, scope, queue, and diagnostic settings. */
  constructor(options: EventLogOptions) {
    this.options = options
    this.sdkLoad = new SdkLoad(loadSdk, (error) => { options.onFailure('Product telemetry SDK failed to load', error) })
  }

  /**
   * Build the SDK pipeline once and return the logger that owns its queue.
   * @param sdk - loaded SDK entry points.
   * @returns the channel's logger.
   */
  private open(sdk: EventLogSdk): Logger {
    const connected = this.logger
    if (connected !== undefined) return connected
    const exporter = sdk.transport.createEventLogExporter(this.options.exporter, this.cancellation.signal)
    let closing: Promise<void> | undefined
    const shutdownExporter = (): Promise<void> => closing ??= exporter.shutdown()
    const provider = new sdk.sdkLogs.LoggerProvider({
      resource: sdk.resources.resourceFromAttributes(this.options.resourceAttributes),
      processors: [new sdk.sdkLogs.BatchLogRecordProcessor({
        ...this.options.processor,
        exporter: {
          export: (records, callback) => {
            exporter.export(records, (result) => {
              if (result.code !== sdk.core.ExportResultCode.SUCCESS) this.options.onFailure('Product telemetry export failed', result.error)
              callback(result)
            })
          },
          forceFlush: () => exporter.forceFlush(),
          shutdown: shutdownExporter,
        },
      })],
    })
    const logger = provider.getLogger(this.options.scope.name, this.options.scope.version)
    this.shutdownExporter = shutdownExporter
    this.provider = provider
    this.logger = logger
    return logger
  }

  /** Deliver queued records and then the current one, in report order. */
  private flush(sdk: EventLogSdk, entry?: EventLogEntry): void {
    const logger = this.open(sdk)
    const queued = this.pending.splice(0)
    if (entry !== undefined) queued.push(entry)
    for (const item of queued) {
      const severityNumber = item.record.severityNumber ?? sdk.apiLogs.SeverityNumber.INFO
      logger.emit({
        ...item.record, observedTimestamp: item.observedTimestamp, severityNumber,
        severityText: sdk.apiLogs.SeverityNumber[severityNumber],
      })
    }
  }

  /**
   * Import the SDK graph at the first report. A failed load is reported through
   * `onFailure` and leaves the queued records for the next report's retry.
   */
  private startLoading(): void {
    this.sdkLoad.start((sdk) => { this.flush(sdk) })
  }

  /**
   * Enqueue caller-selected analytics fields without acknowledging delivery. The
   * first report imports the OTLP SDK and `got` graph; records reported while it
   * loads are delivered in report order. Once loaded, this call stays synchronous.
   * Reports after shutdown begins are ignored.
   * @param record - the ordinary event to report.
   */
  emit(record: OTelEventRecord): void {
    if (this.shutdownPromise !== undefined) return
    const entry: EventLogEntry = { record, observedTimestamp: Date.now() }
    const sdk = loaded
    // While this channel's load is outstanding, a report joins the queue behind the
    // earlier ones, even after the shared graph finished loading.
    if (sdk === undefined || this.sdkLoad.pending) {
      // The batch processor drops records past its queue bound; the pre-load queue does too.
      if (this.pending.length < (this.options.processor.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE)) this.pending.push(entry)
      this.startLoading()
      return
    }
    this.flush(sdk, entry)
  }

  /** Drain accepted records and release the SDK and exporter once. */
  private async drain(): Promise<void> {
    try {
      await this.sdkLoad.settled()
      const provider = this.provider
      const shutdownExporter = this.shutdownExporter
      if (provider === undefined || shutdownExporter === undefined) return
      try { await provider.shutdown() }
      finally { await shutdownExporter() }
    } finally {
      this.pending.length = 0
    }
  }

  /**
   * Stop accepting records synchronously, then drain and release the transport.
   * Accepted records await an in-flight SDK load before cleanup. Repeated calls
   * share cleanup; each caller's signal can cancel requests and retry waits.
   * A channel that never reported imports and shuts down no SDK state.
   * @param signal - optional shutdown deadline; abort discards pending exports and cancels retry waits.
   * @returns completion of SDK shutdown and transport cleanup.
   */
  async shutdown(signal?: AbortSignal): Promise<void> {
    this.shutdownPromise ??= this.drain()
    const abort = (): void => { this.cancellation.abort(signal?.reason) }
    const listener = signal === undefined ? undefined : addAbortListener(signal, abort)
    if (signal?.aborted) abort()
    try {
      await this.shutdownPromise
    } finally {
      listener?.[Symbol.dispose]()
    }
  }
}
