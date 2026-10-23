/**
 * The `dsh agents` command-line provider over a real Loader tree: every verb,
 * its flags, stdin markers, help, and JSON-mode grammar-error reporting.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals as cmdlineInternals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, AGENTS_STARTUP_SERVICE, type AgentsStartupValues } from '../src/startup.ts'
import { internals as startupInternals } from '../src/startup-internals.ts'

interface Observed {
  exits: number[]
  out: string
  err: string
  runnerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cmdlineInternals.stdout = process.stdout
  cmdlineInternals.stderr = process.stderr
  startupInternals.stdout = process.stdout
})

/**
 * Mount the real provider over a runner stand-in that records whatever
 * config the fixture's `cordis.yml` binds from `ctx.agentsStartup`.
 */
async function bootStartup(args: string[]): Promise<{ values: AgentsStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-startup-'))
  tempDirs.push(dir)
  const observed: Observed = { exits: [], out: '', err: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__agentsStartupObserved.runnerConfig = config }\n')
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'agents-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__agentsStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: agents-runner',
    `  name: ${rowUrl}`,
    `  inject: [${AGENTS_STARTUP_SERVICE}]`,
    '  config:',
    '    verb: !!js ctx.agentsStartup.verb',
    '    task: !!js ctx.agentsStartup.task',
    '    name: !!js ctx.agentsStartup.name',
    '    model: !!js ctx.agentsStartup.model',
    '    effort: !!js ctx.agentsStartup.effort',
    '    reviewer: !!js ctx.agentsStartup.reviewer',
    '    reviewerEffort: !!js ctx.agentsStartup.reviewerEffort',
    '    test: !!js ctx.agentsStartup.test',
    '    worktree: !!js ctx.agentsStartup.worktree',
    '    fixRounds: !!js ctx.agentsStartup.fixRounds',
    '    all: !!js ctx.agentsStartup.all',
    '    id: !!js ctx.agentsStartup.id',
    '    json: !!js ctx.agentsStartup.json',
    '- id: agents-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  const observingErr = {
    write: (chunk: string) => { observed.out += chunk; observed.err += chunk; return true },
  }
  cmdlineInternals.stdout = observing
  cmdlineInternals.stderr = observingErr
  startupInternals.stdout = observing
  const globals = globalThis as typeof globalThis & { __agentsStartupApply: typeof apply; __agentsStartupObserved: Observed }
  globals.__agentsStartupApply = apply
  globals.__agentsStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { values: ctx.get(AGENTS_STARTUP_SERVICE) as AgentsStartupValues | undefined, observed }
}

