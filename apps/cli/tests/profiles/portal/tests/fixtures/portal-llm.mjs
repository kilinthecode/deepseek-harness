import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { setTimeout as delay } from 'node:timers/promises'

class Adapter extends LlmAdapter {
  async listModels(provider) {
    return ['first', 'second'].map(id => ({ provider, id, name: id }))
  }
  async resolveModel(provider, model) {
    if (!['first', 'second'].includes(model)) throw new LlmError(`unknown model ${model}`, 'UNSUPPORTED_MODEL')
    return { provider, id: model, name: model, reasoning: { efforts: [
      { id: ReasoningEffortId('high'), name: 'High' },
      { id: ReasoningEffortId('off'), name: 'Off' },
    ] } }
  }
  async * stream(options) {
    const prompt = options.messages.findLast(message => message.role === 'user')
    if (prompt?.content.some(block => block.type === 'text' && block.text === 'wait')) {
      await delay(60_000, undefined, { signal: options.signal })
    }
    const turns = options.messages.filter(message => message.role === 'user' && message.content.some(block => block.type === 'text' && ['hello', 'continue'].includes(block.text))).length
    const text = `PORTAL_OK ${options.provider}/${options.model} ${options.reasoningEffort ?? 'default'} turn=${turns}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const inject = ['llm']
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['portal-test'], new Adapter()))
}
