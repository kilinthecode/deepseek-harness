/** Portal terminal controls and committed Agent activity presentation. */
import { createInterface, emitKeypressEvents } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'
import { AbortPromptError, ExitPromptError } from '@inquirer/core'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  apply as runHeadless, Config as HeadlessSchema, createTaskRunner,
  type Config as HeadlessConfig, type RunEvent,
} from '@deepseek-ai/dsh-headless'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { readTerminalInput } from './input.ts'
import { selectTerminalChoice } from './picker.ts'
import { createTerminalRenderer, type TerminalSelection, type TerminalUsage } from './presentation.ts'

/** Stable runner plugin name. */
export const name = 'portal-runner'
/** Core services required before opening the terminal. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'llm']

/** Portal task options with terminal conversation mode. */
export interface Config extends HeadlessConfig {
  /** Whether to open the interactive prompt; defaults to one-shot mode. */
  interactive?: boolean
  /** Whether startup is performing discovery without submitting a task. */
  discovery?: boolean
}
/** Schema shared with the one-shot runner. */
export const Config: z<Config> = z.intersect([HeadlessSchema, z.object({ interactive: z.boolean(), discovery: z.boolean() })])

/** Terminal streams; tests supply a controlled input and capture output. */
export const internals = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }

function active(ctx: Context): boolean { return ctx.fiber.state === FiberState.ACTIVE }

function label(text: string): string {
  return stripVTControlCharacters(text).replaceAll(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
}

function preview(text: string): string {
  const first = label(text.split(/[\r\n]/, 1)[0] ?? '').trim()
  if (first === '' || first === '{}') return ''
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(first), value => value.segment)
  const width = internals.stdout.columns || 80
  return ` · ${segments.slice(0, width).join('')}${segments.length > width ? '…' : ''}`
}

/** Own raw input only while the Agent runs; Inquirer owns it while prompting. */
function interruptKeys(cancel: () => void): () => void {
  const input = internals.stdin
  const wasRaw = input.isRaw
  const wasPaused = input.isPaused()
  emitKeypressEvents(input)
  const onKey = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
    if (key.name === 'escape' || (key.ctrl === true && key.name === 'c')) cancel()
  }
  input.on('keypress', onKey)
  input.setRawMode(true)
  input.resume()
  return () => {
    input.removeListener('keypress', onKey)
    input.setRawMode(wasRaw)
    if (wasPaused) input.pause()
  }
}