describe('dsh agents command-line provider', () => {
  describe('run', () => {
    it('joins the task and defaults fixRounds/json', async () => {
      const { values, observed } = await bootStartup(['run', 'add', 'the', 'parser'])
      expect(values).toEqual({ verb: 'run', task: 'add the parser', fixRounds: 0, json: false })
      expect(observed.exits).toEqual([])
    })

    it('parses every run flag', async () => {
      const { values } = await bootStartup([
        'run', '--name', 'my label', '--model', 'openai/gpt-5', '--effort', 'high',
        '--reviewer', 'anthropic/opus', '--reviewer-effort', 'low', '--test', 'pnpm test',
        '--worktree', 'wt-aaaaaaaa', '--fix-rounds', '2', '--json', 'add', 'the', 'parser',
      ])
      expect(values).toEqual({
        verb: 'run', task: 'add the parser', name: 'my label', model: 'openai/gpt-5', effort: 'high',
        reviewer: 'anthropic/opus', reviewerEffort: 'low', test: 'pnpm test', worktree: 'wt-aaaaaaaa',
        fixRounds: 2, json: true,
      })
    })

    it('keeps a lone "-" as the task so the runner reads stdin', async () => {
      const { values } = await bootStartup(['run', '-'])
      expect(values).toEqual({ verb: 'run', task: '-', fixRounds: 0, json: false })
    })

    it('rejects a "-" mixed with other task words', async () => {
      const { values, observed } = await bootStartup(['run', '-', 'add', 'the', 'parser'])
      expect(observed.out).toContain('`-` must be the only task argument')
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([1])
    })

    it('rejects a blank task', async () => {
      const { values, observed } = await bootStartup(['run', '   '])
      expect(observed.out).toContain('a task is required')
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([1])
    })

    it('rejects a missing task entirely', async () => {
      const { observed } = await bootStartup(['run'])
      expect(observed.exits).toEqual([1])
    })

    it.each(['--model', '--reviewer'])('rejects a malformed %s route before publishing', async (flag) => {
      const { values, observed } = await bootStartup(['run', flag, 'bogus', 'add', 'the', 'parser'])
      expect(observed.out).toContain(`${flag} must be <provider>/<model>`)
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([1])
    })

    it('rejects a non-numeric --fix-rounds', async () => {
      const { observed } = await bootStartup(['run', '--fix-rounds', 'x', 'task'])
      expect(observed.out).toContain('--fix-rounds must be a non-negative integer')
      expect(observed.exits).toEqual([1])
    })

    it('rejects a negative --fix-rounds', async () => {
      const { observed } = await bootStartup(['run', '--fix-rounds', '-1', 'task'])
      expect(observed.exits).toEqual([1])
    })

    it('rejects --reviewer-effort without --reviewer, since there is no route to apply it to at parse time', async () => {
      const { values, observed } = await bootStartup(['run', '--reviewer-effort', 'high', 'add', 'the', 'parser'])
      expect(observed.out).toContain('--reviewer-effort requires --reviewer')
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([1])
    })

    it('rejects a blank --name instead of silently falling back to a derived label', async () => {
      const { values, observed } = await bootStartup(['run', '--name', '   ', 'add', 'the', 'parser'])
      expect(observed.out).toContain('--name requires a non-empty label')
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([1])
    })

    it('publishes a bare --effort without --model for the runner to apply to the default selection', async () => {
      const { values } = await bootStartup(['run', '--effort', 'high', 'add', 'the', 'parser'])
      expect(values).toEqual({ verb: 'run', task: 'add the parser', effort: 'high', fixRounds: 0, json: false })
    })
  })

  describe('list', () => {
    it('defaults --all and --json to false', async () => {
      const { values } = await bootStartup(['list'])
      expect(values).toEqual({ verb: 'list', all: false, json: false })
    })

    it('parses --all and --json', async () => {
      const { values } = await bootStartup(['list', '--all', '--json'])
      expect(values).toEqual({ verb: 'list', all: true, json: true })
    })
  })

  describe('accept', () => {
    it('parses just the worktree id, defaulting every other field', async () => {
      const { values } = await bootStartup(['accept', 'wt-aaaaaaaa'])
      expect(values).toEqual({ verb: 'accept', id: 'wt-aaaaaaaa', json: false })
    })

    it('parses the worktree id and every accept flag', async () => {
      const { values } = await bootStartup([
        'accept', 'wt-aaaaaaaa', '--reviewer', 'anthropic/opus', '--reviewer-effort', 'low', '--test', 'pnpm test', '--json',
      ])
      expect(values).toEqual({
        verb: 'accept', id: 'wt-aaaaaaaa', reviewer: 'anthropic/opus', reviewerEffort: 'low', test: 'pnpm test', json: true,
      })
    })

    it('rejects a blank worktree id', async () => {
      const { values, observed } = await bootStartup(['accept', '   '])
      expect(observed.out).toContain('accept needs a worktree id')
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([1])
    })

    it('rejects a missing worktree id', async () => {
      const { observed } = await bootStartup(['accept'])
      expect(observed.exits).toEqual([1])
    })

    it('rejects --reviewer-effort without --reviewer', async () => {
      const { values, observed } = await bootStartup(['accept', 'wt-aaaaaaaa', '--reviewer-effort', 'high'])
      expect(observed.out).toContain('--reviewer-effort requires --reviewer')
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([1])
    })
  })

  describe('discard', () => {
    it('parses the worktree id', async () => {
      const { values } = await bootStartup(['discard', 'wt-aaaaaaaa'])
      expect(values).toEqual({ verb: 'discard', id: 'wt-aaaaaaaa', json: false })
    })

    it('rejects a blank worktree id', async () => {
      const { values, observed } = await bootStartup(['discard', '   '])
      expect(observed.out).toContain('discard needs a worktree id')
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([1])
    })
  })

  describe('no verb / unknown verb', () => {
    it('prints help and exits 1 for no verb', async () => {
      const { values, observed } = await bootStartup([])
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([1])
      expect(observed.out).toContain('Usage:')
      expect(observed.out).toContain('run')
      expect(observed.out).toContain('list')
      expect(observed.out).toContain('accept')
      expect(observed.out).toContain('discard')
    })

    it('prints help and exits 1 for an unknown verb', async () => {
      const { values, observed } = await bootStartup(['bogus'])
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([1])
      expect(observed.out).toContain('Usage:')
    })
  })

  describe('--help', () => {
    it('prints the top-level help and exits 0', async () => {
      const { values, observed } = await bootStartup(['--help'])
      expect(values).toBeUndefined()
      expect(observed.exits).toEqual([0])
      expect(observed.out).toContain('Run a task in a worker agent\'s own git worktree')
    })

    it('prints run-specific help and exits 0', async () => {
      const { observed } = await bootStartup(['run', '--help'])
      expect(observed.exits).toEqual([0])
      expect(observed.out).toContain('--fix-rounds')
    })
  })

  describe('--json grammar-error reporting', () => {
    it('writes a JSON error event for a run usage error', async () => {
      const { observed } = await bootStartup(['run', '--json', '   '])
      const first = JSON.parse(observed.out.trim().split('\n')[0] ?? '{}') as { type: string; message: string }
      expect(first).toEqual({ type: 'error', message: 'a task is required, for example: dsh agents run "add the parser and its tests"' })
      expect(observed.err).toBe('')
      expect(observed.exits).toEqual([1])
    })

    it('writes a JSON error event for an unknown option on a scripted verb', async () => {
      const { observed } = await bootStartup(['list', '--json', '--bogus'])
      const first = JSON.parse(observed.out.trim().split('\n')[0] ?? '{}') as { type: string; message: string }
      expect(first).toEqual({ type: 'error', message: "unknown option '--bogus'" })
      expect(observed.exits).toEqual([1])
    })

    it('does not install the JSON override for a --json option value', async () => {
      const { observed } = await bootStartup(['run', '--name', '--json', '   '])
      expect(observed.out).toContain('a task is required')
      expect(observed.out).not.toContain('"type":"error"')
      expect(observed.exits).toEqual([1])
    })

    it('does not install the JSON override for a --json positional after --', async () => {
      const { values } = await bootStartup(['run', '--', '--json'])
      expect(values).toEqual({ verb: 'run', task: '--json', fixRounds: 0, json: false })
    })
  })

  it('fails loud without the launcher command line and exit request', () => {
    expect(() => { apply(new Context()) }).toThrow('the launcher must provide ctx.cmdlineArgs and ctx.appExit')
  })
})
