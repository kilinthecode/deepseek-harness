/**
 * The terminal app's command-line provider over a real Loader tree: the task
 * words and exact Session identity become injected driver config, while help
 * and usage rejections leave the consumer pending.
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
import { apply, PORTAL_STARTUP_SERVICE, type PortalStartupValues } from '../src/index.ts'
import { internals } from '../src/internals.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  err: string
  runnerConfig?: { task?: string; sessionId?: string }
}

declare global {
  var __portalStartupApply: typeof apply | undefined
  var __portalStartupObserved: Observed | undefined
}

/** The real process facts captured before any test substitutes them. */
const originalInternals = { ...internals }

/** Fixture tree roots, removed after their booted tree has been disposed. */
const tempDirs: string[] = []

/** Dispose functions for the trees booted by a test. */
const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cmdlineInternals.stdout = process.stdout
  cmdlineInternals.stderr = process.stderr
  Object.assign(internals, originalInternals)
  globalThis.__portalStartupApply = undefined
  globalThis.__portalStartupObserved = undefined
})

/**
 * Mount the real provider over a driver stand-in that records its config.
 * @param args - the invocation's inner arguments.
 * @param options - process facts the provider reads.
 * @returns the published service value, the observed process effects, and the booted context.
 */
async function bootStartup(
  args: string[],
  options: { stdinIsTty?: boolean } = {},
): Promise<{ task: PortalStartupValues | undefined; observed: Observed; ctx: Context }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-portal-startup-'))
  tempDirs.push(dir)
  const observed: Observed = { exits: [], out: '', err: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__portalStartupObserved.runnerConfig = config }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'portal-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__portalStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: portal-runner',
    `  name: ${rowUrl}`,
    `  inject: [${PORTAL_STARTUP_SERVICE}]`,
    '  config:',
    '    task: !!js ctx.portalStartup.task',
    '    sessionId: !!js ctx.portalStartup.sessionId',
    '    interactive: !!js ctx.portalStartup.interactive',
    '    discovery: !!js ctx.portalStartup.discovery',
    '    json: !!js ctx.portalStartup.json',
    '    images: !!js ctx.portalStartup.images',
    '    modelSelection: !!js ctx.portalStartup.modelSelection',
    '- id: portal-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  // Commander's own output keeps landing in `out` so the assertions read the
  // full transcript, while `err` isolates what stderr actually carried.
  const observingErr = {
    write: (chunk: string) => {
      observed.out += chunk
      observed.err += chunk
      return true
    },
  }
  internals.stdout = observing
  cmdlineInternals.stdout = observing
  cmdlineInternals.stderr = observingErr
  internals.stdinIsTty = () => options.stdinIsTty === true
  globalThis.__portalStartupApply = apply
  globalThis.__portalStartupObserved = observed

  const ctx = new Context()
  disposers.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  return {
    task: ctx.get(PORTAL_STARTUP_SERVICE),
    observed,
    ctx,
  }
}

