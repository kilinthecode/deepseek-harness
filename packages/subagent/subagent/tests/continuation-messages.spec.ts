import { describe, expect, it } from 'vitest'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSettlementMessage, withContinuableReturnGuidance } from '../src/continuation-messages.ts'

const childId = SessionId('settled-child')
const summary = { type: 'text', text: `Background subagent ${childId} finished and will do no further work unless you send it more.` }
const reasoning: ContentBlock = { type: 'reasoning', text: 'private child reasoning' }
const toolCall: ContentBlock = { type: 'tool-call', id: ToolCallId('child-call'), name: 'read', arguments: '{}' }

describe('continuable settlement content', () => {
  it.each([
    ['reasoning before the answer', [reasoning, { type: 'text', text: 'answer' }]],
    ['a tool call after the answer', [{ type: 'text', text: 'answer' }, toolCall]],
  ] satisfies [string, ContentBlock[]][])('reports only the closing text with %s', (_label, output) => {
    const original = structuredClone(output)
    const message = createSettlementMessage(childId, { stopReason: 'completed', output })

    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: 'answer' },
    ])
    expect(output).toEqual(original)
  })

  it.each([
    ['absent output', undefined],
    ['empty output', []],
    ['reasoning-only output', [reasoning]],
    ['empty text', [{ type: 'text', text: '' }]],
  ] satisfies [string, ContentBlock[] | undefined][])('reports no closing message for %s', (_label, output) => {
    const message = createSettlementMessage(childId, { stopReason: 'completed', ...output === undefined ? {} : { output } })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'It left no closing message.' },
    ])
  })

  it('preserves text block order and bytes around omitted reasoning and tool calls', () => {
    const first: ContentBlock = { type: 'text', text: '  first\n' }
    const second: ContentBlock = { type: 'text', text: '\n第二段  ' }
    const message = createSettlementMessage(childId, {
      stopReason: 'completed',
      output: [reasoning, first, toolCall, second],
    })

    expect(message.content).toEqual([
      summary,
      { type: 'text', text: 'Its closing message:' },
      first,
      second,
    ])
  })
})

describe('withContinuableReturnGuidance', () => {
  const parentId = SessionId('parent-1')
  const prompt: ContentBlock[] = [{ type: 'text', text: 'initial task' }]

  it('keeps the original prompt blocks untouched and appends exactly one guidance block', () => {
    const original = structuredClone(prompt)
    const withGuidance = withContinuableReturnGuidance(parentId, prompt, true)

    expect(withGuidance).toHaveLength(prompt.length + 1)
    expect(withGuidance.slice(0, prompt.length)).toEqual(original)
    expect(prompt).toEqual(original)
  })

  it('tells a shared-workspace child the parent shares its workspace, verbatim', () => {
    const [, guidance] = withContinuableReturnGuidance(parentId, prompt, true)

    expect(guidance).toEqual({
      type: 'text',
      text: 'Your parent agent id is "parent-1". Before you finish, send your result to that agent with '
        + 'send_message({ agent_id: "parent-1", message: "<self-contained result>" }). The parent shares your '
        + 'workspace but does not automatically receive your transcript, tool output, or reasoning. Send earlier '
        + 'messages as well when a finding changes what the parent should do next; sending a message does not end '
        + 'your turn.',
    })
  })

  it('tells a distinct-workspace child its parent cannot read its files and where to put its report, verbatim', () => {
    const [, guidance] = withContinuableReturnGuidance(parentId, prompt, false)

    expect(guidance).toEqual({
      type: 'text',
      text: 'Your parent agent id is "parent-1". Before you finish, send your result to that agent with '
        + 'send_message({ agent_id: "parent-1", message: "<self-contained result>" }). Your parent works in a '
        + 'different directory and cannot read your files; it does not automatically receive your transcript, tool '
        + 'output, or reasoning. Put your report — the commands you ran, their results, and anything you did not '
        + 'verify — in the send_message body. Send earlier messages as well when a finding changes what the parent '
        + 'should do next; sending a message does not end your turn.',
    })
  })
})
