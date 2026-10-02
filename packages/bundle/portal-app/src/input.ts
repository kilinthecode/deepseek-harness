/** Framed Portal input using Inquirer's terminal editor and screen lifecycle. */
import { styleText } from 'node:util'
import { createPrompt, ExitPromptError, useEffect, useKeypress, useRef, useState } from '@inquirer/core'
import stringWidth from 'string-width'

const commands = [
  ['/model', 'Choose a model'],
  ['/models', 'Browse available models'],
  ['/reasoning', 'Set reasoning effort'],
  ['/status', 'Show current settings and usage'],
  ['/session', 'Show the current session'],
  ['/new', 'Start a new conversation'],
  ['/resume', 'Resume a saved conversation'],
  ['/clear', 'Clear the screen'],
  ['/help', 'Show commands and shortcuts'],
  ['/exit', 'Close Portal'],
] as const

interface InputConfig {
  prompt: string
  history: readonly string[]
  columns: number
  color: boolean
  ascii: boolean
  exit: () => void
}

interface Completion {
  prefix: string
  index: number
}

type InputPrompt = ReturnType<typeof createPrompt<string, InputConfig>>

/**
 * Render the input editor; prompt history is ordered oldest to newest.
 * @param config - terminal presentation and operation-owned exit callback.
 * @returns the complete submitted text, including embedded newlines.
 */
export const terminalInputPrompt: InputPrompt = createPrompt<string, InputConfig>((config, done) => {
  const [value, setValue] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(config.history.length)
  const draft = useRef('')
  const completion = useRef<Completion | undefined>(undefined)
  const pasting = useRef(false)
  const pastedReturn = useRef(false)

  useEffect((rl) => {
    const close = (): void => { config.exit() }
    rl.on('close', close)
    if (!config.ascii) {
      rl.output.unmute()
      rl.output.write('\u001b[?2004h')
      rl.output.mute()
    }
    return () => {
      rl.removeListener('close', close)
      if (!config.ascii) {
        rl.output.unmute()
        rl.output.write('\u001b[?2004l')
        rl.output.mute()
      }
    }
  }, [])

  useKeypress((key, rl) => {
    if (key.name === 'paste-start') { pasting.current = true; pastedReturn.current = false; return }
    if (key.name === 'paste-end') { pasting.current = false; return }
    const enter = key.name === 'return' || key.name === 'enter'
    const newline = key.name === 'enter' || (key.ctrl && key.name === 'j') || (enter && key.shift)
    if (enter || newline) {
      completion.current = undefined
      if (pasting.current && key.name === 'enter' && pastedReturn.current) {
        pastedReturn.current = false
        return
      }
      pastedReturn.current = pasting.current && key.name === 'return'
      if (pasting.current || newline || value.endsWith('\\')) {
        setLines([...lines, !pasting.current && !newline && value.endsWith('\\') ? value.slice(0, -1) : value])
        rl.clearLine(0)
        setValue('')
      } else {
        done([...lines, value].join('\n'))
      }
      return
    }
    pastedReturn.current = false
    if (pasting.current) { setValue(rl.line); return }
    if (key.name === 'tab' && lines.length === 0 && value.startsWith('/') && !/\s/.test(value)) {
      const prefix = completion.current?.prefix ?? value
      const matches = commands.filter(([command]) => command.startsWith(prefix))
      if (matches.length > 0) {
        const index = completion.current === undefined ? 0 : (completion.current.index + 1) % matches.length
        const next = matches[index]
        if (next !== undefined) {
          completion.current = { prefix, index }
          rl.clearLine(0)
          rl.write(next[0])
          setValue(next[0])
        }
      } else {
        rl.clearLine(0)
        rl.write(value)
      }
      return
    }
    completion.current = undefined
    if (key.name === 'up' || key.name === 'down') {
      if (historyIndex === config.history.length) draft.current = [...lines, value].join('\n')
      const index = Math.max(0, Math.min(config.history.length, historyIndex + (key.name === 'up' ? -1 : 1)))
      const text = index === config.history.length ? draft.current : config.history[index] ?? ''
      const recalled = text.split('\n')
      const current = recalled.pop() ?? ''
      rl.clearLine(0)
      rl.write(current)
      setLines(recalled)
      setValue(current)
      setHistoryIndex(index)
    } else if (key.name === 'escape') {
      if (value === '' && lines.length === 0) { done(''); return }
      rl.clearLine(0)
      setLines([])
      setValue('')
      setHistoryIndex(config.history.length)
    } else if (key.name === 'backspace' && value === '' && lines.length > 0) {
      const preceding = lines.at(-1) ?? ''
      rl.clearLine(0)
      rl.write(preceding)
      setLines(lines.slice(0, -1))
      setValue(preceding)
    } else {
      setValue(rl.line)
    }
  })

  const accent = (text: string): string => config.color ? styleText('magentaBright', text, { validateStream: false }) : text
  const cyan = (text: string): string => config.color ? styleText('cyan', text, { validateStream: false }) : text
  const muted = (text: string): string => config.color ? styleText('dim', text, { validateStream: false }) : text
  const edge = config.ascii ? '|' : '│'
  const rule = (config.ascii ? '-' : '─').repeat(Math.max(0, config.columns - stringWidth(config.prompt) - 4))
  const top = accent(`${config.ascii ? '+-' : '╭─'} ${config.prompt} ${rule}`)
  const bottom = accent(`${config.ascii ? '+' : '╰'}${(config.ascii ? '-' : '─').repeat(Math.max(0, config.columns - 1))}`)
  const content = [top, ...lines.map(line => `${cyan(edge)} ${line}`), `${cyan(edge)} ${value}`].join('\n')
  const query = value.split(/\s/, 1)[0] ?? ''
  const help = lines.length === 0 && value.startsWith('/')
    ? commands.filter(([command]) => command.startsWith(query)).map(([command, description]) => `${cyan(command.padEnd(12))} ${muted(description)}`).join('\n')
    : ''
  return [content, [bottom, help, help === '' ? '' : muted('Tab complete · Enter run · Esc clear')].filter(Boolean).join('\n')]
})

/**
 * Read one terminal task with multiline input, history, and slash completion.
 * Ctrl-J and backslash-Enter insert newlines; bracketed pasted newlines do not submit.
 * EOF and Ctrl-C reject with ExitPromptError; an external abort remains AbortPromptError.
 * @param options - terminal streams, prompt label, oldest-first history, and cancellation signal.
 * @returns the complete submitted task or an empty string for a cleared blank prompt.
 */
export async function readTerminalInput(options: {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream & Pick<NodeJS.WriteStream, 'columns' | 'isTTY'>
  prompt: string
  history: readonly string[]
  signal?: AbortSignal
}): Promise<string> {
  const controller = new AbortController()
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
  try {
    return await terminalInputPrompt({
      prompt: options.prompt,
      history: options.history,
      columns: options.output.columns,
      color: options.output.isTTY && process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb',
      ascii: process.env['TERM'] === 'dumb',
      exit: () => { controller.abort(new ExitPromptError('Terminal input closed')) },
    }, { input: options.input, output: options.output, signal, clearPromptOnDone: true })
  } catch (error) {
    if (controller.signal.reason instanceof ExitPromptError) throw controller.signal.reason
    throw error
  }
}
