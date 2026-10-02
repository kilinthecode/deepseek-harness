/** Pure, width-aware presentation for Portal's interactive terminal. */
import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'

/** Display capabilities resolved by the terminal's owner. */
export interface TerminalRendererOptions {
  /** Available columns; callers supply a finite positive value. */
  columns: number
  /** Whether generated text may contain ANSI color sequences. */
  color: boolean
  /** Whether terminal graphics use Unicode rather than ASCII. */
  unicode: boolean
  /** Whether welcome output includes terminal artwork and shortcuts. */
  interactive: boolean
}

/** Model route and optional reasoning choice displayed for the current turn. */
export interface TerminalSelection {
  /** Configured provider route id. */
  provider: string
  /** Model id within that route. */
  model: string
  /** Selected provider-owned reasoning effort, when explicit. */
  reasoningEffort?: string
}

/** Provider-reported token usage; absence means it was not reported. */
export interface TerminalUsage {
  /** Reported input tokens. */
  inputTokens: number
  /** Reported output tokens. */
  outputTokens: number
}

/** Current conversation facts supplied by the terminal controller. */
export interface TerminalState {
  /** Selected model route. */
  selection: TerminalSelection
  /** Working directory used by the conversation. */
  cwd: string
  /** Persisted Session identity, after creation or resume. */
  sessionId?: string
  /** Completed turns, when known. */
  turns?: number
  /** Reported usage, when known. */
  usage?: TerminalUsage
}

/** Advertised model metadata displayed without provider-specific rules. */
export interface TerminalModel {
  /** Model id accepted by the provider. */
  id: string
  /** Human-readable model name. */
  name: string
  /** Advertised input modalities; omitted when unknown. */
  inputModalities?: readonly string[]
  /** Advertised context capacity; omitted when unknown. */
  context?: { contextWindow: number }
  /** Advertised reasoning efforts; omitted when unknown. */
  reasoning?: { efforts: readonly { id: string }[] }
}

/** One configured route and its advertised models. */
export interface TerminalModelGroup {
  /** Configured provider route id. */
  id: string
  /** Human-readable provider name. */
  name: string
  /** Models in provider-preferred order. */
  models: readonly TerminalModel[]
}

/** Activity facts supplied from the Agent's own events. */
export interface TerminalActivity {
  /** Display category for the event. */
  phase: 'thinking' | 'tool' | 'done' | 'error'
  /** User-facing activity label. */
  label: string
}

/** Final facts for one terminal task. */
export interface TerminalSummary {
  /** Elapsed task time in milliseconds. */
  elapsedMs: number
  /** Task exit code; zero means completed. */
  code: number
  /** Session available for subsequent tasks, when creation succeeded. */
  sessionId?: string
  /** Complete provider-reported usage, when available. */
  usage?: TerminalUsage
}

/** Pure terminal strings; every method except prompt ends with a newline. */
export interface TerminalRenderer {
  /**
   * Render Portal's Tesseract welcome and initial conversation facts.
   * @param state - current selection, directory, and optional Session.
   * @returns a welcome block appropriate for the terminal width.
   */
  welcome(state: TerminalState): string
  /**
   * Render the conversation's current facts.
   * @param state - current conversation facts.
   * @returns a status block.
   */
  status(state: TerminalState): string
  /**
   * Render the input marker without a trailing newline.
   * @returns the readline prompt.
   */
  prompt(): string
  /**
   * Render available commands and keyboard shortcuts.
   * @returns terminal help.
   */
  help(): string
  /**
   * Render provider groups in numbered selection order.
   * @param groups - configured providers and their advertised models.
   * @param selection - route whose entry receives the current-model marker.
   * @returns the model menu.
   */
  models(groups: readonly TerminalModelGroup[], selection?: TerminalSelection): string
  /**
   * Render a readable notification.
   * @param kind - notification category.
   * @param text - notification text; terminal controls are removed.
   * @returns the notification.
   */
  notice(kind: 'success' | 'info' | 'warning' | 'error', text: string): string
  /**
   * Render one Agent activity event without cursor movement.
   * @param activity - activity category and label.
   * @returns an activity line or wrapped block.
   */
  activity(activity: TerminalActivity): string
  /**
   * Render a submitted user task in the conversation history.
   * @param text - submitted task, including pasted or inserted newlines.
   * @returns the labeled user message with terminal controls removed.
   */
  request(text: string): string
  /**
   * Render an assistant answer while preserving Markdown text and code lines.
   * @param text - answer text; terminal controls are removed.
   * @returns the labeled answer.
   */
  answer(text: string): string
  /**
   * Render completion, duration, and available usage and Session facts.
   * @param summary - outcome of the completed task.
   * @returns the task summary.
   */
  summary(summary: TerminalSummary): string
}

