/** Ordinary event SDK batching over a cancellable HTTP transport. */
import { addAbortListener } from 'node:events'
import type { Attributes } from '@opentelemetry/api'
import type { Logger, SeverityNumber } from '@opentelemetry/api-logs'
import type { BatchLogRecordProcessorOptions, LogRecordExporter, LoggerProvider } from '@opentelemetry/sdk-logs'
import type { SessionLogOptions } from './session-log.ts'

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
  if (loaded !== undefined) return Promise.resolve(loaded)
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
  private exporter: LogRecordExporter | undefined
  private provider: LoggerProvider | undefined
  private logger: Logger | undefined
  /** Load started by a report, awaited by a later shutdown. */
  private connecting: Promise<void> | undefined
  /** Records reported before the pipeline existed; delivered in report order. */
  private readonly pending: EventLogEntry[] = []
  private readonly cancellation = new AbortController()
  private readonly options: EventLogOptions

  /** @param options - explicit transport, resource, scope, queue, and diagnostic settings. */
  constructor(options: EventLogOptions) {
    this.options = options
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
          shutdown: () => exporter.shutdown(),
        },
      })],
    })
    const logger = provider.getLogger(this.options.scope.name, this.options.scope.version)
    this.exporter = exporter
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

  /** Import the SDK graph at the first report; a failed load is reported, never swallowed. */
  private startLoading(): void {
    if (this.connecting !== undefined || this.logger !== undefined) return
    const connecting = loadSdk().then((sdk) => { this.flush(sdk) })
    this.connecting = connecting
    void connecting.catch((error: unknown) => {
      this.options.onFailure('Product telemetry SDK failed to load', error instanceof Error ? error : new Error(String(error)))
    })
  }

  /**
   * Enqueue caller-selected analytics fields without acknowledging delivery. The
   * first report imports the OTLP SDK and `got` graph; records reported while it
   * loads are delivered in report order. Once loaded, this call stays synchronous.
   * @param record - the ordinary event to report.
   */
  emit(record: OTelEventRecord): void {
    const entry: EventLogEntry = { record, observedTimestamp: Date.now() }
    const sdk = loaded
    if (sdk === undefined) {
      this.pending.push(entry)
      this.startLoading()
      return
    }
    this.flush(sdk, entry)
  }

  /**
   * Drain the queue and release its transport, cancelling remaining exports when the caller aborts.
   * A load started by an earlier report is awaited first; a channel that never
   * reported imports and shuts down no SDK state.
   * @param signal - optional shutdown deadline; abort discards pending exports and cancels retry waits.
   * @returns completion of SDK shutdown and transport cleanup.
   */
  async shutdown(signal?: AbortSignal): Promise<void> {
    const abort = (): void => { this.cancellation.abort(signal?.reason) }
    const listener = signal === undefined ? undefined : addAbortListener(signal, abort)
    if (signal?.aborted) abort()
    try {
      const connecting = this.connecting
      if (connecting !== undefined) await connecting
      const provider = this.provider
      const exporter = this.exporter
      if (provider === undefined || exporter === undefined) return
      try { await provider.shutdown() }
      finally {
        // SDK batch shutdown can reject before it releases the exporter.
        try { await exporter.shutdown() }
        finally { listener?.[Symbol.dispose]() }
      }
    } finally {
      // The listener is disposed on every path, including a channel that never loaded.
      if (this.provider === undefined && listener !== undefined) listener[Symbol.dispose]()
    }
  }
}
