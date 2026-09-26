import type { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')

/** The snapshot header `dsh-tool-memory` injects; its presence in a request is what run B asserts on. */
const CATALOG_HEADER = 'Saved memories (snapshot):'

function toolCall(id: string, name: string, args: object): StreamChunk[] {
  const encoded = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: encoded },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: encoded } },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function text(reply: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: reply },
    { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Keyless headless-agent adapter for the cross-session memory smoke. A task
 * starting with `remember:` writes one global memory; any other task recalls
 * `pnpm` when the request carries the injected snapshot and otherwise answers
 * `NO CATALOG`. A tool result is echoed back as the final answer.
 */
class MemoryMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolResult = options.messages.findLast(message => message.role === 'tool')
    if (toolResult !== undefined) {
      const toolText = toolResult.content.filter(block => block.type === 'text').map(block => block.text).join('')
      yield* text(`RESULT: ${toolText.trim()}`)
      return
    }
    const userTexts = options.messages
      .filter(message => message.role === 'user')
      .flatMap(message => message.content)
      .flatMap(block => (block.type === 'text' ? [block.text] : []))
    const task = userTexts.find(value => value.startsWith('remember:') || value.startsWith('recall:')) ?? ''
    if (task.startsWith('remember:')) {
      yield* toolCall('memory-smoke-write', 'memory_write', {
        name: 'prefers-pnpm',
        type: 'user',
        scope: 'global',
        description: 'Uses pnpm, never npm',
        content: 'Always run pnpm, never npm.',
      })
      return
    }
    if (userTexts.some(value => value.startsWith(CATALOG_HEADER))) {
      yield* toolCall('memory-smoke-recall', 'memory_recall', { query: 'pnpm' })
      return
    }
    yield* text('NO CATALOG')
  }
}

export const name = 'memory-mock-llm'
export const inject = ['llm']

/** Register the keyless `cli-mock` adapter used by the memory smoke. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cli-mock'], new MemoryMockAdapter())
}
