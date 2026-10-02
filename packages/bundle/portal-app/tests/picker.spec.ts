/** Static-choice selection, including same-burst query and Enter, on the real prompt runtime. */
import { AbortPromptError } from '@inquirer/core'
import { render } from '@inquirer/testing'
import type { createPrompt } from '@inquirer/core'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectTerminalChoice } from '../src/picker.ts'

interface TestConfig {
  message: string
  choices: { value: string; name: string; description?: string }[]
  columns?: number
  rows?: number
  isTTY?: boolean
}

type PromptContext = Parameters<ReturnType<typeof createPrompt<string | undefined, TestConfig>>>[1]

function prompt(config: TestConfig, context: PromptContext): Promise<string | undefined> {
  const input = context?.input ?? process.stdin
  const output = context?.output ?? process.stdout
  Object.assign(output, { columns: config.columns ?? 72, rows: config.rows ?? 24, isTTY: config.isTTY ?? false })
  return selectTerminalChoice({
    message: config.message, choices: config.choices,
    input: input as NodeJS.ReadStream, output: output as NodeJS.WriteStream,
    ...context?.signal === undefined ? {} : { signal: context.signal },
  })
}

const config: TestConfig = {
  message: 'Choose a model',
  choices: [{ value: 'first-id', name: 'first model' }, { value: 'second-id', name: 'second model' }],
}

afterEach(() => { vi.unstubAllEnvs() })

describe('Portal terminal choice picker', () => {
  it('selects the filtered model when query and Enter arrive in one input burst', async () => {
    const { answer, input } = await render(prompt, config)
    input.write('second\r')
    await expect(answer).resolves.toBe('second-id')
  })

  it('selects the filtered model even when the previous row was changed before typing', async () => {
    const { answer, input, events } = await render(prompt, config)
    events.keypress('down')
    input.write('first\r')
    await expect(answer).resolves.toBe('first-id')
  })

  it('keeps an unmatched query editable and does not submit a stale choice', async () => {
    const { answer, input, events, getScreen } = await render(prompt, config)
    input.write('unavailable\r')
    expect(getScreen()).toContain('No matching choices')
    expect(getScreen()).toContain('unavailable')
    events.keypress('escape')
    await expect(answer).resolves.toBeUndefined()
  })

  it('navigates visible rows with arrows while preserving its query', async () => {
    const { answer, events, getScreen } = await render(prompt, config)
    events.type('model')
    events.keypress('down')
    expect(getScreen()).toMatch(/[›>] second model/)
    events.keypress('up')
    expect(getScreen()).toMatch(/[›>] first model/)
    events.keypress('down')
    events.keypress('return')
    await expect(answer).resolves.toBe('second-id')
  })

  it.each(['escape', 'ctrl-c', 'eof'])('cancels and restores the cursor after %s', async (method) => {
    const { answer, input, events, getFullOutput } = await render(prompt, config)
    if (method === 'escape') events.keypress('escape')
    else if (method === 'ctrl-c') events.keypress({ name: 'c', ctrl: true })
    else input.end()
    await expect(answer).resolves.toBeUndefined()
    expect(getFullOutput()).toContain('\u001b[?25h')
  })

  it('preserves external lifetime cancellation as a rejection', async () => {
    const controller = new AbortController()
    const { answer } = await render(prompt, config, { signal: controller.signal })
    const rejected = expect(answer).rejects.toBeInstanceOf(AbortPromptError)
    controller.abort()
    await rejected
  })

  it('limits rows and fits labels in a narrow terminal without printing the whole catalog', async () => {
    const { answer, events, getScreen } = await render(prompt, {
      ...config, columns: 24, rows: 8,
      choices: Array.from({ length: 30 }, (_value, index) => ({ value: String(index), name: `Model ${String(index)} · ${'世界'.repeat(12)}` })),
    })
    const screen = getScreen()
    const lines = screen.split('\n')
    expect(lines.length).toBeLessThanOrEqual(8)
    expect(lines.every(line => stringWidth(line) <= 24)).toBe(true)
    expect(screen).not.toContain('Model 29')
    events.keypress('escape')
    await expect(answer).resolves.toBeUndefined()
  })

  it('disables color when NO_COLOR is present despite a TTY output', async () => {
    vi.stubEnv('NO_COLOR', '1')
    vi.stubEnv('TERM', 'xterm-256color')
    const { answer, events, getScreen } = await render(prompt, { ...config, isTTY: true })
    expect(getScreen({ raw: true })).not.toMatch(/\u001b\[\d+(?:;\d+)*m/)
    events.keypress('escape')
    await expect(answer).resolves.toBeUndefined()
  })
})
