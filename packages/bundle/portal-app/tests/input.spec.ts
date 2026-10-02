/** Terminal editor behavior through the maintained Inquirer prompt runtime. */
import { PassThrough } from 'node:stream'
import { ExitPromptError } from '@inquirer/core'
import { render } from '@inquirer/testing'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import { readTerminalInput, terminalInputPrompt } from '../src/input.ts'

const config = { prompt: 'Message', history: [], columns: 72, color: false, ascii: false, exit: () => {} }

describe('Portal terminal input', () => {
  it('submits complete text and frames input without command help for ordinary tasks', async () => {
    const { answer, events, getScreen } = await render(terminalInputPrompt, config)
    events.type('  Explain 世界  ')
    expect(getScreen()).toContain('╭─ Message')
    expect(getScreen()).toContain('│   Explain 世界')
    expect(getScreen()).not.toContain('Choose a model')
    events.keypress('return')
    await expect(answer).resolves.toBe('  Explain 世界  ')
  })

  it('keeps Ctrl-J newlines in one submitted task', async () => {
    const { answer, events, input, getScreen } = await render(terminalInputPrompt, config)
    events.type('first line')
    input.write('\n')
    events.type('second line')
    expect(getScreen()).toContain('│ first line\n│ second line')
    events.keypress('return')
    await expect(answer).resolves.toBe('first line\nsecond line')
  })

  it('treats backslash-Enter as a newline and removes the escape character', async () => {
    const { answer, events } = await render(terminalInputPrompt, config)
    events.type('first\\')
    events.keypress('return')
    events.type('second')
    events.keypress('return')
    await expect(answer).resolves.toBe('first\nsecond')
  })

  it.each(['\n', '\r\n', '\r'])('preserves bracketed pasted %j newlines without submitting', async (newline) => {
    const { answer, events, input, getScreen, getFullOutput } = await render(terminalInputPrompt, config)
    input.write(`\u001b[200~one${newline}two\u001b[201~`)
    expect(getScreen()).toContain('│ one\n│ two')
    expect(getFullOutput()).toContain('\u001b[?2004h')
    events.type('!')
    events.keypress('return')
    await expect(answer).resolves.toBe('one\ntwo!')
    expect(getFullOutput()).toContain('\u001b[?2004l')
  })

  it('cycles matching slash completions and offers command descriptions only for slash input', async () => {
    const { answer, events, getScreen } = await render(terminalInputPrompt, config)
    events.type('/mo')
    expect(getScreen()).toContain('Choose a model')
    expect(getScreen()).toContain('Browse available models')
    events.keypress('tab')
    expect(getScreen()).toContain('│ /model\n')
    events.keypress('tab')
    expect(getScreen()).toContain('│ /models\n')
    events.keypress('return')
    await expect(answer).resolves.toBe('/models')
  })

  it('recalls multiline history and restores the draft on Down', async () => {
    const { answer, events, getScreen } = await render(terminalInputPrompt, { ...config, history: ['older', 'last\nprompt'] })
    events.type('draft')
    events.keypress('up')
    expect(getScreen()).toContain('│ last\n│ prompt')
    events.keypress('up')
    expect(getScreen()).toContain('│ older')
    events.keypress('down')
    events.keypress('down')
    expect(getScreen()).toContain('│ draft')
    events.keypress('return')
    await expect(answer).resolves.toBe('draft')
  })

  it('joins the preceding line when Backspace is pressed on an empty continuation', async () => {
    const { answer, events, input, getScreen } = await render(terminalInputPrompt, config)
    events.type('first')
    input.write('\n')
    events.keypress('backspace')
    expect(getScreen()).toContain('│ first')
    events.type('!')
    events.keypress('return')
    await expect(answer).resolves.toBe('first!')
  })

  it('clears a draft with Escape and returns an empty input on a second Escape', async () => {
    const { answer, events, getScreen } = await render(terminalInputPrompt, config)
    events.type('draft')
    events.keypress('escape')
    expect(getScreen()).not.toContain('draft')
    events.keypress('escape')
    await expect(answer).resolves.toBe('')
  })

  it('uses plain ASCII framing without enabling bracketed paste for a dumb terminal', async () => {
    const { answer, events, getScreen, getFullOutput } = await render(terminalInputPrompt, { ...config, ascii: true })
    expect(getScreen()).toContain('+- Message')
    expect(getScreen()).not.toContain('╭')
    expect(getFullOutput()).not.toContain('\u001b[?2004h')
    events.keypress('return')
    await expect(answer).resolves.toBe('')
  })

  it('measures the displayed prompt width when its label contains color codes', async () => {
    const { answer, events, getScreen } = await render(terminalInputPrompt, {
      ...config, prompt: '\u001b[36m›\u001b[0m', columns: 24, color: true,
    })
    const rows = getScreen().split('\n')
    expect(stringWidth(rows[0] ?? '')).toBe(24)
    expect(stringWidth(rows.at(-1) ?? '')).toBe(24)
    events.keypress('return')
    await expect(answer).resolves.toBe('')
  })

  it('rejects Ctrl-C through the core prompt lifecycle', async () => {
    const { answer, events } = await render(terminalInputPrompt, config)
    const rejected = expect(answer).rejects.toBeInstanceOf(ExitPromptError)
    events.keypress({ name: 'c', ctrl: true })
    await rejected
  })

  it('rejects EOF and removes terminal setup through the public reader', async () => {
    const input = new PassThrough()
    const output = Object.assign(new PassThrough(), { columns: 72, isTTY: false })
    let captured = ''
    output.on('data', (chunk: Buffer) => { captured += chunk.toString() })
    const answer = readTerminalInput({
      input,
      output,
      prompt: 'Message', history: [],
    })
    const rejected = expect(answer).rejects.toBeInstanceOf(ExitPromptError)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    input.end()
    await rejected
    expect(captured).toContain('\u001b[?25h')
    input.destroy()
    output.destroy()
  })
})
