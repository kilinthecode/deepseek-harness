/**
 * The `dsh agents` command-line provider: it parses the `run`, `list`,
 * `accept`, and `discard` verbs (or prints help and requests a failing exit
 * for no verb or an unknown one), then publishes
 * {@link AGENTS_STARTUP_SERVICE}. The runner is an ordinary consumer whose
 * lazy config waits for that service.
 * @module @deepseek-ai/dsh-agents/startup
 */

import { Command, CommanderError, InvalidArgumentError } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { parseRouteFlag } from './route.ts'
import { internals } from './startup-internals.ts'

/** Stable Cordis plugin name. */
export const name = 'agents-startup'

/** Services required before the verb can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the runner. */
export const AGENTS_STARTUP_SERVICE = 'agentsStartup'

/**
 * What the runner row reads from {@link AGENTS_STARTUP_SERVICE}. One flat
 * shape covers every verb; each verb's action publishes only its own fields,
 * leaving the rest undefined.
 */
export interface AgentsStartupValues {
  /** The requested verb. */
  readonly verb: 'run' | 'list' | 'accept' | 'discard'
  /** `run`: the task text, already joined and validated non-blank. */
  readonly task?: string
  /** `run`: `--name`, the worktree's display label; absent derives one from the task. */
  readonly name?: string
  /** `run`: `--model`, the worker's `<provider>/<model>` route; absent uses the default-model selection. */
  readonly model?: string
  /** `run`: `--effort`, the worker's reasoning effort; ignored when `model` is absent. */
  readonly effort?: string
  /** `run`/`accept`: `--reviewer`, an operator override for the reviewer route. */
  readonly reviewer?: string
  /** `run`/`accept`: `--reviewer-effort`, reasoning effort for `reviewer`. */
  readonly reviewerEffort?: string
  /** `run`/`accept`: `--test`, the check command run before the reviewer, split on whitespace. */
  readonly test?: string
  /** `run`: `--worktree`, an existing open worktree id to reuse instead of creating one. */
  readonly worktree?: string
  /** `run`: `--fix-rounds`, automatic fix attempts after a rejected review or failing check; defaults to `0`. */
  readonly fixRounds?: number
  /** `list`: `--all`, include merged and discarded worktrees. */
  readonly all?: boolean
  /** `accept`/`discard`: the worktree id. */
  readonly id?: string
  /** Whether stdout carries the machine-readable event stream instead of human-readable text. */
  readonly json: boolean
}

/** Option flags that consume the next argv token, so a `--json` scan must skip their values. */
const VALUE_FLAGS = new Set([
  '--name', '--model', '--effort', '--reviewer', '--reviewer-effort', '--test', '--worktree', '--fix-rounds',
])

/**
 * Whether the raw invocation asks for the machine-readable stream. The scan
 * stops at `--` and skips a value-taking flag's value, so a literal `--json`
 * used as an option value or a positional never installs the JSON error
 * override.
 * @param argv - the invocation's raw arguments.
 * @returns whether `--json` is a real flag of this invocation.
 */
function jsonRequested(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') return false
    if (argument === '--json') return true
    if (argument !== undefined && VALUE_FLAGS.has(argument)) index += 1
  }
  return false
}

/**
 * Install the `--json` grammar-error override on one command: a rejected
 * parse still owes a `--json` caller an `error` event on stdout, matching the
 * runner's own error reporting.
 * @param command - the command (root or one verb) to install the override on.
 */
function installJsonErrorOverride(command: Command): void {
  command.error = (message: string, errorOptions?: Parameters<Command['error']>[1]): never => {
    const payload = JSON.stringify({ type: 'error', message: message.replace(/^error: /, '') })
    internals.stdout.write(`${payload}\n`)
    throw new CommanderError(1, errorOptions?.code ?? 'commander.error', message)
  }
}

/** Parse `--fix-rounds`: a non-negative integer. */
function parseFixRounds(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError('--fix-rounds must be a non-negative integer')
  return Number.parseInt(value, 10)
}

/** Options common to `run` and `accept`: the reviewer override and check command. */
interface ReviewOptions {
  reviewer?: string
  reviewerEffort?: string
  test?: string
  json?: boolean
}

/** Parsed `run`-only options, layered over {@link ReviewOptions}. */
interface RunOptions extends ReviewOptions {
  name?: string
  model?: string
  effort?: string
  worktree?: string
  fixRounds: number
}

/**
 * Validate a `<provider>/<model>` flag as early as the grammar can: the split
 * needs no injected service, so a malformed route fails here rather than
 * after the runner has already resolved the default model or created the
 * operator Agent. `parseRouteFlag` is owned by this package and only ever
 * throws `Error`, so the caught value is narrowed without a defensive branch.
 * @param command - the command to report a rejection through.
 * @param flag - the flag name, for the error message.
 * @param value - the raw flag value, or undefined when the flag was omitted.
 */
function validateRouteFlag(command: Command, flag: string, value: string | undefined): void {
  if (value === undefined) return
  try {
    parseRouteFlag(flag, value)
  } catch (error) {
    command.error(`error: ${(error as Error).message}`)
  }
}

/**
 * Reject `--reviewer-effort` given without `--reviewer`: the CLI has no
 * configured or operator reviewer route to apply it to at parse time, so
 * silently dropping it would give the wrong impression that it took effect.
 * @param command - the command to report a rejection through.
 * @param options - the parsed reviewer options.
 */
function validateReviewerEffort(command: Command, options: ReviewOptions): void {
  if (options.reviewerEffort !== undefined && options.reviewer === undefined) {
    command.error('error: --reviewer-effort requires --reviewer')
  }
}

