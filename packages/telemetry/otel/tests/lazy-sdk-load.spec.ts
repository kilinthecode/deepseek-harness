import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import OTel from '../src/index.ts'
import { EventLogReporter } from '../src/event-log.ts'
import type { SessionLogRecord } from '../src/session-log.ts'

/** Load counter for the deferred SDK/exporter/got graph; laziness keeps it empty until first use. */
const loads = vi.hoisted(() => ({ names: [] as string[] }))

vi.mock('@opentelemetry/sdk-logs', async (importOriginal) => {
  loads.names.push('@opentelemetry/sdk-logs')
  return await importOriginal()
})
vi.mock('@opentelemetry/otlp-transformer', async (importOriginal) => {
  loads.names.push('@opentelemetry/otlp-transformer')
  return await importOriginal()
})
vi.mock('@opentelemetry/otlp-exporter-base', async (importOriginal) => {
  loads.names.push('@opentelemetry/otlp-exporter-base')
  return await importOriginal()
})
vi.mock('@opentelemetry/resources', async (importOriginal) => {
  loads.names.push('@opentelemetry/resources')
  return await importOriginal()
})
vi.mock('got', async (importOriginal) => {
  loads.names.push('got')
  return await importOriginal()
})

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  } finally {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  }
})

beforeEach(() => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_COMPRESSION', undefined)
  vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_COMPRESSION', undefined)
})

function moduleLoads(name: string): number {
  return loads.names.filter(loaded => loaded === name).length
}

async function collector() {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString())
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  cleanup.push(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('collector has no port')
  return { bodies, url: `http://127.0.0.1:${address.port}/v1/logs` }
}

function sessionRecord(seq = 0): SessionLogRecord {
  return {
    sessionId: SessionId('lazy-sdk-session'),
    event: { type: 'user/message', seq: SessionSeq(seq), time: 1_800_000_000_000, surfaceOp: 'append',
      data: { content: [{ type: 'text', text: `lazy-sdk-${seq}` }] } },
  }
}

function sessionChannel(ctx: Context, url: string) {
  const onFailure = vi.fn()
  const sender = ctx.otel.createSessionLogReporter({
    scope: { name: 'lazy-sdk-test' }, exporter: { url, timeoutMillis: 1000 },
    resourceAttributes: { 'service.name': 'lazy-sdk-test' },
    processor: { scheduledDelayMillis: 60000 }, onFailure,
  })
  cleanup.push(() => sender.shutdown())
  return { sender, onFailure }
}

it('mounts the service and creates a Session channel without importing the SDK graph', async () => {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(OTel)
  const sender = ctx.otel.createSessionLogReporter({
    scope: { name: 'lazy-sdk-test' }, exporter: { url: 'http://collector.test/v1/logs' },
    resourceAttributes: { 'service.name': 'lazy-sdk-test' }, onFailure: vi.fn(),
  })
  expect(loads.names).toEqual([])
  await sender.shutdown()
  expect(loads.names).toEqual([])
})

it('keeps unused reporting channels closed after shutdown', async () => {
  const target = await collector()
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(OTel)
  const { sender: session } = sessionChannel(ctx, target.url)
  const ordinary = new EventLogReporter({
    scope: { name: 'unused-channel' }, exporter: { url: target.url, timeoutMillis: 1000 },
    resourceAttributes: {}, processor: {}, onFailure: vi.fn(),
  })
  cleanup.push(() => ordinary.shutdown())
  const before = loads.names.length
  await session.shutdown()
  await ordinary.shutdown()
  session.reportSessionLog(sessionRecord(9))
  ordinary.emit({ eventName: 'late-unused', body: 'late-unused', timestamp: 1 })
  await session.shutdown()
  await ordinary.shutdown()
  expect(loads.names.length).toBe(before)
  expect(target.bodies).toEqual([])
})

