/** Synchronous Portal choice selection on Inquirer's managed terminal screen. */
import { stripVTControlCharacters, styleText } from 'node:util'
import { createPrompt, ExitPromptError, useEffect, useKeypress, usePagination, useState } from '@inquirer/core'
import stringWidth from 'string-width'

interface Choice<T> {
  value: T
  name: string
  description?: string
}

interface PickerConfig<T> {
  message: string
  choices: readonly Choice<T>[]
  columns: number
  rows: number
  color: boolean
  ascii: boolean
  exit: () => void
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function fit(text: string, columns: number): string {
  const clean = stripVTControlCharacters(text).replaceAll(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
  let result = ''
  for (const { segment } of graphemes.segment(clean)) {
    if (stringWidth(result + segment) > columns) break
    result += segment
  }
  return result
}

function createChoicePrompt<T>(): ReturnType<typeof createPrompt<T | undefined, PickerConfig<T>>> {
  return createPrompt<T | undefined, PickerConfig<T>>((config, done) => {
    const [query, setQuery] = useState('')
    const [index, setIndex] = useState(0)
    const matches = config.choices.filter(choice => `${choice.name} ${choice.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    const selected = matches[index]

    useEffect((rl) => {
      const close = (): void => { config.exit() }
      rl.on('close', close)
      return () => { rl.removeListener('close', close) }
    }, [])

    useKeypress((key, rl) => {
      if (key.name === 'escape') { done(undefined); return }
      if (key.name === 'return' || key.name === 'enter') {
        if (selected !== undefined) done(selected.value)
        else { rl.clearLine(0); rl.write(query) }
      } else if (key.name === 'up' || key.name === 'down') {
        rl.clearLine(0)
        rl.write(query)
        setIndex(Math.max(0, Math.min(matches.length - 1, index + (key.name === 'up' ? -1 : 1))))
      } else if (key.name === 'tab') {
        rl.clearLine(0)
        rl.write(query)
      } else {
        setQuery(rl.line)
        setIndex(0)
      }
    })

    const paint = (color: 'magentaBright' | 'cyan' | 'dim', text: string): string =>
      config.color ? styleText(color, text, { validateStream: false }) : text
    const prefix = config.ascii ? '>' : '›'
    const pageSize = Math.max(1, Math.min(7, config.rows - 4))
    const page = usePagination({
      items: matches,
      active: index,
      pageSize,
      loop: false,
      renderItem: ({ item, isActive }) => {
        const row = `${isActive ? prefix : ' '} ${fit(item.name, Math.max(0, config.columns - 2))}`
        return isActive ? paint('cyan', row) : row
      },
    })
    const description = config.rows >= 5 && selected?.description !== undefined
      ? paint('dim', fit(selected.description, config.columns)) : ''
    const helpText = config.ascii ? 'Up/Down navigate | Enter select | Esc cancel' : '↑↓ navigate · Enter select · Esc cancel'
    const help = paint('dim', fit(helpText, config.columns))
    const header = paint('magentaBright', `${config.ascii ? '*' : '◇'} ${fit(config.message, Math.max(0, config.columns - 2))}`)
    return [`${header}\n${paint('cyan', prefix)} ${query}`, [
      page || paint('dim', 'No matching choices'), description, help,
    ].filter(Boolean).join('\n')]
  })
}

/**
 * Search a static choice list and select the currently displayed row.
 * Filtering is synchronous, including a typed query and Enter in one input burst.
 * Escape, Ctrl-C, and EOF cancel; an external abort rejects with AbortPromptError.
 * @param options - static choices, terminal streams, label, and optional lifetime signal.
 * @returns the selected value, or undefined after cancellation.
 */
export async function selectTerminalChoice<T>(options: {
  message: string
  choices: readonly { value: T; name: string; description?: string }[]
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
  signal?: AbortSignal
}): Promise<T | undefined> {
  const controller = new AbortController()
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
  const prompt = createChoicePrompt<T>()
  try {
    return await prompt({
      message: options.message, choices: options.choices,
      columns: options.output.columns, rows: options.output.rows,
      color: options.output.isTTY && process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb',
      ascii: process.env['TERM'] === 'dumb',
      exit: () => { controller.abort(new ExitPromptError('Terminal selection closed')) },
    }, { input: options.input, output: options.output, signal, clearPromptOnDone: true })
  } catch (error) {
    if (error instanceof ExitPromptError || controller.signal.reason instanceof ExitPromptError) return undefined
    throw error
  }
}
