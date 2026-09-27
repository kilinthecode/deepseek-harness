/**
 * Real DeepSeek round trip: DeepSeek partitions its prefix cache by thinking
 * effort, so the cache-reusing summarizer (`summarizeWithLlm`) only reuses a
 * conversation's warm prefix when its call carries the same routed effort.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, ReasoningEffortId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Messages from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'
// Differs from the adapter's unconfigured default ('high'); DeepSeek's KV
// cache is partitioned by this value, so a summarizer call that drops it
// falls back to 'high' and misses the conversation's cache entirely.
const EFFORT = ReasoningEffortId('max')
// A few thousand tokens so the cached prefix clears any provider minimum;
// DeepSeek caches in 128-token units. A fresh sentinel keeps this run's
// prefix unique so an unrelated run's cache entry cannot produce a false hit.
const filler = (sentinel: string): string =>
  `SENTINEL ${sentinel}\n${'The mission log records routine telemetry. '.repeat(400)}`

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('compaction-basic summarizer cache reuse (real DeepSeek)', () => {
  it('reuses the routed conversation effort so the compaction summarizer hits the warm prefix cache', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    // maxRetries: 0 keeps a transient failure from doubling real spend; the
    // suite's other real-API tests disable retries the same way.
    await ctx.plugin(Messages, { maxTokens: 2048, retryPolicy: { mode: 'normal', maxRetries: 0 } })
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    const compact = new BasicCompactionEngine(ctx, { auto: false, maxTokens: 2048 })

    const session = Session.create(SessionId(`summarizer-cache-${randomUUID()}`))
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: `${filler(randomUUID())}\nReply with exactly PONG and nothing else.` }],
      source: { kind: 'user' },
    })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMessage, { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT } },
      reason: 'initial',
    })

    // The conversation's own request: this is the call DeepSeek caches.
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT, maxTokens: 2048, messages: [userMessage],
    })) assembler.push(chunk)
    expect(assembler.finish.kind).toBe('stop')

    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({ content: assembler.blocks(), source: { provider: PROVIDER, model: MODEL } }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })

    const [start, end] = session.surface.nodes
    const agent = { session, options: {} } as Agent
    await compact.compactRegion(start!, end!, agent)

    const summary = session.snapshotEvents().findLast(event => event.type === 'compaction/summary')
    if (summary?.type !== 'compaction/summary') throw new Error('missing compaction/summary event')
    const cacheReadTokens = summary.data.usage?.cacheReadTokens ?? 0
    process.stdout.write(`summarizer cache read at routed effort "${EFFORT}": ${cacheReadTokens}\n`)
    expect(cacheReadTokens).toBeGreaterThan(0)
  })
})
