import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter, { UNATTRIBUTED_ROUTE } from '@deepseek-ai/dsh-token-meter'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { CompactionId } from '@deepseek-ai/dsh-compaction'

const CONFIG = { provider: 'test', model: 'test-model' }
const OTHER = { provider: 'test', model: 'other-model' }

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

function header(session: Session, config: { provider: string; model: string }): void {
  session.append('request/header', {
    header: { config },
    reason: session.requestHeader() === undefined ? 'initial' : 'change',
  })
}

function settlement(
  session: Session,
  usage: TokenUsage,
  turn: number,
  step: number,
): void {
  session.append('assistant/message', {
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append' })
}

const projected = (ctx: Context, session: Session): Record<string, TokenUsageProjection> => {
  const value = ctx.sessionProjections.snapshot(session).values.usageByRoute
  if (value === undefined) throw new Error('usageByRoute projection is not registered')
  return value
}

describe('per-route usage projection', () => {
  it('attributes each settled attempt to the route of the newest request header', async () => {
    const { ctx, session } = await harness()
    header(session, CONFIG)
    settlement(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)

    expect(projected(ctx, session)).toEqual({
      'test/test-model': {
        uncachedInputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })
  })

  it('keeps cache buckets per route beside uncached input and output', async () => {
    const { ctx, session } = await harness()
    header(session, CONFIG)
    settlement(session, {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
    }, 1, 1)

    expect(projected(ctx, session)['test/test-model']).toEqual({
      uncachedInputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
    })
  })

  it('folds samples that arrive before any header into the unattributed route', async () => {
    const { ctx, session } = await harness()
    settlement(session, { inputTokens: 1, outputTokens: 1 }, 1, 1)

    expect(Object.keys(projected(ctx, session))).toEqual([UNATTRIBUTED_ROUTE])
  })

  it('replaces a same-step resample instead of accumulating it', async () => {
    const { ctx, session } = await harness()
    header(session, CONFIG)
    settlement(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)
    settlement(session, { inputTokens: 4, outputTokens: 1 }, 1, 1)

    expect(projected(ctx, session)['test/test-model']).toEqual({
      uncachedInputTokens: 4,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('moves a same-step resample to its new route when the header changed', async () => {
    const { ctx, session } = await harness()
    header(session, CONFIG)
    settlement(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)
    header(session, OTHER)
    settlement(session, { inputTokens: 4, outputTokens: 1 }, 1, 1)

    expect(projected(ctx, session)).toEqual({
      'test/test-model': {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      'test/other-model': {
        uncachedInputTokens: 4,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })
  })

  it('counts the retried attempt beside its predecessor once retry closes the slot', async () => {
    const { ctx, session } = await harness()
    header(session, CONFIG)
    settlement(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)
    session.append('llm/retry-started', {
      retryId: RetryId('usage-by-route-retry'),
      turn: 1,
      step: 1,
      retry: 1,
    })
    settlement(session, { inputTokens: 4, outputTokens: 1 }, 1, 1)

    expect(projected(ctx, session)['test/test-model']).toEqual({
      uncachedInputTokens: 14,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('leaves the state untouched when a retry names another step', async () => {
    const { ctx, session } = await harness()
    header(session, CONFIG)
    settlement(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)
    const before = projected(ctx, session)
    session.append('llm/retry-started', {
      retryId: RetryId('usage-by-route-other-step'),
      turn: 1,
      step: 7,
      retry: 1,
    })

    expect(projected(ctx, session)).toEqual(before)
    settlement(session, { inputTokens: 4, outputTokens: 1 }, 2, 1)
    expect(projected(ctx, session)['test/test-model']!.uncachedInputTokens).toBe(14)
  })

  it('ignores an identical repeated sample for the same step', async () => {
    const { ctx, session } = await harness()
    header(session, CONFIG)
    settlement(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)
    const before = projected(ctx, session)
    settlement(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)

    expect(projected(ctx, session)).toEqual(before)
  })

  it('bills a compaction summary to the route that wrote it', async () => {
    const { ctx, session } = await harness()
    header(session, CONFIG)
    settlement(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)
    session.append('compaction/summary', {
      compactionId: CompactionId('usage-by-route-summary'),
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) },
      shadowedSeqs: [SessionSeq(0)],
      shadowedTokenCount: 0,
      provider: 'other',
      model: 'summarizer',
      usage: { inputTokens: 1_000_000, outputTokens: 100 },
    })

    expect(projected(ctx, session)).toEqual({
      'test/test-model': {
        uncachedInputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      'other/summarizer': {
        uncachedInputTokens: 1_000_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })
  })

  it('keeps a forked session’s inherited requests with the parent', async () => {
    const { ctx, session } = await harness()
    header(session, CONFIG)
    settlement(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)
    const child = ctx.sessions.fork(session)
    expect(projected(ctx, child)).toEqual({})

    header(child, OTHER)
    settlement(child, { inputTokens: 4, outputTokens: 1 }, 2, 1)

    expect(projected(ctx, child)).toEqual({
      'test/other-model': {
        uncachedInputTokens: 4,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })
    expect(projected(ctx, session)['test/test-model']!.uncachedInputTokens).toBe(10)
  })

  it('keeps a repeated header and settled attempts without usage from moving state', async () => {
    const { ctx, session } = await harness()
    header(session, CONFIG)
    settlement(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)
    const before = projected(ctx, session)
    header(session, CONFIG)
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 2,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })

    expect(projected(ctx, session)).toEqual(before)
  })
})
