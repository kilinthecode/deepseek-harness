/**
 * Real DeepSeek round trip: the pressure path must build the compaction
 * summarizer's request from the surface as it stood before any prune landed,
 * so the auxiliary call is a genuine prefix of the conversation's own request
 * and reuses DeepSeek's warm prefix cache for the summarized region. Master's
 * summarizer does not yet carry the conversation's routed reasoning effort
 * (that fix lives on another branch), and DeepSeek partitions its cache by
 * effort, so both calls here leave `reasoningEffort` unset everywhere and run
 * at the adapter's own default effort, landing in the same cache partition.
 *
 * Two real conversation requests warm the cache, not one: the oversized tool
 * result must itself have been part of a previously cached request before a
 * later divergence at that node (a prune landing first) can cost a
 * measurable cache-read shortfall. The first call only elicits the tool
 * call; the second sends the tool result back to the model, which is the
 * request DeepSeek actually caches that result under.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import * as Messages from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'
const MAX_TOKENS = 2048

/**
 * A real tool call, offered to the model rather than synthesized: DeepSeek's
 * thinking mode rejects a fabricated assistant tool-call block with no
 * reasoning content behind it, so the call in the built session below is
 * exactly what the model itself returned.
 */
const TOOL: ToolSchema = {
  name: 'lookup_value',
  description: 'Read the requested value. Always call this tool to obtain a value.',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
}

// A few thousand tokens of filler so the cached prefix clears any provider
// minimum; a fresh sentinel keeps this run's prefix unique so an unrelated
// run's cache entry cannot produce a false hit.
const filler = (sentinel: string): string =>
  `SENTINEL ${sentinel}\n`
  + 'Call lookup_value with key "context" exactly once. When you receive its result, '
  + 'reply with exactly ACK and nothing else. Do not call any tool a second time.\n'
  + 'The mission log records routine telemetry. '.repeat(400)

