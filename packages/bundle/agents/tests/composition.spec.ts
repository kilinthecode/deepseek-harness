/**
 * Real-composition test: boots this package's actual `startup` and runner
 * `apply` functions through a real Loader tree, wired by a test-only
 * `cordis.yml` exactly like `cordis.patch.yml` binds them (`inject:
 * [agentsStartup]` plus the `!!js ctx.agentsStartup.*` config bindings),
 * proving the two rows compose correctly end to end. Source-plane only, per
 * `docs/testing.md#test-resolution-source-plane-only`: fixture rows delegate
 * to the real `apply` functions imported here rather than resolving the
 * published package specifiers, which would need a build. Prerequisite
 * services (including `ctx.subagentWorktrees`) are faked in one more row:
 * `@deepseek-ai/dsh-subagent-worktree`'s real service is implemented in
 * parallel and every one of its methods still throws.
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
import { apply as applyRunner, Config } from '../src/index.ts'
import { internals as runnerInternals } from '../src/runner-internals.ts'
import { apply as applyStartup, AGENTS_STARTUP_SERVICE } from '../src/startup.ts'
import { internals as startupInternals } from '../src/startup-internals.ts'

const disposers: (() => Promise<void>)[] = []
const tempDirs: string[] = []
const originalRunnerInternals = { ...runnerInternals }
const originalStartupInternals = { ...startupInternals }

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cmdlineInternals.stdout = process.stdout
  cmdlineInternals.stderr = process.stderr
  Object.assign(runnerInternals, originalRunnerInternals)
  Object.assign(startupInternals, originalStartupInternals)
})

/** Boot `dsh agents <args>` through a real Loader tree with faked prerequisite services. */
async function bootAgents(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-composition-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'fakes.mjs'), `
export function apply(ctx) {
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) })
  ctx.provide('agents', { create: () => Promise.reject(new Error('composition test: agents.create is not used by discard')) })
  ctx.provide('sessions', { flush: () => Promise.reject(new Error('composition test: sessions.flush is not used by discard')) })
  ctx.provide('subagents', { start: () => Promise.reject(new Error('composition test: subagents.start is not used by discard')) })
  ctx.provide('subagentWorktrees', {
    discard: (request) => Promise.resolve({
      id: request.id,
      repoRoot: '/repo',
      path: '/worktrees/' + request.id,
      branch: 'dsh/worktree/' + request.id,
      baseCommit: '0123456789abcdef',
      owner: { kind: 'operator' },
      label: 'demo worktree',
      task: 'demo task',
      state: 'discarded',
      createdAt: 0,
      workerSessionIds: [],
    }),
  })
}
`)
  // Fixture rows delegate to the real, imported `apply` functions instead of
  // resolving `@deepseek-ai/dsh-agents`/`@deepseek-ai/dsh-agents/startup` as
  // published specifiers, which would need lib/ built first.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'agents-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__dshAgentsApplyStartup(ctx)
`)
  writeFileSync(join(dir, 'runner.mjs'), `
export const name = 'agents-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'subagents', 'subagentWorktrees']
export const apply = (ctx, config) => globalThis.__dshAgentsApplyRunner(ctx, config)
`)
  const globals = globalThis as unknown as {
    __dshAgentsApplyStartup: typeof applyStartup
    __dshAgentsApplyRunner: (ctx: Context, config: Config) => void
  }
  globals.__dshAgentsApplyStartup = applyStartup
  globals.__dshAgentsApplyRunner = (ctx, config) => { applyRunner(ctx, new Config(config)) }

  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: fakes',
    `  name: ${pathToFileURL(join(dir, 'fakes.mjs')).href}`,
    '- id: agents-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '- id: agents-runner',
    `  name: ${pathToFileURL(join(dir, 'runner.mjs')).href}`,
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
    '',
  ].join('\n'))

  let out = ''
  let err = ''
  const observing = { write: (chunk: string) => { out += chunk; return true } }
  const observingErr = { write: (chunk: string) => { out += chunk; err += chunk; return true } }
  cmdlineInternals.stdout = observing
  cmdlineInternals.stderr = observingErr
  startupInternals.stdout = observing
  runnerInternals.stdout = { write: (chunk: string) => { out += chunk; return true } }
  runnerInternals.stderr = { write: (chunk: string) => { err += chunk; return true } }

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const exited = new Promise<number>((resolve) => {
    provideCmdline(ctx, { args, exit: resolve })
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  const code = await exited
  return { code, out, err }
}

describe('dsh agents real Loader composition', () => {
  it('wires agents-startup into agents-runner through the real Loader and discards a worktree end to end', async () => {
    const result = await bootAgents(['discard', 'wt-aaaaaaaa'])
    expect(result.code).toBe(0)
    expect(result.out).toBe('Discarded worktree wt-aaaaaaaa and branch dsh/worktree/wt-aaaaaaaa.\n')
    expect(result.err).toBe('')
  })

  it('emits the discard NDJSON outcome event in --json mode', async () => {
    const result = await bootAgents(['discard', 'wt-aaaaaaaa', '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out.trim())).toEqual({
      type: 'outcome', kind: 'discarded', id: 'wt-aaaaaaaa', branch: 'dsh/worktree/wt-aaaaaaaa',
    })
  })

  it('prints help and exits 1 for no verb, without ever reaching the runner', async () => {
    const result = await bootAgents([])
    expect(result.code).toBe(1)
    expect(result.out).toContain('Usage:')
  })
})
