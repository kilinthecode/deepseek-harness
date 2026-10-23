import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

function text(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function* call(id, name, args) {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsText } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class TokenContextAdapter extends LlmAdapter {
  async * stream(options) {
    const instructions = options.messages.findIndex(message => message.source?.kind === 'agent-instructions')
    const task = options.messages.findIndex(message => message.source?.kind === 'user')
    if (instructions < 0 || instructions >= task) throw new Error('fresh instruction baseline must precede the task')
    const results = options.messages.filter(message => message.role === 'tool')
    const failure = results.find(message => message.isError)
    if (failure !== undefined) throw new Error(`tool failed: ${text(failure)}`)
    const ptc = options.tools.length === 1 && options.tools[0].name === 'run_code'
    if (ptc && results.length === 0) {
      yield* call('token-context-program', 'run_code', {
        description: 'Read two windows and save the extracted target',
        code: `const first = await tools.read({ file_path: 'large.txt' });
const second = await tools.read({ file_path: 'large.txt', offset: first.lines.length + 1, limit: 10 });
const target = second.lines.find(line => line.text.startsWith('target='));
await tools.write({ file_path: 'report.txt', content: first.lines.length + ':' + second.lines.length + ':' + target.text + '\\n' });
return { firstLines: first.lines.length, nextOffset: second.offset, tailLines: second.lines.length, target: target.text };`,
      })
      return
    }
    if (!ptc && results.length === 0) {
      yield* call('token-context-first', 'read', { file_path: 'large.txt' })
      return
    }
    if (!ptc && results.length === 1) {
      const first = text(results[0])
      if (!first.includes('Use offset=3 to continue.')) throw new Error('first read must advertise continuation')
      yield* call('token-context-tail', 'read', { file_path: 'large.txt', offset: 3, limit: 10 })
      return
    }
    if (!ptc && results.length === 2) {
      const firstLines = [...text(results[0]).matchAll(/^\d+: /gm)].length
      const tail = text(results[1])
      const tailLines = [...tail.matchAll(/^\d+: /gm)].length
      const target = tail.match(/^\d+: (target=[^\r\n]+)$/m)?.[1]
      if (target === undefined) throw new Error('explicit larger read must reach the target')
      yield* call('token-context-report', 'write', { file_path: 'report.txt', content: `${firstLines}:${tailLines}:${target}\n` })
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'TOKEN_CONTEXT_COMPLETE' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'token-context-llm'
export const inject = ['llm']
export function apply(ctx) {
  ctx.llm.registerAdapter(['token-context'], new TokenContextAdapter())
}