type Tone = 'plain' | 'heading' | 'accent' | 'violet' | 'muted' | 'success' | 'warning' | 'error'

const ANSI: Record<Tone, string> = {
  plain: '', heading: '\u001b[1m', accent: '\u001b[36m', violet: '\u001b[35m',
  muted: '\u001b[90m', success: '\u001b[32m', warning: '\u001b[33m', error: '\u001b[31m',
}
const SEGMENTS = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const COMMANDS = [
  ['/model [number | provider model]', 'Open the model picker; type to search'],
  ['/models [provider]', 'Browse configured models'],
  ['/reasoning [level]', 'Open the reasoning picker or choose a level'],
  ['/status', 'Show model, workspace, and conversation usage'],
  ['/session', 'Show the current session id'],
  ['/new', 'Start a fresh conversation'],
  ['/resume <id>', 'Continue a saved conversation'],
  ['/clear', 'Clear the terminal display'],
  ['/help', 'Show commands and keyboard shortcuts'],
  ['/exit', 'Close Portal'],
] as const
const SHORTCUTS = [
  'Ctrl-J  insert a newline', 'Tab  complete slash commands',
  'Up / Down  browse input history', 'Escape  cancel a running task',
] as const

function printable(value: string): string {
  return stripVTControlCharacters(value)
    .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
}

function field(value: string): string {
  return printable(value.replaceAll(/[\r\n\t\u2028\u2029]+/g, ' '))
}

function truncate(value: string, width: number, ellipsis: string): string {
  if (stringWidth(value) <= width) return value
  const available = width - stringWidth(ellipsis)
  let result = ''
  for (const { segment } of SEGMENTS.segment(value)) {
    if (stringWidth(result + segment) > available) break
    result += segment
  }
  return result + ellipsis
}

function wrap(value: string, width: number, replacement: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const { segment } of SEGMENTS.segment(value)) {
    if (stringWidth(line + segment) > width) {
      const space = line.lastIndexOf(' ')
      if (space > 0 && line.slice(0, space).trim() !== '') {
        lines.push(line.slice(0, space))
        line = line.slice(space + 1)
      }
      if (stringWidth(line + segment) > width) {
        if (line !== '') lines.push(line)
        line = ''
      }
    }
    if (stringWidth(segment) > width) {
      lines.push(replacement)
    } else {
      line += segment
    }
  }
  if (line !== '' || lines.length === 0) lines.push(line)
  return lines
}

function tokenLabel(usage: TerminalUsage): string {
  return `Tokens: ${String(usage.inputTokens)} in / ${String(usage.outputTokens)} out`
}

/**
 * Create a stateless renderer for a resolved terminal environment. External
 * text is sanitized; generated ANSI sequences affect color only.
 * @param options - width, color, character, and interaction capabilities.
 * @returns pure renderers with no stream writes or terminal state changes.
 */
