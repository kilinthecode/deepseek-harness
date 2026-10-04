import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner, { PRUNE_MARKER } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Pressure compaction runs in `agent/pre-step`, after the previous step's tool
 * results are logged but before any request carries them. Through the real
 * loop, every tool result must reach the model in full at least once before
 * pressure pruning may shorten it.
 */

class StubSummaryEngine extends BasicCompactionEngine {
  override async summarize(): Promise<{ summary: ContentBlock[]; provider: string; model: string }> {
    return { summary: [{ type: 'text', text: 'S' }], provider: 'mock', model: 'stub' }
  }
}

/** Emits four tool calls, one per request, then a final text answer. */
class ToolStepAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 4_000 } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const n = this.requests.length
    this.requests.push(options)
    if (n < 4) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: ToolCallId(`c${n}`), name: 'work', arguments: `{"i":${n}}` },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('sends every tool result in full before pressure pruning shortens it', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new ToolStepAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'work',
    description: 'w',
    parameters: { i: { type: 'number' } },
    async execute() {
      return [{ type: 'text', text: `RESULT-HEAD ${'x'.repeat(3_000)} RESULT-TAIL` }]
    },
  }))
  await ctx.plugin(ToolResultPruner, { thresholdChars: 1_000, headChars: 200, tailChars: 100 })
  void new StubSummaryEngine(ctx, {
    auto: true,
    headroomTokens: 0,
    thresholdRatio: 0.5,
    retainTokens: 100,
    maxTokens: 100,
    compactionRetries: 1,
    pruneHeadroomRatio: 0,
  })
  const agent = await ctx.agentLoop.create(SessionId('pressure-prune-consumed'), { provider: 'mock', model: 'mock' })
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ status }) => {
      if (status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await idle

  // Classify each tool result by the request that first carried it.
  const seen = new Set<string>()
  const firstSightings: Array<{ callId: string; pruned: boolean }> = []
  let laterPruned = 0
  for (const request of adapter.requests) {
    for (const message of request.messages) {
      if (message.role !== 'tool') continue
      const text = message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
      const pruned = text.includes(PRUNE_MARKER)
      if (seen.has(message.toolCallId)) {
        if (pruned) laterPruned += 1
        continue
      }
      seen.add(message.toolCallId)
      firstSightings.push({ callId: message.toolCallId, pruned })
    }
  }

  expect(firstSightings.map(sighting => sighting.callId)).toEqual(['c0', 'c1', 'c2', 'c3'])
  expect(firstSightings.filter(sighting => sighting.pruned)).toEqual([])
  // Pressure did prune results the model had already received.
  expect(laterPruned).toBeGreaterThan(0)
  await ctx.fiber.dispose()
})
