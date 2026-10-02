/** Readable Portal presentation across terminal widths and character capabilities. */
import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import { createTerminalRenderer, type TerminalModelGroup, type TerminalState } from '../src/presentation.ts'

const state: TerminalState = {
  selection: { provider: 'local', model: 'reasoning-model', reasoningEffort: 'high' },
  cwd: '/work/portal', sessionId: 'session-42', turns: 2,
  usage: { inputTokens: 120, outputTokens: 24 },
}
const groups: TerminalModelGroup[] = [{
  id: 'local', name: 'Local models', models: [
    { id: 'reasoning-model', name: 'Reasoning model', inputModalities: ['text', 'image'], context: { contextWindow: 128000 }, reasoning: { efforts: [{ id: 'high' }] } },
    { id: 'text-model', name: 'Text model', inputModalities: ['text'] },
  ],
}]

function renderer(columns = 100, overrides: { color?: boolean; unicode?: boolean; interactive?: boolean } = {}) {
  return createTerminalRenderer({ columns, color: false, unicode: true, interactive: true, ...overrides })
}

function expectFits(text: string, columns: number): void {
  for (const line of text.split('\n')) expect(stringWidth(line), line).toBeLessThanOrEqual(columns)
}

describe('Portal terminal presentation', () => {
  it('places the app logo outline beside the active model and workspace on a wide terminal', () => {
    expect(renderer().welcome(state)).toMatchInlineSnapshot(`
      "      ⢀⣠⠴⢺⡗⠦⣄⡀
        ⢀⣠⠴⠚⠉  ⢸⡇  ⠉⠓⠦⣄⡀     PORTAL
      ⣴⣞⡉      ⢸⡇      ⢉⣳⣦   Your models. One terminal.
      ⣿ ⠉⠳⢦⣄⣀⠤⠒⢹⡏⠒⠤⣀⣠⡴⠞⠋⠁⣿
      ⣿    ⢸⡟⠳⢦⣼⣧⡴⠞⢻⡇    ⣿   Model: local/reasoning-model
      ⣿    ⢸⣧⡴⠞⢻⡟⠳⢦⣼⡇    ⣿   Reasoning: high
      ⣿ ⣀⡴⠞⠋⠉⠒⠤⣸⣇⠤⠒⠉⠙⠳⢦⣄⡀⣿   Workspace: /work/portal
      ⠻⢯⣁      ⢸⡇      ⣈⡽⠟   Session: session-42
        ⠈⠙⠲⢤⣀  ⢸⡇  ⣀⡤⠖⠋⠁
            ⠈⠙⠲⢼⡧⠖⠋⠁

      /model  switch models  ·  /help  commands
      Ctrl-J  newline  ·  Escape  cancel
      "
    `)
  })

  it('stacks artwork above the conversation facts on a medium terminal', () => {
    const text = renderer(60).welcome(state)
    expect(text).toContain('      ⠈⠙⠲⢼⡧⠖⠋⠁\n\nPORTAL\n')
    expect(text).toContain('◇ Model: local/reasoning-model')
    expect(text).toContain('Session: session-42')
    expectFits(text, 60)
  })

  it('uses a compact mark and wrapped facts on a narrow terminal', () => {
    const text = renderer(24).welcome(state)
    expect(text).toContain('▣ PORTAL')
    expect(text).not.toContain('      ⢀⣠⠴⢺⡗⠦⣄⡀')
    expectFits(text, 24)
  })

  it('keeps pipe-driven conversations readable without large artwork or shortcut decorations', () => {
    const text = renderer(80, { interactive: false }).welcome({ selection: state.selection, cwd: state.cwd })
    expect(text).toContain('PORTAL\nYour models. One terminal.')
    expect(text).toContain('Session: new conversation')
    expect(text).not.toContain('      ⢀⣠⠴⢺⡗⠦⣄⡀')
    expect(text).not.toContain('Escape')
    expect(text).not.toContain('\u001b')
  })

  it('keeps the app outline readable in an ASCII terminal without color', () => {
    const text = renderer(100, { unicode: false }).welcome(state)
    expect(text).toContain('+/       |       \\+   PORTAL')
    expect(text).toContain('|  \\  |X-+-X|  /  |')
    expect(text).toContain('+\\       |       /+')
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('╭')
    expect(text).toMatch(/^[\x20-\x7e\n]*$/)
  })

  it('adds only ANSI color and emphasis when color is enabled', () => {
    const styled = renderer(100, { color: true }).welcome(state)
    expect(styled).toContain('\u001b[36m')
    expect(styled).toContain('\u001b[1m')
    expect(stripVTControlCharacters(styled)).toBe(renderer().welcome(state))
    expect(styled).not.toContain('\u001b[2J')
    expect(styled).not.toContain('\u001b[H')
    expectFits(styled, 100)
  })

  it.each([100, 60, 24, 1])('fits all rendered blocks into %i columns', (columns) => {
    const view = renderer(columns, { color: true })
    const outputs = [
      view.welcome(state), view.status(state), view.help(), view.models(groups, state.selection),
      view.notice('success', 'Model selected'), view.notice('info', 'Saved conversation loaded'),
      view.notice('warning', 'Provider did not report token usage'), view.notice('error', 'Request failed'),
      view.activity({ phase: 'thinking', label: 'Thinking about the task' }),
      view.activity({ phase: 'tool', label: 'Reading the selected file' }),
      view.activity({ phase: 'done', label: 'File read' }), view.activity({ phase: 'error', label: 'Tool failed' }),
      view.answer('# Results\n\nAn answer with several words and a code sample.\n```ts\nconst message = "hello"\n```'),
      view.summary({
        code: 0, elapsedMs: 1250,
        ...state.sessionId === undefined ? {} : { sessionId: state.sessionId },
        ...state.usage === undefined ? {} : { usage: state.usage },
      }),
      view.summary({ code: 130, elapsedMs: 123 }), view.prompt(),
    ]
    for (const output of outputs) expectFits(output, columns)
  })

  it('shows the current model, global selection numbers, and only advertised capabilities', () => {
    const text = renderer().models([...groups, { id: 'remote', name: 'Remote models', models: [{ id: 'unreported', name: 'Unreported' }] }], state.selection)
    expect(text).toContain('● 1. Reasoning model  [current]')
    expect(text).toContain('[image] [reasoning] [128000 context]')
    expect(text).toContain('○ 2. Text model')
    expect(text).toContain('○ 3. Unreported')
    expect(text.split('○ 3. Unreported')[1]).not.toContain('[image]')
    expect(text).toContain('/model <number>  or  /model <provider> <model>')
  })

  it('explains empty provider and model catalogs', () => {
    expect(renderer().models([])).toContain('No provider routes are configured.')
    expect(renderer().models([{ id: 'local', name: 'Local models', models: [] }])).toContain('No models advertised.')
  })

  it('displays status and completion facts without inventing missing usage', () => {
    const status = renderer().status(state)
    expect(status).toContain('Reasoning: high')
    expect(status).toContain('Turns: 2')
    expect(status).toContain('Tokens: 120 in / 24 out')
    const minimal = renderer().status({ selection: { provider: 'route', model: 'model' }, cwd: '/work' })
    expect(minimal).toContain('Reasoning: provider default')
    expect(minimal).not.toContain('Tokens:')
    expect(renderer().summary({ code: 0, elapsedMs: 12 })).toBe('✓ Completed  ·  12 ms\n')
    expect(renderer().summary({ code: 1, elapsedMs: 1250 })).toBe('! Stopped (1)  ·  1.3 s\n')
  })

  it('includes every command and the keyboard features in help', () => {
    const text = renderer().help()
    for (const command of ['/model', '/models', '/reasoning', '/status', '/session', '/new', '/resume <id>', '/clear', '/help', '/exit']) expect(text).toContain(command)
    for (const shortcut of ['Ctrl-J', 'Tab', 'Up / Down', 'Escape']) expect(text).toContain(shortcut)
    expect(text).toContain('type to search')
    expect(text).toContain('reasoning picker')
    expect(renderer().prompt()).toBe('❯ ')
    expect(renderer(1).prompt()).toBe('❯')
    expect(renderer(80, { unicode: false }).prompt()).toBe('> ')
  })

  it('sanitizes provider, model, directory, activity, and answer control sequences', () => {
    const unsafe = '\u001b[2J\u001b[H\u001b]52;c;c2VjcmV0\u0007visible\b\u0000\u202e'
    const view = renderer()
    const outputs = [
      view.welcome({ selection: { provider: unsafe, model: unsafe }, cwd: unsafe, sessionId: unsafe }),
      view.models([{ id: unsafe, name: unsafe, models: [{ id: unsafe, name: unsafe }] }]),
      view.notice('error', unsafe), view.activity({ phase: 'tool', label: unsafe }),
      view.answer(`${unsafe}\r\nnext\tcolumn`), view.summary({ code: 0, elapsedMs: 1, sessionId: unsafe }),
    ]
    for (const output of outputs) {
      expect(output).toContain('visible')
      expect(output).not.toContain('\u001b')
      expect(output).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/)
      expect(output).not.toContain('c2VjcmV0')
    }
  })

  it('wraps CJK, combining marks, and emoji as intact graphemes', () => {
    const view = renderer(12)
    const text = view.answer('漢字漢字漢字漢字 e\u0301e\u0301e\u0301 👩🏽‍💻👩🏽‍💻👩🏽‍💻')
    expectFits(text, 12)
    expect(text).toContain('👩🏽‍💻')
    expect(text).toContain('e\u0301')
    const body = text.split('\n').slice(2)
    for (const line of body) {
      expect(line).not.toMatch(/^[\u0301\u200d\u{1f3fd}]/u)
      expect(line).not.toMatch(/\u200d$/u)
    }
    expectFits(renderer(1).answer('漢👩🏽‍💻'), 1)
  })

  it('truncates wide welcome metadata without splitting graphemes', () => {
    const text = renderer(72).welcome({
      selection: { provider: 'route', model: '漢字'.repeat(40) },
      cwd: `/work/${'👩🏽‍💻'.repeat(40)}`,
    })
    expect(text).toContain('…')
    expectFits(text, 72)
    expect(text).not.toMatch(/\u200d…/u)
  })

  it('preserves answer Markdown, indentation, and intentional blank lines', () => {
    const text = '# Results\n\n```ts\n    return 1\n```\n\n- done'
    expect(renderer().answer(text)).toBe(`◇ ASSISTANT\n\n${text}\n`)
    expect(renderer().answer('')).toBe('◇ ASSISTANT\n\n\n')
  })

  it('records the welcome, model cards, and conversation presentation', async () => {
    const view = renderer(96)
    const transcript = [
      view.welcome(state), view.models(groups, state.selection),
      view.request('Check the changes\nand explain the result.'),
      view.activity({ phase: 'tool', label: 'read_file · src/app.ts' }),
      view.activity({ phase: 'done', label: 'read_file · completed' }),
      view.answer('# Results\n\nThe changes are ready.\n\n```ts\nconst ready = true\n```'),
      view.summary({
        code: 0, elapsedMs: 1250,
        ...state.sessionId === undefined ? {} : { sessionId: state.sessionId },
        ...state.usage === undefined ? {} : { usage: state.usage },
      }),
    ].join('\n')
    await expect(transcript).toMatchFileSnapshot('./expected/terminal.txt')
    expectFits(view.request('漢字 👩🏽‍💻'.repeat(20)), 96)
    expect(view.request('\u001b[2Jvisible')).not.toContain('\u001b')
  })
})