/**
 * Reject a `--name` that is present but blank: an empty display label is
 * never useful, and rejecting it here catches a stray empty argument instead
 * of silently falling back to a derived label.
 * @param command - the command to report a rejection through.
 * @param name - the raw `--name` value, or undefined when the flag was omitted.
 */
function validateName(command: Command, name: string | undefined): void {
  if (name !== undefined && name.trim() === '') command.error('error: --name requires a non-empty label')
}

/**
 * Parse and provide the `dsh agents` verb as an ordinary Cordis service. Each
 * verb's action publishes the parsed values; on a grammar rejection, on no
 * verb, on an unknown verb, or on `--help`, nothing is provided and the
 * process already exits through `ctx.appExit`.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const argv = ctx.get('cmdlineArgs')?.get() ?? []
  const json = jsonRequested(argv)
  const publish = (values: AgentsStartupValues): void => {
    ctx.provide(AGENTS_STARTUP_SERVICE, values)
  }

  const program = new Command()
    .name('dsh agents')
    .description(
      'Run a task in a worker agent\'s own git worktree, with an independent reviewer checking the '
      + 'change before it merges.',
    )
    .helpOption('-h, --help', 'show this help')

  const run = program.command('run')
    .description('Create a worktree, run a worker in it, then have an independent reviewer check the result before merging.')
    .option('--name <label>', 'short display label for the worktree; defaults to the first line of the task')
    .option('--model <provider/model>', 'route the worker runs on; defaults to the current default-model selection')
    .option('--effort <effort>', 'reasoning effort for --model')
    .option('--reviewer <provider/model>', 'route the reviewer runs on; defaults to the configured reviewer or your own route')
    .option('--reviewer-effort <effort>', 'reasoning effort for --reviewer')
    .option('--test <cmd>', 'check command run in the review checkout before the reviewer, split on whitespace')
    .option('--worktree <id>', 'reuse an existing open worktree instead of creating one')
    .option('--fix-rounds <n>', 'automatic fix attempts after a rejected review or a failing check', parseFixRounds, 0)
    .option('--json', 'write newline-delimited run events to stdout instead of human-readable text')
    .argument('<task...>', 'the task text; multiple words are joined by spaces, and a lone `-` reads stdin')
    .action((task: string[], options: RunOptions) => {
      if (task.length > 1 && task.includes('-')) run.error('error: `-` must be the only task argument')
      const joined = task.join(' ')
      if (joined.trim() === '') run.error('error: a task is required, for example: dsh agents run "add the parser and its tests"')
      validateRouteFlag(run, '--model', options.model)
      validateRouteFlag(run, '--reviewer', options.reviewer)
      validateReviewerEffort(run, options)
      validateName(run, options.name)
      publish({
        verb: 'run',
        task: joined,
        ...options.name === undefined ? {} : { name: options.name },
        ...options.model === undefined ? {} : { model: options.model },
        ...options.effort === undefined ? {} : { effort: options.effort },
        ...options.reviewer === undefined ? {} : { reviewer: options.reviewer },
        ...options.reviewerEffort === undefined ? {} : { reviewerEffort: options.reviewerEffort },
        ...options.test === undefined ? {} : { test: options.test },
        ...options.worktree === undefined ? {} : { worktree: options.worktree },
        fixRounds: options.fixRounds,
        json: options.json === true,
      })
    })

  const list = program.command('list')
    .description('List the repository\'s worktrees.')
    .option('--all', 'include merged and discarded worktrees')
    .option('--json', 'write newline-delimited worktree events to stdout instead of human-readable text')
    .action((options: { all?: boolean; json?: boolean }) => {
      publish({ verb: 'list', all: options.all === true, json: options.json === true })
    })

  const accept = program.command('accept')
    .description('Commit, check, review, and merge one worktree.')
    .argument('<id>', 'the worktree id')
    .option('--reviewer <provider/model>', 'reviewer route for this accept, overriding configuration')
    .option('--reviewer-effort <effort>', 'reasoning effort for --reviewer')
    .option('--test <cmd>', 'check command for this accept, replacing the configured one, split on whitespace')
    .option('--json', 'write newline-delimited events to stdout instead of human-readable text')
    .action((id: string, options: ReviewOptions) => {
      if (id.trim() === '') accept.error('error: accept needs a worktree id')
      validateRouteFlag(accept, '--reviewer', options.reviewer)
      validateReviewerEffort(accept, options)
      publish({
        verb: 'accept',
        id,
        ...options.reviewer === undefined ? {} : { reviewer: options.reviewer },
        ...options.reviewerEffort === undefined ? {} : { reviewerEffort: options.reviewerEffort },
        ...options.test === undefined ? {} : { test: options.test },
        json: options.json === true,
      })
    })

  const discard = program.command('discard')
    .description('Delete one worktree and its branch without merging.')
    .argument('<id>', 'the worktree id')
    .option('--json', 'write a newline-delimited event to stdout instead of human-readable text')
    .action((id: string, options: { json?: boolean }) => {
      if (id.trim() === '') discard.error('error: discard needs a worktree id')
      publish({ verb: 'discard', id, json: options.json === true })
    })

  // No root action: with subcommands present and no action handler, Commander's
  // own zero-operand fallback prints full help and exits 1, matching an
  // unknown verb below.
  program.on('command:*', () => { program.help({ error: true }) })

  if (json) for (const command of [program, run, list, accept, discard]) installJsonErrorOverride(command)

  parseCmdline(ctx, program)
}
