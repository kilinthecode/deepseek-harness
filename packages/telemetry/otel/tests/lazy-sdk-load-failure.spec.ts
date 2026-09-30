/** A failed deferred SDK import is reported, retried by the next report, and never blocks shutdown. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import OTel from '../src/index.ts'
import { EventLogReporter } from '../src/event-log.ts'
import type { SessionLogRecord } from '../src/session-log.ts'

vi.mock('@opentelemetry/sdk-logs', () => {
  throw new Error('sdk-logs unavailable')
})

function sessionRecord(seq: number): SessionLogRecord {
  return {
    sessionId: SessionId('lazy-sdk-failure'),
    event: { type: 'user/message', seq: SessionSeq(seq), time: 1_800_000_000_000, surfaceOp: 'append',
      data: { content: [{ type: 'text', text: `lazy-sdk-failure-${seq}` }] } },
  }
}

async function sessionChannel(maxQueueSize?: number) {
  const ctx = new Context()
  await ctx.plugin(OTel)
  const onFailure = vi.fn()
  const sender = ctx.otel.createSessionLogReporter({
    scope: { name: 'lazy-sdk-failure' }, exporter: { url: 'http://collector.test/v1/logs' },
    resourceAttributes: { 'service.name': 'lazy-sdk-failure' },
    ...maxQueueSize === undefined ? {} : { processor: { maxQueueSize, maxExportBatchSize: maxQueueSize } },
    onFailure,
  })
  return { ctx, sender, onFailure }
}

it('reports a failed Session SDK load, retries it on the next report, and still shuts down', async () => {
  const { ctx, sender, onFailure } = await sessionChannel()
  sender.reportSessionLog(sessionRecord(0))
  await vi.waitFor(() => { expect(onFailure).toHaveBeenCalledTimes(1) })
  sender.reportSessionLog(sessionRecord(1))
  await vi.waitFor(() => { expect(onFailure).toHaveBeenCalledTimes(2) })
  expect(onFailure).toHaveBeenNthCalledWith(1, 'Session log SDK failed to load', expect.any(Error))
  expect(onFailure).toHaveBeenNthCalledWith(2, 'Session log SDK failed to load', expect.any(Error))
  await expect(sender.shutdown()).resolves.toBeUndefined()
  await ctx.fiber.dispose()
})

it('bounds Session records reported before the SDK loads by the configured queue size', async () => {
  const { ctx, sender, onFailure } = await sessionChannel(2)
  sender.reportSessionLog(sessionRecord(0))
  sender.reportSessionLog(sessionRecord(1))
  sender.reportSessionLog(sessionRecord(2))
  expect(onFailure).toHaveBeenCalledWith('Session log queue is full; record rejected')
  await sender.shutdown()
  await ctx.fiber.dispose()
})

it('reports a failed event SDK load, retries it on the next report, and still shuts down', async () => {
  const onFailure = vi.fn()
  const sender = new EventLogReporter({
    scope: { name: 'lazy-sdk-failure' }, exporter: { url: 'http://collector.test/v1/logs' },
    resourceAttributes: { 'service.name': 'lazy-sdk-failure' }, onFailure,
  })
  sender.emit({ eventName: 'first' })
  await vi.waitFor(() => { expect(onFailure).toHaveBeenCalledTimes(1) })
  sender.emit({ eventName: 'second' })
  await vi.waitFor(() => { expect(onFailure).toHaveBeenCalledTimes(2) })
  expect(onFailure).toHaveBeenNthCalledWith(2, 'Product telemetry SDK failed to load', expect.any(Error))
  await expect(sender.shutdown()).resolves.toBeUndefined()
})
