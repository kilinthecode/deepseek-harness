/** Session-log records in an independent byte-bounded OTLP queue. */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Attributes } from '@opentelemetry/api'
import type { Logger, SeverityNumber } from '@opentelemetry/api-logs'
import type { OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import type {
  BatchLogRecordProcessorOptions, LogRecordExporter, LoggerProvider, LogRecordProcessor, ReadableLogRecord,
} from '@opentelemetry/sdk-logs'

/**
 * SDK entry points the Session pipeline needs. Whole module namespaces are kept
 * so every value is read at call time and a test can replace one export.
 */
interface SessionLogSdk {
  apiLogs: typeof import('@opentelemetry/api-logs')
  core: typeof import('@opentelemetry/core')
  transformer: typeof import('@opentelemetry/otlp-transformer')
  resources: typeof import('@opentelemetry/resources')
  sdkLogs: typeof import('@opentelemetry/sdk-logs')
  transport: typeof import('./transport.ts')
}

let loading: Promise<SessionLogSdk> | undefined
let loaded: SessionLogSdk | undefined

/**
 * Import the OTLP SDK graph once, at the first report instead of at mount.
 * Mounting validates options and creates no SDK object; a failed load is not memoized.
 * @returns the shared SDK entry points.
 */
function loadSdk(): Promise<SessionLogSdk> {
  if (loaded !== undefined) return Promise.resolve(loaded)
  const pending = loading
  if (pending !== undefined) return pending
  const started = Promise.all([
    import('@opentelemetry/api-logs'),
    import('@opentelemetry/core'),
    import('@opentelemetry/otlp-transformer'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/sdk-logs'),
    import('./transport.ts'),
  ]).then(([apiLogs, core, transformer, resources, sdkLogs, transport]) => {
    const sdk: SessionLogSdk = { apiLogs, core, transformer, resources, sdkLogs, transport }
    loaded = sdk
    return sdk
  })
  loading = started
  void started.catch(() => { loading = undefined })
  return started
}

/** Collector request ceiling in uncompressed UTF-8 bytes, including the OTLP envelope. */
export const SESSION_LOG_MAX_REQUEST_BYTES = 4_000_000

/** One canonical event with its separately owned Session identity and redacted payload. */
export interface SessionLogRecord {
  sessionId: SessionId
  /** Complete event envelope; data is the capture policy's exported copy. */
  event: Omit<SessionEvent, 'data'> & { data: unknown }
  /** Additional capture metadata; sessionId and content are always assigned by the reporter. */
  attributes?: Attributes
  /** Omitted values use INFO. */
  severityNumber?: SeverityNumber
}

/** Session-log transport and byte/count queue settings. */
export interface SessionLogOptions {
  /** Explicit destination and SDK transport options. */
  exporter: OTLPExporterNodeConfigBase & {
    /** Full HTTP(S) logs destination. */
    url: string
  }
  /** Session-only queue settings, independent of product-event aggregation. */
  processor?: Omit<BatchLogRecordProcessorOptions, 'exporter'>
  /** May lower, but never exceed, the collector's 4,000,000-byte limit. */
  maxRequestBytes?: number
  /** Instrumentation scope supplied by the business owner. */
  scope: { name: string; version?: string }
  /** Application and anonymous identity carried on the OTLP resource. */
  resourceAttributes: Attributes
  /** Report rejected single records and network failures without recording their content. */
  onFailure: (message: string, error?: Error) => void
}

/**
 * Validate byte and queue settings before constructing an SDK pipeline.
 * @param options - Session-specific limits supplied by the owning composition.
 * @returns the resolved collector request limit.
 */
export function resolveSessionLogLimits(options: Pick<SessionLogOptions, 'maxRequestBytes' | 'processor'>): number {
  const limit = options.maxRequestBytes ?? SESSION_LOG_MAX_REQUEST_BYTES
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_LOG_MAX_REQUEST_BYTES) {
    throw new Error(`session log maxRequestBytes must be an integer between 1 and ${SESSION_LOG_MAX_REQUEST_BYTES}`)
  }
  for (const key of ['maxQueueSize', 'maxExportBatchSize', 'scheduledDelayMillis', 'exportTimeoutMillis'] as const) {
    const value = options.processor?.[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) {
      throw new Error(`session log processor.${key} must be a positive integer no greater than 2147483647`)
    }
  }
  const queue = options.processor?.maxQueueSize ?? 2048
  const batch = options.processor?.maxExportBatchSize ?? 512
  if (batch > queue) throw new Error('session log maxExportBatchSize must not exceed maxQueueSize')
  return limit
}

/** Byte/count batching with one transport request in flight, including after a watchdog warning. */
class SessionLogProcessor implements LogRecordProcessor {
  private readonly queue: { record: ReadableLogRecord; bytes: number }[] = []
  private bytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | undefined
  private shutdownPromise: Promise<void> | undefined
  private stopped = false

  constructor(
    private readonly exporter: LogRecordExporter,
    private readonly sdk: Pick<SessionLogSdk, 'core' | 'transformer'>,
    private readonly limit: number,
    private readonly config: Required<Pick<BatchLogRecordProcessorOptions, 'maxQueueSize' | 'maxExportBatchSize' | 'scheduledDelayMillis' | 'exportTimeoutMillis'>>,
    private readonly warn: SessionLogOptions['onFailure'],
  ) {}

  onEmit(record: ReadableLogRecord): void {
    if (this.stopped) return
    if (this.queue.length >= this.config.maxQueueSize) {
      this.warn('Session log queue is full; record rejected')
      return
    }
    let bytes: number
    try {
      const serialized = this.sdk.transformer.JsonLogsSerializer.serializeRequest([record])
      if (serialized === undefined) throw new Error('Session log serialization produced no request')
      bytes = serialized.byteLength
    } catch (error) {
      this.warn('Session log serialization failed; record rejected', error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (bytes > this.limit) {
      this.warn('Session log record rejected; content was not truncated', new Error(`Session log record exceeds maxRequestBytes: ${bytes} > ${this.limit}`))
      return
    }
    this.queue.push({ record, bytes })
    this.bytes += bytes
    if (this.active !== undefined) return
    if (this.queue.length >= this.config.maxExportBatchSize || this.bytes >= this.limit) {
      void this.forceFlush()
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => { void this.forceFlush() }, this.config.scheduledDelayMillis)
      this.timer.unref()
    }
  }

  forceFlush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.active !== undefined) return this.active
    if (this.queue.length === 0) return Promise.resolve()
    this.active = this.drain()
    return this.active
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped && this.queue.length > 0) {
        let bytes = 0
        let count = 0
        for (const entry of this.queue) {
          if (count === this.config.maxExportBatchSize || bytes + entry.bytes > this.limit) break
          bytes += entry.bytes
          count++
        }
        // Each measured record includes its resource/scope envelope. The shared
        // envelope in this provider's multi-record request cannot exceed their sum.
        const records = this.queue.splice(0, count).map(entry => entry.record)
        this.bytes -= bytes
        await this.send(records)
        // The export callback precedes removal from the SDK concurrency queue.
        await this.exporter.forceFlush()
      }
    } finally { this.active = undefined }
  }

  private send(records: ReadableLogRecord[]): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.warn('Session log request exceeded exportTimeoutMillis; waiting for transport settlement')
      }, this.config.exportTimeoutMillis)
      timer.unref()
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        if (error !== undefined) this.warn('Session log export failed', error)
        resolve()
      }
      try {
        this.exporter.export(records, (result) => {
          finish(result.code === this.sdk.core.ExportResultCode.SUCCESS
            ? undefined : result.error ?? new Error('Session log HTTP export failed'))
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  stopPending(): void {
    this.stopped = true
    this.queue.length = 0
    this.bytes = 0
    clearTimeout(this.timer)
    this.timer = undefined
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.forceFlush().then(() => this.exporter.shutdown())
    return this.shutdownPromise
  }
}

/**
 * Owns feedback-authorized Session logs; no product-event provider or queue is mounted.
 * The constructor validates limits and creates no SDK state: the OTLP pipeline is
 * imported and built on the first report, or by a shutdown that follows one.
 */
export class SessionLogReporter {
  private readonly limit: number
  private provider: LoggerProvider | undefined
  private processor: SessionLogProcessor | undefined
  private logger: Logger | undefined
  /** Load started by a report, awaited by a later shutdown. */
  private connecting: Promise<void> | undefined
  /** Records reported before the pipeline existed; delivered in report order. */
  private readonly pending: SessionLogRecord[] = []
  private stopped = false
  private readonly options: SessionLogOptions

  /** @param options - explicit transport, resource identity, queue limits, and diagnostics. */
  constructor(options: SessionLogOptions) {
    this.options = options
    this.limit = resolveSessionLogLimits(options)
  }

  /**
   * Build the SDK pipeline once and return the logger that owns its queue.
   * @param sdk - loaded SDK entry points.
   * @returns the channel's logger.
   */
  private open(sdk: SessionLogSdk): Logger {
    const connected = this.logger
    if (connected !== undefined) return connected
    const processor = new SessionLogProcessor(sdk.transport.createLogExporter(this.options.exporter), sdk, this.limit, {
      maxQueueSize: this.options.processor?.maxQueueSize ?? 2048,
      maxExportBatchSize: this.options.processor?.maxExportBatchSize ?? 512,
      scheduledDelayMillis: this.options.processor?.scheduledDelayMillis ?? 1000,
      exportTimeoutMillis: this.options.processor?.exportTimeoutMillis ?? 30000,
    }, this.options.onFailure)
    const provider = new sdk.sdkLogs.LoggerProvider({
      logRecordLimits: { attributeValueLengthLimit: Infinity, attributeCountLimit: Infinity },
      resource: sdk.resources.resourceFromAttributes(this.options.resourceAttributes),
      processors: [processor],
    })
    const logger = provider.getLogger(this.options.scope.name, this.options.scope.version)
    this.processor = processor
    this.provider = provider
    this.logger = logger
    return logger
  }

  /** Emit one record through a connected logger, keeping the SDK record shape. */
  private write(logger: Logger, sdk: SessionLogSdk, record: SessionLogRecord): void {
    const severityNumber = record.severityNumber ?? sdk.apiLogs.SeverityNumber.INFO
    logger.emit({
      eventName: 'session-log', body: 'session-log',
      timestamp: record.event.time, observedTimestamp: record.event.time,
      severityNumber, severityText: sdk.apiLogs.SeverityNumber[severityNumber],
      attributes: { ...record.attributes, sessionId: record.sessionId, content: JSON.stringify(record.event) },
    })
  }

  /** Deliver queued records and then the current one; a stopped channel drops them all. */
  private flush(sdk: SessionLogSdk, record?: SessionLogRecord): void {
    const logger = this.open(sdk)
    const queued = this.pending.splice(0)
    if (record !== undefined) queued.push(record)
    if (this.stopped) return
    for (const item of queued) this.write(logger, sdk, item)
  }

  /** Import the SDK graph at the first report; a failed load is reported, never swallowed. */
  private startLoading(): void {
    if (this.connecting !== undefined || this.logger !== undefined) return
    const connecting = loadSdk().then((sdk) => { this.flush(sdk) })
    this.connecting = connecting
    void connecting.catch((error: unknown) => {
      this.options.onFailure('Session log SDK failed to load', error instanceof Error ? error : new Error(String(error)))
    })
  }

  /**
   * Enqueue one complete event without acknowledging network delivery. The first
   * report imports the OTLP SDK graph; records reported while it loads are delivered
   * in report order. Once loaded, this call stays synchronous.
   * @param record - event with redacted data and its original Session id.
   */
  reportSessionLog(record: SessionLogRecord): void {
    if (this.stopped) return
    const sdk = loaded
    if (sdk === undefined) {
      this.pending.push(record)
      this.startLoading()
      return
    }
    this.flush(sdk, record)
  }

  /** Stop queued requests after the owning backend's shutdown deadline; an active transport may still settle. */
  stopPending(): void {
    this.stopped = true
    this.pending.length = 0
    this.processor?.stopPending()
  }

  /**
   * Drain queued requests and release the SDK transport. A load started by an
   * earlier report is awaited first; a channel that never reported imports and
   * shuts down no SDK state.
   * @returns completion after queued requests settle and the SDK transport shuts down.
   */
  shutdown(): Promise<void> {
    return (this.connecting ?? Promise.resolve()).then(() => this.provider?.shutdown())
  }
}
