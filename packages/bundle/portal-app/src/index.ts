/** Portal task invocation and model discovery over the configured Harness providers. */

import { Command, CommanderError } from 'commander'
import { stripVTControlCharacters } from 'node:util'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-llm'
import { internals } from './internals.ts'
import { createTerminalRenderer } from './presentation.ts'

/** Stable Cordis plugin name. */
export const name = 'portal-startup'

/** Services required before parsing the invocation. */
export const inject = ['cmdlineArgs']

/** Invocation service consumed by the one-shot runner. */
export const PORTAL_STARTUP_SERVICE = 'portalStartup'

/** Task and per-run options read by the runner's lazy configuration. */
export interface PortalStartupValues {
  /** Task text; omitted when stdin supplies the task. */
  task: string | undefined
  /** Exact persisted Session identity to resume. */
  sessionId: string | undefined
  /** Whether stdout carries newline-delimited run events. */
  json: boolean
  /** Image paths in argument order. */
  images: string[]
  /** Model overrides that apply only to this invocation. */
  modelSelection: { provider?: string; model?: string; reasoningEffort?: string }
  /** Open a terminal conversation instead of submitting a single task. */
  interactive: boolean
  /** Whether model discovery owns this invocation and no task should run. */
  discovery: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Parsed Portal invocation; absent for help, discovery, or rejected arguments. */
    portalStartup: PortalStartupValues
  }
}

interface Options {
  sessionId?: string
  json?: boolean
  image: string[]
  provider?: string
  model?: string
  reasoningEffort?: string
  interactive?: boolean
}

const VALUE_OPTIONS = new Set(['--session-id', '--image', '--provider', '--model', '--reasoning-effort'])
function active(ctx: Context): boolean { return ctx.fiber.state === FiberState.ACTIVE }

const TASK_REQUIRED = 'error: a task is required, for example: dsh portal "run the tests"'