describe('portal command-line provider', () => {
  it('joins the task positional into the driver config', async () => {
    const { task, observed } = await bootStartup(['run', 'the', 'tests'])
    expect(task).toMatchObject({ task: 'run the tests', sessionId: undefined })
    expect(observed.runnerConfig).toMatchObject({ task: 'run the tests' })
    expect(observed.exits).toEqual([])
  })

  it('keeps the caller-provided exact Session identity verbatim', async () => {
    const { task, observed } = await bootStartup(['--session-id', ' session-x ', 'do', 'it'])
    expect(task).toMatchObject({ task: 'do it', sessionId: ' session-x ' })
    expect(observed.runnerConfig).toMatchObject({ sessionId: ' session-x ' })
    expect(observed.exits).toEqual([])
  })

  it('rejects an explicitly empty Session identity', async () => {
    const { task, observed } = await bootStartup(['--session-id', '', 'do', 'it'])
    expect(observed.out).toContain('--session-id requires a non-empty value')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('keeps the stdin marker as the task so the driver reads the pipe', async () => {
    const { task } = await bootStartup(['-'], { stdinIsTty: false })
    expect(task).toMatchObject({ task: '-', sessionId: undefined })
  })

  it('defers an absent task to stdin when stdin is not a terminal', async () => {
    const { task, observed } = await bootStartup([], { stdinIsTty: false })
    expect(task).toMatchObject({ task: undefined, sessionId: undefined })
    expect(observed.exits).toEqual([])
  })

  it.each([{ args: ['   '] }])('rejects an interactive invocation with no task ($args)', async ({ args }) => {
    const { task, observed } = await bootStartup(args, { stdinIsTty: true })
    expect(observed.out).toContain('a task is required')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects a lone stdin marker mixed with other task words', async () => {
    const { task, observed } = await bootStartup(['-', 'do', 'it'])
    expect(observed.out).toContain('`-` must be the only task argument')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('prints this app\'s help without publishing a task', async () => {
    const { task, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('Usage: dsh portal')
    expect(observed.out).toContain('dsh portal --session-id')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects an unknown option as a usage error', async () => {
    const { task, observed } = await bootStartup(['--bogus', 'do', 'it'])
    expect(observed.out).toContain("unknown option '--bogus'")
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('withdraws the published service when the tree disposes', async () => {
    const { task, ctx } = await bootStartup(['do', 'it'])
    expect(task).toMatchObject({ task: 'do it', sessionId: undefined })
    await ctx.fiber.dispose()
    expect(ctx.get(PORTAL_STARTUP_SERVICE)).toBeUndefined()
  })

  it('opens an interactive session for a bare terminal invocation', async () => {
    const { task, observed } = await bootStartup([], { stdinIsTty: true })
    expect(task).toMatchObject({ interactive: true, discovery: false, task: undefined })
    expect(observed.exits).toEqual([])
  })

  it('opens an explicit interactive session for an automation pipe', async () => {
    const { task } = await bootStartup(['--interactive'])
    expect(task).toMatchObject({ interactive: true })
  })

  it.each([['--interactive', '--json'], ['--interactive', 'task'], ['--interactive', '--image', 'a.png']])(
    'rejects conflicting terminal options %j', async (...args: string[]) => {
      const { task, observed } = await bootStartup(args)
      expect(task).toBeUndefined()
      expect(observed.exits).toEqual([1])
    },
  )

  it('passes per-run model, reasoning, JSON, and image options to the runner', async () => {
    const { task, observed } = await bootStartup([
      '--provider', 'route', '--model', 'model', '--reasoning-effort', 'high',
      '--json', '--image', 'a.png', '--image', 'b.png', 'review',
    ])
    expect(task).toEqual({
      task: 'review', sessionId: undefined, interactive: false, discovery: false, json: true, images: ['a.png', 'b.png'],
      modelSelection: { provider: 'route', model: 'model', reasoningEffort: 'high' },
    })
    expect(observed.runnerConfig).toEqual(task)
  })

  it.each([
    ['--provider', 'route', 'review'], ['--model', '', 'review'],
    ['--reasoning-effort', ' ', 'review'], ['--image', '', 'review'],
  ])('rejects unusable model options %j', async (...args: string[]) => {
    const { task, observed } = await bootStartup(args)
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it.each([
    ['--json', '--bogus'], ['--json', '--model'], ['--json', '--provider', 'route', 'review'],
  ])('reports JSON grammar and usage errors %j', async (...args: string[]) => {
    const { observed } = await bootStartup(args)
    const event: unknown = JSON.parse(observed.out)
    expect(event).toMatchObject({ type: 'error' })
    expect(event).toHaveProperty('message')
    expect(observed.err).toBe('')
    expect(observed.exits).toEqual([1])
  })

  it('keeps literal JSON option values and positional words as ordinary text', async () => {
    const { task, observed } = await bootStartup(['--model=--json', '--', '--json'])
    expect(task).toMatchObject({ task: '--json', json: false, modelSelection: { model: '--json' } })
    expect(observed.out).toBe('')
  })

  it('reports the real process stdin terminal state by default', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')
    Object.defineProperty(process, 'stdin', { value: { isTTY: true }, configurable: true })
    try {
      expect(originalInternals.stdinIsTty()).toBe(true)
    } finally {
      Object.defineProperty(process, 'stdin', { ...original, configurable: true } as PropertyDescriptor)
    }
  })
})
