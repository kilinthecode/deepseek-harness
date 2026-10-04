/**
 * Pins the pressure path's warm-prefix parity: `compactIfNeeded('pressure')`
 * must build the summarizer's request from the surface as it stood before any
 * prune landed, so the auxiliary call is a genuine prefix of the conversation
 * request and reuses the provider's KV cache for the summarized region. A
 * prune landed before compaction instead rewrites a tool-result node inside
 * that region, and the summary request diverges from the warm prefix at
 * exactly that node.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner, { PRUNE_MARKER } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'test-model'
/** Exceeds the pruner's `thresholdChars` (100) by roughly 27x. */
const OVERSIZED_TOOL_TEXT = 'result 1 '.repeat(300)

/**
 * Distinguishes the summarizer's own call by its trailing compaction
 * instruction (`COMPACTION_INSTRUCTION` in `summarizer.ts`), the same
 * signature `compaction-loop-repro.spec.ts`'s `OverflowRecoveryAdapter` uses.
 */
function isSummaryRequest(options: GenerateOptions): boolean {
  const trailing = options.messages.at(-1)?.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('') ?? ''
  return trailing.includes('acting as a compaction engine')
}

/** Captures every request without stubbing compaction: the real `summarizeWithLlm` path drives the summary call. */
class CapturingAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []

  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (isSummaryRequest(options)) {
      this.summaryRequests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CHECKPOINT SUMMARY' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.conversationRequests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ack' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Three closed turns, each a user message, an assistant tool call, a tool
 * result, and a model reply, followed by an open turn. Turn 1's tool result exceeds the pruner's
 * `thresholdChars`; the later turns' own oversized results accumulate enough
 * pressure that a prune-only preview cannot clear the default
 * `pruneHeadroomRatio` margin on its own (mirrors the equivalent fixture in
 * compaction-basic.spec.ts's "optional model-free tool-result pruning" suite).
 */
function toolConversation(): Session {
  const session = Session.create(SessionId('pressure-cache-reuse'))
  for (let turn = 1; turn <= 3; turn += 1) {
    const callId = ToolCallId(`call-${turn}`)
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `request ${turn} `.repeat(300) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `calling ${turn} `.repeat(300) },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
        ],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: turn === 1 ? OVERSIZED_TOOL_TEXT : `result ${turn} `.repeat(300) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('step/start', { turn, step: 2 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 2,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 2 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4 })
  return session
}

function agent(session: Session): Agent {
  return { session, options: {} } as Agent
}

describe('compaction-basic pressure: summarizer warm-prefix parity', () => {
  it('builds the summary request from the still-unpruned surface, matching the conversation request through the summarized region byte-for-byte', async () => {
    const ctx = new Context()
    const pruneConfig = { thresholdChars: 100, headChars: 20, tailChars: 10 }
    void new LlmRuntime(ctx)
    void new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    void new ToolResultPruner(ctx, pruneConfig)
    const adapter = new CapturingAdapter(2_000)
    ctx.llm.registerAdapter([MODEL], adapter)
    // Real BasicCompactionEngine, not a summarize()-overriding subclass: the
    // summary request below is produced by the real summarizeWithLlm call.
    const compact = new BasicCompactionEngine(ctx, {
      headroomTokens: 0,
      maxTokens: 8192,
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    })

    const session = toolConversation()

    // "The messages the harness would send": a real request for the exact,
    // still-unmodified surface, captured through the same fake adapter the
    // summarizer call below also runs through. `deriveMessages()` builds
    // exactly the array a loop-built GenerateOptions.messages carries
    // (dsh-llm's GenerateOptions.messages doc), so this is not a parallel
    // hand-rolled reconstruction of what the harness sends.
    for await (const _chunk of ctx.llm.stream({
      provider: MODEL,
      model: MODEL,
      messages: session.deriveMessages(),
      sessionId: session.id,
    })) { /* draining is enough: only the captured request matters here */ }
    expect(adapter.conversationRequests).toHaveLength(1)

    const result = await compact.compactIfNeeded(agent(session), 'pressure', new AbortController().signal)
    expect(result).not.toBeNull()
    expect(adapter.summaryRequests).toHaveLength(1)

    const conversationMessages = adapter.conversationRequests[0]!.messages
    const summaryMessages = adapter.summaryRequests[0]!.messages
    // summarizeWithLlm appends exactly one trailing compaction-instruction
    // user message after the replayed region (summarizer.ts COMPACTION_INSTRUCTION).
    const regionLength = summaryMessages.length - 1
    expect(regionLength).toBeGreaterThan(0)

    const summarizedPrefix = summaryMessages.slice(0, regionLength)
    const conversationPrefix = conversationMessages.slice(0, regionLength)
    expect(summarizedPrefix).toEqual(conversationPrefix)
    // toEqual is structural; also pin the literal serialized bytes the
    // provider would see, since a warm-prefix cache hit depends on exact text.
    expect(JSON.stringify(summarizedPrefix)).toBe(JSON.stringify(conversationPrefix))

    const sharedJson = JSON.stringify(summarizedPrefix)
    expect(sharedJson).toContain(OVERSIZED_TOOL_TEXT)
    expect(sharedJson).not.toContain(PRUNE_MARKER)
  })
})