it('imports the Session SDK graph on the first report and reuses it for later reports', async () => {
  const target = await collector()
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(OTel)
  const { sender, onFailure } = sessionChannel(ctx, target.url)
  const before = loads.names.length
  const { sender: concurrent } = sessionChannel(ctx, target.url)
  const { sender: stopped } = sessionChannel(ctx, target.url)
  const rejecting = ctx.otel.createSessionLogReporter({
    scope: { name: 'deadline-during-drain' }, exporter: { url: target.url }, resourceAttributes: {},
    maxRequestBytes: 1, onFailure: () => { rejecting.stopPending() },
  })
  cleanup.push(() => rejecting.shutdown())
  sender.reportSessionLog(sessionRecord())
  concurrent.reportSessionLog(sessionRecord(3))
  stopped.reportSessionLog(sessionRecord(4))
  stopped.stopPending()
  rejecting.reportSessionLog(sessionRecord(5))
  rejecting.reportSessionLog(sessionRecord(6))
  await Promise.all([concurrent.shutdown(), stopped.shutdown(), rejecting.shutdown()])
  sender.reportSessionLog(sessionRecord(1))
  const shutdown = sender.shutdown()
  sender.reportSessionLog(sessionRecord(2))
  await shutdown
  expect(loads.names.length).toBeGreaterThan(before)
  expect(loads.names).toContain('@opentelemetry/sdk-logs')
  expect(loads.names).toContain('@opentelemetry/otlp-transformer')
  expect(moduleLoads('@opentelemetry/sdk-logs')).toBe(1)
  expect(onFailure).not.toHaveBeenCalled()
  const body = target.bodies.join('')
  expect(body).toContain('lazy-sdk-0')
  expect(body.indexOf('lazy-sdk-0')).toBeLessThan(body.indexOf('lazy-sdk-1'))
  expect(body).not.toContain('lazy-sdk-2')
  expect(body).toContain('lazy-sdk-3')
  expect(body).not.toContain('lazy-sdk-4')
})

it('imports got and the ordinary-event SDK graph on the first report', async () => {
  const target = await collector()
  const onFailure = vi.fn()
  const sender = new EventLogReporter({
    scope: { name: 'lazy-sdk-test' }, exporter: { url: target.url, timeoutMillis: 1000 },
    resourceAttributes: { 'service.name': 'lazy-sdk-test' },
    processor: { scheduledDelayMillis: 60000 }, onFailure,
  })
  cleanup.push(() => sender.shutdown())
  const gotBefore = moduleLoads('got')
  const concurrent = new EventLogReporter({
    scope: { name: 'concurrent-event' }, exporter: { url: target.url }, resourceAttributes: {},
    processor: { scheduledDelayMillis: 60000 }, onFailure,
  })
  cleanup.push(() => concurrent.shutdown())
  sender.emit({ eventName: 'lazy-sdk-event' , body: 'lazy-sdk-event', timestamp: 1_800_000_000_000 })
  concurrent.emit({ eventName: 'concurrent-event', body: 'concurrent-event', timestamp: 1 })
  const shutdown = Promise.all([sender.shutdown(), concurrent.shutdown()])
  sender.emit({ eventName: 'late-event', body: 'late-event', timestamp: 1 })
  await shutdown
  expect(moduleLoads('got')).toBe(gotBefore + 1)
  expect(onFailure).not.toHaveBeenCalled()
  expect(target.bodies.join('')).toContain('lazy-sdk-event')
  expect(target.bodies.join('')).not.toContain('late-event')
})

it('reports synchronously on a connected channel and releases its exporter once', async () => {
  const target = await collector()
  const transport = await import('../src/event-transport.ts')
  const create = vi.spyOn(transport, 'createEventLogExporter')
  const sender = new EventLogReporter({
    scope: { name: 'connected-channel' }, exporter: { url: target.url, timeoutMillis: 1000 },
    resourceAttributes: {}, processor: { scheduledDelayMillis: 60000 }, onFailure: vi.fn(),
  })
  cleanup.push(() => sender.shutdown())
  sender.emit({ eventName: 'connected-first', body: 'connected-first', timestamp: 1 })
  await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
  const result = create.mock.results.at(0)
  if (result?.type !== 'return') throw new Error('Expected the connected exporter factory to return')
  const close = vi.spyOn(result.value, 'shutdown')
  sender.emit({ eventName: 'connected-second', body: 'connected-second', timestamp: 2 })
  expect(create).toHaveBeenCalledTimes(1)
  await sender.shutdown()
  const calls = close.mock.calls.length
  expect(calls).toBe(1)
  sender.emit({ eventName: 'connected-late', body: 'connected-late', timestamp: 3 })
  await sender.shutdown()
  expect(close).toHaveBeenCalledTimes(calls)
  const body = target.bodies.join('')
  expect(body).toContain('connected-first')
  expect(body).toContain('connected-second')
  expect(body).not.toContain('connected-late')
})