export function createTerminalRenderer(options: TerminalRendererOptions): TerminalRenderer {
  const columns = Math.max(1, Math.floor(options.columns))
  const ellipsis = options.unicode ? '…' : '~'
  const separator = options.unicode ? '·' : '|'
  const symbols = options.unicode
    ? { model: '◇', current: '●', other: '○', tool: '▸', done: '✓', error: '!', thinking: '◌', prompt: '❯', mark: '▣' }
    : { model: '>', current: '*', other: '-', tool: '>', done: '+', error: '!', thinking: '.', prompt: '>', mark: '[+]' }
  const paint = (tone: Tone, value: string): string =>
    options.color && ANSI[tone] !== '' && value !== '' ? `${ANSI[tone]}${value}\u001b[0m` : value
  const block = (lines: readonly string[]): string => `${lines.join('\n')}\n`
  const line = (value: string, tone: Tone = 'plain'): string[] =>
    wrap(field(value), columns, ellipsis).map(part => paint(tone, part))
  const heading = (value: string): string[] => line(value, 'heading')
  const statusLines = (state: TerminalState): string[] => [
    ...line(`${symbols.model} Model: ${state.selection.provider}/${state.selection.model}`, 'accent'),
    ...line(`Reasoning: ${state.selection.reasoningEffort ?? 'provider default'}`, 'muted'),
    ...line(`Workspace: ${state.cwd}`, 'muted'),
    ...line(`Session: ${state.sessionId ?? 'new conversation'}`, 'muted'),
    ...state.turns === undefined ? [] : line(`Turns: ${String(state.turns)}`, 'muted'),
    ...state.usage === undefined ? [] : line(tokenLabel(state.usage), 'muted'),
  ]

  return {
    welcome(state) {
      const lines: string[] = []
      // Isometric wireframe from apps/desktop/resources/icon.svg.
      const logo = options.unicode ? [
        '      ⢀⣠⠴⢺⡗⠦⣄⡀      ',
        '  ⢀⣠⠴⠚⠉  ⢸⡇  ⠉⠓⠦⣄⡀  ',
        '⣴⣞⡉      ⢸⡇      ⢉⣳⣦',
        '⣿ ⠉⠳⢦⣄⣀⠤⠒⢹⡏⠒⠤⣀⣠⡴⠞⠋⠁⣿',
        '⣿    ⢸⡟⠳⢦⣼⣧⡴⠞⢻⡇    ⣿',
        '⣿    ⢸⣧⡴⠞⢻⡟⠳⢦⣼⡇    ⣿',
        '⣿ ⣀⡴⠞⠋⠉⠒⠤⣸⣇⠤⠒⠉⠙⠳⢦⣄⡀⣿',
        '⠻⢯⣁      ⢸⡇      ⣈⡽⠟',
        '  ⠈⠙⠲⢤⣀  ⢸⡇  ⣀⡤⠖⠋⠁  ',
        '      ⠈⠙⠲⢼⡧⠖⠋⠁      ',
      ] : [
        '         +         ',
        '      /  |  \\      ',
        '   /     |     \\   ',
        '+/       |       \\+',
        '|\\       +       /|',
        '| \\   + /|\\ +   / |',
        '|  \\  |X-+-X|  /  |',
        '| /   + \\|/ +   \\ |',
        '|/       +       \\|',
        '+\\       |       /+',
        '   \\     |     /   ',
        '      \\  |  /      ',
        '         +         ',
      ]
      const logoColumns = stringWidth(logo[0] ?? '')
      if (options.interactive && columns >= 72) {
        const beside = [
          'PORTAL', 'Your models. One terminal.', '',
          `Model: ${state.selection.provider}/${state.selection.model}`,
          `Reasoning: ${state.selection.reasoningEffort ?? 'provider default'}`,
          `Workspace: ${state.cwd}`, `Session: ${state.sessionId ?? 'new conversation'}`,
        ]
        const detailOffset = Math.floor((logo.length - beside.length) / 2)
        for (const [index, mark] of logo.entries()) {
          const detailIndex = index - detailOffset
          const value = truncate(field(beside[detailIndex] ?? ''), columns - logoColumns - 3, ellipsis)
          const details = value === '' ? '' : `   ${paint(detailIndex === 0 ? 'heading' : detailIndex === 3 ? 'accent' : 'muted', value)}`
          lines.push(`${paint('accent', details === '' ? mark.trimEnd() : mark)}${details}`)
        }
      } else {
        if (options.interactive && columns >= 36) lines.push(...logo.map(value => paint('accent', value.trimEnd())), '')
        lines.push(...heading(options.interactive && columns < 36 ? `${symbols.mark} PORTAL` : 'PORTAL'))
        lines.push(...line('Your models. One terminal.', 'muted'), '', ...statusLines(state))
      }
      if (options.interactive) {
        lines.push('', ...line(`/model  switch models  ${separator}  /help  commands`, 'muted'))
        lines.push(...line(`Ctrl-J  newline  ${separator}  Escape  cancel`, 'muted'))
      }
      return block(lines)
    },
    status(state) {
      return block([...heading(`${symbols.model} STATUS`), '', ...statusLines(state)])
    },
    prompt() {
      return paint('accent', columns >= 2 ? `${symbols.prompt} ` : symbols.prompt)
    },
    help() {
      const lines = [...heading('COMMANDS'), '']
      for (const [command, description] of COMMANDS) {
        if (columns >= 80) {
          lines.push(`${paint('accent', command.padEnd(36))}${paint('muted', truncate(description, columns - 36, ellipsis))}`)
        } else {
          lines.push(...line(command, 'accent'), ...line(`  ${description}`, 'muted'))
        }
      }
      lines.push('', ...heading('KEYBOARD'), ...SHORTCUTS.flatMap(value => line(value, 'muted')))
      return block(lines)
    },
    models(groups, selection) {
      const lines = [...heading(`${symbols.model} MODELS`), '']
      let number = 0
      for (const group of groups) {
        lines.push(...line(`${group.name} (${group.id})  ${separator}  ${String(group.models.length)} models`, 'heading'))
        if (group.models.length === 0) lines.push(...line('  No models advertised.', 'muted'))
        for (const model of group.models) {
          number += 1
          const current = selection?.provider === group.id && selection.model === model.id
          const marker = current ? symbols.current : symbols.other
          lines.push(...line(`  ${marker} ${String(number)}. ${model.name}${current ? '  [current]' : ''}`, current ? 'accent' : 'plain'))
          lines.push(...line(`     ${group.id}/${model.id}`, 'muted'))
          const capabilities: string[] = []
          if (model.inputModalities?.includes('image') === true) capabilities.push('image')
          if (model.reasoning !== undefined && model.reasoning.efforts.length > 0) capabilities.push('reasoning')
          if (model.context !== undefined) capabilities.push(`${String(model.context.contextWindow)} context`)
          if (capabilities.length > 0) lines.push(...line(`     [${capabilities.join('] [')}]`, 'muted'))
        }
        lines.push('')
      }
      if (groups.length === 0) lines.push(...line('No provider routes are configured.', 'muted'), '')
      lines.push(...line('/model <number>  or  /model <provider> <model>', 'muted'))
      return block(lines)
    },
    notice(kind, text) {
      const marker = kind === 'success' ? symbols.done : kind === 'info' ? symbols.model : '!'
      const tone = kind === 'info' ? 'accent' : kind
      return block(line(`${marker} ${text}`, tone))
    },
    activity(activity) {
      const marker = symbols[activity.phase === 'tool' ? 'tool' : activity.phase === 'done' ? 'done' : activity.phase === 'error' ? 'error' : 'thinking']
      const tone = activity.phase === 'done' ? 'success' : activity.phase === 'error' ? 'error' : 'muted'
      return block(line(`${marker} ${activity.label}`, tone))
    },
    request(text) {
      const paragraphs = printable(text.replaceAll(/\r\n?/g, '\n')).replaceAll('\t', '    ').split(/[\n\u2028\u2029]/)
      return block([...line(`${symbols.prompt} YOU`, 'accent'), '', ...paragraphs.flatMap(value => wrap(value, columns, ellipsis))])
    },
    answer(text) {
      const lines = [...heading(`${symbols.model} ASSISTANT`), '']
      let code = false
      const paragraphs = printable(text.replaceAll(/\r\n?/g, '\n')).replaceAll('\t', '    ').split(/[\n\u2028\u2029]/)
      for (const paragraph of paragraphs) {
        const fence = paragraph.trimStart().startsWith('```')
        const tone = code || fence ? 'muted' : /^#{1,6}\s/.test(paragraph) ? 'heading' : 'plain'
        lines.push(...wrap(paragraph, columns, ellipsis).map(value => paint(tone, value)))
        if (fence) code = !code
      }
      return block(lines)
    },
    summary(summary) {
      const success = summary.code === 0
      const duration = summary.elapsedMs < 1000 ? `${String(Math.round(summary.elapsedMs))} ms` : `${(summary.elapsedMs / 1000).toFixed(1)} s`
      return block([
        ...line(`${success ? symbols.done : symbols.error} ${success ? 'Completed' : `Stopped (${String(summary.code)})`}  ${separator}  ${duration}`, success ? 'success' : 'error'),
        ...summary.usage === undefined ? [] : line(tokenLabel(summary.usage), 'muted'),
        ...summary.sessionId === undefined ? [] : line(`Session: ${summary.sessionId}`, 'muted'),
      ])
    },
  }
}