function collectImage(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function displayName(value: string): string {
  return stripVTControlCharacters(value).replaceAll(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
}

/**
 * Build Portal's task grammar and model-discovery command.
 * @returns a fresh command for one invocation.
 */
export function portalCommand(): Command {
  const program = new Command()
    .name('dsh portal')
    .description('Open a terminal conversation, or run one task with a configured model and exit.')
    .helpOption('-h, --help', 'show this help')
    .option('-i, --interactive', 'open a conversation even when stdin is not a terminal')
    .option('--json', 'write newline-delimited run events instead of the final answer')
    .option('--provider <id>', 'configured provider route; requires --model')
    .option('--model <id>', 'model id; uses the default provider when --provider is omitted')
    .option('--reasoning-effort <id>', 'provider-owned reasoning level for this run')
    .option('--session-id <id>', 'resume the persisted Session with this id')
    .option('--image <path>', 'attach an image; repeat for more images', collectImage, [])
    .argument('[task...]', 'task text; a lone - reads stdin')
    .addHelpText('after', `
Launcher options (before app options):
  --models-from <profile>   read model configuration from an existing Web or Desktop profile
  --patch <path>            apply a configuration overlay (repeatable)

Examples:
  dsh portal
  dsh portal models --json
  dsh portal --models-from desktop models --json
  dsh portal --provider <route> --model <id> --json "review these changes"
  echo "run the tests" | dsh portal
  dsh portal --session-id session-… "continue"

From this checkout, use pnpm dsh portal. Any supervisor can run the task command in a background terminal
and collect its output when the process exits. Each invocation owns its shutdown.
`)
  program.command('models')
    .description('list configured provider routes and their advertised models without making a model request')
    .option('--provider <id>', 'list only this configured route')
    .option('--json', 'write one JSON object with providers and models')
  return program
}

function jsonRequested(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') return false
    if (argument === '--json') return true
    if (argument !== undefined && VALUE_OPTIONS.has(argument)) index += 1
  }
  return false
}

/**
 * Print model discovery without submitting a model request.
 * @param ctx - application carrying the registered adapters.
 * @param options - optional route filter and output format.
 * @returns after discovery output has been written.
 */
export async function printModels(ctx: Context, options: { provider?: string; json?: boolean }): Promise<void> {
  await ctx.get('loader')?.await()
  if (!active(ctx)) return
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('portal models requires the model registry')
  const routes = llm.listProviders()
  if (options.provider !== undefined && !routes.some(route => route.id === options.provider)) {
    throw new Error(`provider "${options.provider}" is not configured; run portal models to list routes`)
  }
  const providers = await Promise.all(routes
    .filter(route => options.provider === undefined || route.id === options.provider)
    .map(async route => ({ ...route, models: await llm.listModels(route.id) })))
  if (!active(ctx)) return
  internals.stdout.write(options.json === true
    ? `${JSON.stringify({ providers })}\n`
    : internals.stdout.isTTY === true ? createTerminalRenderer({
      columns: internals.stdout.columns || 80, color: process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb',
      unicode: process.env.TERM !== 'dumb', interactive: true,
    }).models(providers)
      : providers.map(route => [displayName(route.id),
        ...route.models.map(model => `  ${displayName(model.id)}\t${displayName(model.name)}`)].join('\n')).join('\n') + '\n')
}

/**
 * Publish task options, or finish a help, discovery, or rejected invocation.
 * @param ctx - context carrying the launcher's arguments and exit request.
 */
export function apply(ctx: Context): void {
  const program = portalCommand()
  if (jsonRequested(ctx.get('cmdlineArgs')?.get() ?? [])) {
    for (const command of [program, ...program.commands]) {
      command.error = (message: string, options?: Parameters<Command['error']>[1]): never => {
        internals.stdout.write(`${JSON.stringify({ type: 'error', message: message.replace(/^error: /, '') })}\n`)
        throw new CommanderError(1, options?.code ?? 'commander.error', message)
      }
    }
  }
  for (const command of program.commands) command.action((options: { provider?: string; json?: boolean }) => {
    const merged = { ...program.opts<Options>(), ...options }
    if (merged.provider?.trim() === '') program.error('error: --provider requires a non-empty route')
    ctx.provide(PORTAL_STARTUP_SERVICE, {
      task: undefined, sessionId: undefined, json: false, images: [], modelSelection: {}, interactive: false, discovery: true,
    } satisfies PortalStartupValues)
    void printModels(ctx, merged).then(() => {
      if (active(ctx)) ctx.get('appExit')?.(0)
    }).catch((error: unknown) => {
      if (!active(ctx)) return
      const message = error instanceof Error ? error.message : String(error)
      if (merged.json === true) internals.stdout.write(`${JSON.stringify({ type: 'error', message })}\n`)
      process.stderr.write(`portal: ${message}\n`)
      ctx.get('appExit')?.(1)
    })
  })
  program.action(() => {
    const words = program.args
    if (words.length > 1 && words.includes('-')) program.error('error: `-` must be the only task argument')
    if (words.length > 0 && words.join(' ').trim() === '') {
      program.error(TASK_REQUIRED)
    }
    const options = program.opts<Options>()
    const interactive = options.interactive === true || (words.length === 0 && internals.stdinIsTty())
    if (interactive && words.length > 0) program.error('error: --interactive takes no task argument')
    if (interactive && options.image.length > 0) program.error('error: --image requires a one-shot task')
    if (interactive && options.json === true) program.error('error: --json requires a task or piped input')
    for (const [key, value] of Object.entries(options)) {
      if (typeof value === 'string' && value.trim() === '') {
        const flag = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
        program.error(`error: --${flag} requires a non-empty value`)
      }
    }
    if (options.image.some(path => path.trim() === '')) program.error('error: --image requires a non-empty path')
    if (options.provider !== undefined && options.model === undefined) program.error('error: --provider requires --model')
    ctx.provide(PORTAL_STARTUP_SERVICE, {
      task: words.length === 0 ? undefined : words.join(' '),
      sessionId: options.sessionId,
      json: options.json === true,
      images: options.image,
      interactive,
      discovery: false,
      modelSelection: {
        ...options.provider === undefined ? {} : { provider: options.provider },
        ...options.model === undefined ? {} : { model: options.model },
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      },
    } satisfies PortalStartupValues)
  })
  parseCmdline(ctx, program)
}