/** Bounds pressure well below the real model's actual context window. */
const DESIRED_THRESHOLD_TOKENS = 4_000
const RETAIN_TOKENS = 100

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('compaction-basic pressure cache reuse (real DeepSeek)', () => {
  it('reuses the conversation warm prefix in the pressure summarizer call', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LlmRuntime)
    // maxRetries: 0 keeps a transient failure from doubling real spend, matching
    // this suite's other real-API test (summarizer-cache-reuse.e2e.ts).
    await ctx.plugin(Messages, { maxTokens: MAX_TOKENS, retryPolicy: { mode: 'normal', maxRetries: 0 } })
    void new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    // The pruner only needs to be registered on ctx: compactIfNeeded looks it
    // up itself via ctx.get('toolResultPruner').
    void new ToolResultPruner(ctx, { thresholdChars: 100, headChars: 20, tailChars: 10 })

    const info = await ctx.llm.resolveModelInfo(PROVIDER, MODEL)
    const contextWindow = info.context?.contextWindow
    if (contextWindow === undefined) throw new Error('expected a resolved contextWindow for deepseek-v4-flash')
    const headroomTokens = contextWindow - MAX_TOKENS - DESIRED_THRESHOLD_TOKENS

    const session = Session.create(SessionId(`pressure-cache-${randomUUID()}`))
    const sentinel = randomUUID()
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: filler(sentinel) }],
      source: { kind: 'user' },
    })

    // Call 1: the conversation's opening request. Only needs to elicit a
    // real tool call (reasoningEffort left unset: adapter default).
    const firstAssembler = new BlockAssembler()
    const firstRequest: GenerateOptions = {
      provider: PROVIDER,
      model: MODEL,
      messages: [userMessage],
      tools: [TOOL],
      maxTokens: MAX_TOKENS,
      sessionId: session.id,
    }
    for await (const chunk of ctx.llm.stream(firstRequest)) firstAssembler.push(chunk)
    if (firstAssembler.finish.kind !== 'tool-calls') {
      throw new Error(`expected a real tool call from the model, got finish kind "${firstAssembler.finish.kind}"`)
    }
    const call = firstAssembler.blocks().find(
      (block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call',
    )
    if (call === undefined) throw new Error('model reported a tool-calls finish without a tool-call block')

    const firstAssistantMessage = createAssistantMessage({
      content: firstAssembler.blocks(),
      source: { provider: PROVIDER, model: MODEL },
    })
    // Oversized SYNTHETIC tool result: the pruner plans from the surface's
    // tool/result events, so this needs no real tool execution behind it.
    const toolResultMessage = createToolResultMessage({
      callId: call.id,
      content: [{ type: 'text', text: `LOOKUP_RESULT ${'oversized tool payload '.repeat(600)}` }],
      isError: false,
    })

    // Call 2: sends the tool result back for real. This is the request
    // DeepSeek actually caches the tool result's exact text under; only a
    // request that reproduces it verbatim can hit that cache entry later.
    const secondMessages: Message[] = [userMessage, firstAssistantMessage, toolResultMessage]
    const secondAssembler = new BlockAssembler()
    const secondRequest: GenerateOptions = {
      provider: PROVIDER,
      model: MODEL,
      messages: secondMessages,
      tools: [TOOL],
      maxTokens: MAX_TOKENS,
      sessionId: session.id,
    }
    for await (const chunk of ctx.llm.stream(secondRequest)) secondAssembler.push(chunk)
    if (secondAssembler.finish.kind !== 'stop') {
      throw new Error(`expected the model to stop after the tool result, got finish kind "${secondAssembler.finish.kind}"`)
    }
    // DeepSeek (Anthropic-shaped usage: see llm-deepseek/src/translate.ts)
    // reports inputTokens as the NOT-cached remainder, separately from
    // cacheReadTokens (served from a prior cache entry) and cacheWriteTokens
    // (newly written to cache by this call) — totalTokens sums all three.
    // The full prompt length this call actually sent is their sum, which is
    // the prefix length the summarizer's own request is expected to reuse.
    const secondUsage = secondAssembler.usage
    const conversationInputTokens = (secondUsage?.inputTokens ?? 0)
      + (secondUsage?.cacheReadTokens ?? 0)
      + (secondUsage?.cacheWriteTokens ?? 0)
    process.stdout.write(
      `pressure-cache-reuse: call2 usage inputTokens=${secondUsage?.inputTokens ?? 0}, `
      + `cacheReadTokens=${secondUsage?.cacheReadTokens ?? 0}, cacheWriteTokens=${secondUsage?.cacheWriteTokens ?? 0}, `
      + `derived full prompt length=${conversationInputTokens}\n`,
    )

    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMessage, { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: PROVIDER, model: MODEL, maxTokens: MAX_TOKENS }, tools: [TOOL] },
      reason: 'initial',
    })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: firstAssistantMessage,
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: toolResultMessage,
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 2,
      message: createAssistantMessage({ content: secondAssembler.blocks(), source: { provider: PROVIDER, model: MODEL } }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 2 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // More turns, appended directly with no further real calls (keeps spend
    // small): they give pressure enough margin that the oversized result
    // above lands inside the compacted region rather than the retained tail.
    for (let turn = 2; turn <= 3; turn += 1) {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `follow-up ${turn} `.repeat(200) }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn, step: 1 })
      session.append('assistant/message', {
        stream: [],
        turn,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: `reply ${turn} `.repeat(200) }],
          source: { provider: PROVIDER, model: MODEL },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    session.append('turn/start', { turn: 4 })

    const compact = new BasicCompactionEngine(ctx, {
      auto: false,
      headroomTokens,
      thresholdRatio: 1,
      retainTokens: RETAIN_TOKENS,
      maxTokens: MAX_TOKENS,
    })

    const agent = { session, options: {} } as Agent
    const result = await compact.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    expect(result).not.toBeNull()

    const summary = session.snapshotEvents().findLast(event => event.type === 'compaction/summary')
    if (summary?.type !== 'compaction/summary') throw new Error('missing compaction/summary event')
    const cacheReadTokens = summary.data.usage?.cacheReadTokens ?? 0
    // Printed before the assertion so the numbers are visible even when a
    // contrast run (prune landing before compaction) fails the check below.
    process.stdout.write(
      `pressure-cache-reuse: summary usage inputTokens=${summary.data.usage?.inputTokens ?? 0}, `
      + `cacheReadTokens=${cacheReadTokens}, cacheWriteTokens=${summary.data.usage?.cacheWriteTokens ?? 0}\n`
      + `pressure-cache-reuse: conversation (call2) full prompt length=${conversationInputTokens}, `
      + `summary cacheReadTokens=${cacheReadTokens} `
      + `(${conversationInputTokens > 0 ? Math.round((cacheReadTokens / conversationInputTokens) * 100) : 0}%)\n`,
    )
    expect(conversationInputTokens).toBeGreaterThan(0)
    // 80%, not the 60% a same-size prefix match alone would need: measured
    // runs land the fix around 99% and the pre-fix prune-before-compaction
    // order (moving prune.pruneSession back before this compaction loop)
    // around 66%, since that order's summary request only reuses the
    // conversation's opening message and misses the tool-result cache entry
    // call 2 established. 80% sits with wide margin on both sides.
    expect(cacheReadTokens).toBeGreaterThanOrEqual(Math.floor(conversationInputTokens * 0.8))
  })
})