async function interactive(ctx: Context, config: Config): Promise<void> {
  await ctx.get('loader')?.await()
  if (!active(ctx)) return
  const terminal = internals.stdin.isTTY && internals.stdout.isTTY && process.env.TERM !== 'dumb'
  const renderer = (): ReturnType<typeof createTerminalRenderer> => createTerminalRenderer({
    columns: internals.stdout.columns || 80,
    color: terminal && process.env.NO_COLOR === undefined,
    unicode: process.env.TERM !== 'dumb', interactive: terminal,
  })
  const out = (text: string): void => { if (active(ctx)) internals.stdout.write(text) }
  const fs = ctx.get('fs')
  let cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
  if (!active(ctx)) return
  const defaults = ctx.agentDefaultModel.currentSelection()
  const provider = config.modelSelection?.provider ?? defaults.provider
  const model = config.modelSelection?.model ?? defaults.model
  const effort = config.modelSelection?.reasoningEffort
    ?? (provider === defaults.provider && model === defaults.model ? defaults.reasoningEffort : undefined)
  let selection: TerminalSelection = { provider, model, ...effort === undefined ? {} : { reasoningEffort: effort } }
  let sessionId = config.sessionId
  let turns: number | undefined
  let usage: TerminalUsage | undefined
  let completeUsage = true
  let renderedText = false
  let lastText = ''
  let modelMenu: TerminalSelection[] | undefined
  const calls = new Map<ToolCallId, string>()
  const state = (): Parameters<ReturnType<typeof createTerminalRenderer>['status']>[0] => ({
    selection, cwd, ...sessionId === undefined ? {} : { sessionId },
    ...turns === undefined ? {} : { turns }, ...usage === undefined ? {} : { usage },
  })
  const observe = (event: RunEvent): void => {
    switch (event.type) {
      case 'session': sessionId = event.sessionId; cwd = event.cwd; return
      case 'status':
        if (event.phase === 'turn_start') turns = event.turn
        if (event.phase === 'step_start') out(renderer().activity({ phase: 'thinking', label: `Thinking${terminal ? ' · Esc to stop' : ''}` }))
        if (event.phase === 'step_end') {
          if (event.usage === undefined) { completeUsage = false; usage = undefined }
          else if (completeUsage) usage = {
            inputTokens: (usage?.inputTokens ?? 0) + event.usage.inputTokens,
            outputTokens: (usage?.outputTokens ?? 0) + event.usage.outputTokens,
          }
        }
        return
      case 'thinking': return
      case 'text':
        renderedText = true; lastText += event.text
        out(renderer().answer(event.text)); return
      case 'tool_call': {
        calls.set(event.callId, event.tool)
        const inputText = typeof event.input === 'string' ? event.input : JSON.stringify(event.input)
        out(renderer().activity({ phase: 'tool', label: `${event.tool}${preview(inputText)}` })); return
      }
      case 'tool_result':
        out(renderer().activity({ phase: event.status === 'error' ? 'error' : 'done', label: `${calls.get(event.callId) ?? 'Tool'} · ${event.status}${preview(event.result)}` }))
        calls.delete(event.callId); return
      case 'final':
        if (event.text !== '' && (!renderedText || !lastText.endsWith(event.text))) out(renderer().answer(event.text))
        return
      default: assertNever(event)
    }
  }
  const runner = createTaskRunner(ctx, {
    stdout: internals.stdout, stderr: { write: (chunk) => { out(renderer().notice('error', chunk.trim())) } },
  }, { onEvent: observe })
  const lifetime = new AbortController()
  const input = terminal ? undefined : createInterface({ input: internals.stdin, terminal: false })
  const lines = input?.[Symbol.asyncIterator]()
  ctx.effect(() => () => { lifetime.abort(); runner.cancel(); input?.close() })
  const history: string[] = []
  const catalogs = async (route?: string): Promise<{ id: string; name: string; models: Awaited<ReturnType<Context['llm']['listModels']>> }[]> => {
    const routes = ctx.llm.listProviders()
    if (route !== undefined && !routes.some(value => value.id === route)) throw new Error(`provider "${route}" is not configured`)
    return Promise.all(routes.filter(value => route === undefined || value.id === route)
      .map(async value => ({ ...value, models: await ctx.llm.listModels(value.id) })))
  }
  const pick = async <T>(message: string, choices: { value: T; name: string; description?: string }[]): Promise<T | undefined> => {
    if (choices.length === 0) throw new Error('No available choices for this model configuration')
    if (!terminal) throw new Error(`${message}: specify a value when using a pipe; enter /help for syntax`)
    const next = await selectTerminalChoice({
      message, choices, input: internals.stdin, output: internals.stdout, signal: lifetime.signal,
    })
    if (next === undefined) out(renderer().notice('info', 'Selection canceled'))
    return next
  }
  out(renderer().welcome(state()))
  try {
    while (active(ctx)) {
      let raw: string
      try {
        if (terminal) raw = await readTerminalInput({
          input: internals.stdin, output: internals.stdout, prompt: renderer().prompt(), history, signal: lifetime.signal,
        })
        else {
          const next = await lines?.next()
          if (next === undefined || next.done) break
          raw = next.value
        }
      } catch (error) {
        if (error instanceof ExitPromptError) { if (active(ctx)) ctx.get('appExit')?.(130); return }
        if (error instanceof AbortPromptError && lifetime.signal.aborted) return
        throw error
      }
      const line = raw.trim()
      if (line === '/exit' || line === '/quit') break
      if (line === '') continue
      history.push(raw)
      try {
        if (line === '/help') out(renderer().help())
        else if (line === '/status') out(renderer().status(state()))
        else if (line === '/session') out(renderer().notice('info', sessionId ?? 'No session yet; enter a task first.'))
        else if (line === '/clear') {
          if (terminal) out('\u001b[2J\u001b[H')
          out(renderer().welcome(state()))
        } else if (line === '/resume') throw new Error('usage: /resume <id>')
        else if (line === '/new' || line.startsWith('/resume ')) {
          const resume = line === '/new' ? undefined : line.slice('/resume '.length).trim()
          if (resume === '') throw new Error('usage: /resume <id>')
          await runner.reset()
          sessionId = resume; turns = undefined; usage = undefined
          out(renderer().notice('success', resume === undefined ? 'New conversation ready' : `Resume ${resume} on the next task`))
        } else if (line === '/models' || line.startsWith('/models ')) {
          const route = line.slice('/models'.length).trim()
          const groups = await catalogs(route === '' ? undefined : route)
          modelMenu = groups.flatMap(group => group.models.map(value => ({ provider: group.id, model: value.id })))
          out(renderer().models(groups, selection))
        } else if (line === '/model' || line.startsWith('/model ')) {
          const words = line.split(/\s+/)
          let next: TerminalSelection | undefined
          if (words.length === 1 || (words.length === 2 && /^\d+$/.test(words[1] ?? ''))) {
            const groups = await catalogs()
            const choices = groups.flatMap(group => group.models.map(value => ({
              value: { provider: group.id, model: value.id },
              name: label(`${value.name} · ${group.id}/${value.id}`),
              description: label(`${group.name}${value.inputModalities === undefined ? '' : ` · ${value.inputModalities.join(', ')}`}`),
            })))
            if (words.length === 1 && !terminal) {
              modelMenu = choices.map(choice => choice.value)
              out(renderer().models(groups, selection)); continue
            }
            if (words.length === 2) {
              next = (modelMenu ?? choices.map(choice => choice.value))[Number(words[1]) - 1]
              if (next === undefined) throw new Error('Model number unavailable; enter /models to browse choices')
            } else next = await pick('Choose a model · type to search', choices)
          } else if (words.length === 3 && words[1] !== undefined && words[2] !== undefined) next = { provider: words[1], model: words[2] }
          else throw new Error('usage: /model [number | provider model]')
          if (next !== undefined) {
            await ctx.llm.resolveModelInfo(next.provider, next.model)
            selection = { ...next,
              ...next.provider === defaults.provider && next.model === defaults.model && defaults.reasoningEffort !== undefined
                ? { reasoningEffort: defaults.reasoningEffort } : {},
            }
            out(renderer().notice('success', `Model: ${selection.provider}/${selection.model}`))
          }
        } else if (line === '/reasoning' || line.startsWith('/reasoning ')) {
          const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
          const efforts = info.reasoning?.efforts ?? []
          const requested = line.slice('/reasoning'.length).trim()
          if (requested === '' && !terminal) {
            out(renderer().notice('info', efforts.length === 0 ? 'No reasoning efforts advertised for this model'
              : `Reasoning: ${efforts.map(value => `${value.id} (${value.name})`).join(' · ')}\n/reasoning <level> selects an effort`))
            continue
          }
          const next = requested === '' ? await pick('Choose reasoning effort', efforts.map(value => ({
            value: value.id, name: label(value.name), ...value.description === undefined ? {} : { description: label(value.description) },
          }))) : requested
          if (next !== undefined) {
            if (!efforts.some(value => value.id === next)) throw new Error(`reasoning effort "${next}" is unavailable for ${selection.model}`)
            selection = { ...selection, reasoningEffort: next }
            out(renderer().notice('success', `Reasoning: ${next}`))
          }
        } else if (line.startsWith('/')) throw new Error('Unknown command; enter /help to list commands')
        else {
          usage = undefined; completeUsage = true; renderedText = false; lastText = ''; calls.clear()
          out(renderer().request(raw))
          const start = performance.now()
          const stopKeys = terminal ? interruptKeys(() => { runner.cancel() }) : undefined
          try {
            const result = await runner.run({ task: raw, modelSelection: selection,
              ...sessionId === undefined ? {} : { sessionId } })
            sessionId = result.sessionId ?? sessionId
            const used = state().usage
            out(renderer().summary({ elapsedMs: performance.now() - start, code: result.code,
              ...result.sessionId === undefined ? {} : { sessionId: result.sessionId },
              ...used === undefined ? {} : { usage: used },
            }))
          } finally { stopKeys?.() }
        }
      } catch (error) {
        if (lifetime.signal.aborted) return
        out(renderer().notice('error', error instanceof Error ? error.message : String(error)))
      }
    }
  } finally { input?.close() }
  if (active(ctx)) ctx.get('appExit')?.(0)
}

/**
 * Open the terminal conversation or dispatch the single task.
 * @param ctx - application context with launcher-owned exit.
 * @param config - parsed task and terminal options.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.discovery === true) return
  if (config.interactive !== true) { runHeadless(ctx, config); return }
  void interactive(ctx, config).catch((error: unknown) => {
    if (!active(ctx)) return
    internals.stderr.write(`portal: ${error instanceof Error ? error.message : String(error)}\n`)
    ctx.get('appExit')?.(1)
  })
}
