/**
 * Deterministic keyless adapter for the two-process peer-session e2e.
 *
 * One plugin serves both roles; the profile patch selects the role and the
 * strings the two sessions exchange. Sender turns call the peer tools in a
 * fixed order, and target turns delegate one continuable subagent before they
 * answer, so the target process owns a child session whose mailbox the drain
 * must reject.
 */

import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

let nextCall = 0

/** Every tool the conversation already called, in transcript order. */
function calls(messages) {
  return messages.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call').map(block => block.name)
    : [])
}

/** One message's text blocks joined, so a wrapped prompt still matches by inclusion. */
function textOf(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** Every user-role message's text, which is where a delegated prompt appears. */
function userText(messages) {
  return messages.filter(message => message.role === 'user').map(textOf).join('\n')
}

function toolChunks(specs) {
  const chunks = []
  for (const [index, spec] of specs.entries()) {
    const id = ToolCallId(`peer-fixture-${++nextCall}`)
    const args = JSON.stringify(spec.args)
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: spec.name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: spec.name, arguments: args } },
    )
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Sender turns: list the peers, then send one message, then answer. */
function senderTurn(config, messages) {
  const names = calls(messages)
  if (!names.includes('list_peers')) return toolChunks([{ name: 'list_peers', args: {} }])
  if (!names.includes('send_peer_message')) {
    return toolChunks([{ name: 'send_peer_message', args: { to: config.target, message: config.body } }])
  }
  return textChunks('A_DONE')
}

/** Target turns: delegate once from the top-level session, and answer every other turn. */
function targetTurn(config, messages) {
  const text = userText(messages)
  if (text.includes(config.childPrompt)) return textChunks('B_CHILD_DONE')
  if (!text.includes(config.start)) return textChunks('B_DONE')
  if (!calls(messages).includes('subagent')) {
    return toolChunks([{
      name: 'subagent',
      args: { description: 'Peer mailbox probe', prompt: config.childPrompt, run_in_background: true },
    }])
  }
  return textChunks('B_DONE')
}

class PeerSessionFixtureAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
  }

  async * stream(options) {
    const chunks = this.config.role === 'a'
      ? senderTurn(this.config, options.messages)
      : targetTurn(this.config, options.messages)
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** Cordis plugin name. */
export const name = 'peer-session-fixture-llm'
/** LLM registry dependency. */
export const inject = ['llm']

/** Register the keyless adapter on the shipped default provider route. */
export function apply(ctx, config) {
  ctx.llm.registerAdapter(['deepseek-official'], new PeerSessionFixtureAdapter(config))
}
