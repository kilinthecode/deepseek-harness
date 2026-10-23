/**
 * @deepseek-ai/dsh-agents — the `dsh agents` runner. The bundle patch rides
 * over dsh-base without Host, HTTP, or browser plugins; this runner drives
 * `ctx.subagentWorktrees` and `ctx.subagents` to split one task across a
 * worker agent in its own git worktree, with an independent reviewer
 * checking every change before it merges — the same loop
 * `docs/cookbook`'s `agent-crew` skill drives from inside the app, exposed
 * here for people and external agents through the command line.
 *
 * @module @deepseek-ai/dsh-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertNever } from '@deepseek-ai/dsh-util-values'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { acceptVerb } from './accept.ts'
import { discardVerb } from './discard.ts'
import { errorEvent, errorLine } from './render.ts'
import type { AgentsIo } from './io.ts'
import { listVerb } from './list.ts'
import { internals } from './runner-internals.ts'
import { runVerb } from './run.ts'
import type { AgentsStartupValues } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'agents-runner'

/** Core services required before a verb can run. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'subagents', 'subagentWorktrees']

/** Plugin config: one verb and its options, resolved from this app's injected startup provider. */
export interface Config {
  /** The requested verb. */
  verb: 'run' | 'list' | 'accept' | 'discard'
  /** `run`: the task text. */
  task?: string
  /** `run`: `--name`. */
  name?: string
  /** `run`: `--model`. */
  model?: string
  /** `run`: `--effort`. */
  effort?: string
  /** `run`/`accept`: `--reviewer`. */
  reviewer?: string
  /** `run`/`accept`: `--reviewer-effort`. */
  reviewerEffort?: string
  /** `run`/`accept`: `--test`. */
  test?: string
  /** `run`: `--worktree`. */
  worktree?: string
  /** `run`: `--fix-rounds`. */
  fixRounds?: number
  /** `list`: `--all`. */
  all?: boolean
  /** `accept`/`discard`: the worktree id. */
  id?: string
  /** Whether stdout carries the machine-readable event stream instead of human-readable text. */
  json: boolean
}

export const Config: z<Config> = z.object({
  verb: z.union(['run', 'list', 'accept', 'discard'] as const).required(),
  task: z.string(),
  name: z.string(),
  model: z.string(),
  effort: z.string(),
  reviewer: z.string(),
  reviewerEffort: z.string(),
  test: z.string(),
  worktree: z.string(),
  fixRounds: z.natural(),
  all: z.boolean(),
  id: z.string(),
  json: z.boolean().default(false),
})

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: AgentsIo, error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error)
  if (json) io.stdout.write(`${JSON.stringify(errorEvent(message))}\n`)
  io.stderr.write(`${errorLine(message)}\n`)
  io.exit(1)
}

/**
 * Dispatch one verb and request process exit.
 * @param ctx - plugin context carrying the Agent, default model, Session, subagent, worktree, and launcher IO services.
 * @param config - the validated verb and its options.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: AgentsIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // driving anything so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  // Early process shutdown can dispose the tree while settlement is pending.
  if (ctx.get('agentDefaultModel') === undefined || ctx.get('agents') === undefined || ctx.get('sessions') === undefined
    || ctx.get('subagents') === undefined || ctx.get('subagentWorktrees') === undefined) return
  const values: AgentsStartupValues = config
  switch (values.verb) {
    case 'run':
      return runVerb(ctx, values, io)
    case 'list':
      return listVerb(ctx, values, io)
    case 'accept':
      return acceptVerb(ctx, values, io)
    case 'discard':
      return discardVerb(ctx, values, io)
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(values.verb, 'agents-runner verb')
  }
}

/**
 * Mount the `dsh agents` runner.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated verb and options.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('agents-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: AgentsIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error, config.json) })
}
