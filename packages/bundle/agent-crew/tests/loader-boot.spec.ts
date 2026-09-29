/**
 * The rows the agent-crew bundle composes over `dsh-base`, booted through a real Loader tree in the activation
 * order that used to hide the `isolation` parameter: the Host-level `tool-subagent` row mounts while the
 * `subagent-worktree` service, which it does not inject, is still starting.
 *
 * Real: `applyEntryPatches` over the shipped `dsh-base` and agent-crew patch files (and an extra user layer), the
 * Loader and its entry lifecycle (a bundle toggle is an entry update), and the three plugin modules. Source-plane
 * only, per `docs/testing.md#test-resolution-source-plane-only`: fixture rows delegate to the real modules imported
 * here rather than resolving published package specifiers, which would need a build. The service fixture waits on a
 * gate the test releases, which forces the adverse order deterministically; it also skips the service's own
 * `inject`, whose subprocess, agent, and subagent services this test does not mount because it calls no git method.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions, PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SubagentWorktrees from '@deepseek-ai/dsh-subagent-worktree'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolSubagentWorktree from '@deepseek-ai/dsh-tool-subagent-worktree'
import { mountBasePrerequisites } from './base-prerequisites.ts'
import { loadPatches } from './patch-rows.ts'

/** What the fixture rows delegate to, set on `globalThis` before the Loader imports them. */
interface BootHooks {
  gate: Promise<void>
  worktrees: typeof SubagentWorktrees
  toolSubagent: typeof ToolSubagent
  toolSubagentWorktree: typeof ToolSubagentWorktree
}

const hooks = globalThis as typeof globalThis & { __agentCrewBoot?: BootHooks }
const disposers: (() => Promise<void>)[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete hooks.__agentCrewBoot
})

/** The fixture module each package name resolves to: a row that delegates to the real module through the hooks. */
const FIXTURES: Record<string, { file: string; source: string }> = {
  '@deepseek-ai/dsh-subagent-worktree': {
    file: 'worktrees.mjs',
    source: `
const boot = globalThis.__agentCrewBoot
export const name = 'subagent-worktree'
export const Config = boot.worktrees.Config
export async function apply(ctx, config) {
  await boot.gate
  new boot.worktrees(ctx, config)
}
`,
  },
  '@deepseek-ai/dsh-tool-subagent': {
    file: 'tool-subagent.mjs',
    source: `
const real = globalThis.__agentCrewBoot.toolSubagent
export const name = 'tool-subagent'
export const inject = real.inject
export const Config = real.Config
export const apply = (ctx, config) => real.apply(ctx, config)
`,
  },
  '@deepseek-ai/dsh-tool-subagent-worktree': {
    file: 'tool-subagent-worktree.mjs',
    source: `
const real = globalThis.__agentCrewBoot.toolSubagentWorktree
export const name = 'tool-subagent-worktree'
export const inject = real.inject
export const Config = real.Config
export const apply = (ctx, config) => real.apply(ctx, config)
`,
  },
}

const BASE = () => loadPatches('base')
const CREW = () => loadPatches('agentCrew')
/** A user patch on the service row, the documented way to pin the reviewer: it replaces the row's whole config. */
const PIN_REVIEWER: PatchOptions[] = [{ id: 'subagent-worktree', config: { reviewerProvider: 'mock', reviewerModel: 'mock' } }]

/** Find the composed row with this id. */
function rowOf(entries: EntryOptions[], id: string): EntryOptions | undefined {
  return entries.find(entry => entry.id === id)
}

/**
 * Compose the patch layers over an empty root, as the boot include does, and boot the rows this suite exercises
 * through a real Loader, each mapped to its fixture.
 * @param layers - patch lists in application order.
 * @returns the booted context, the composed rows that were booted, and the release for the service gate.
 */
async function boot(layers: PatchOptions[][]) {
  const composed = applyEntryPatches([], structuredClone(layers.flat()), () => {})
  const rows = ['subagent-worktree', 'tool-subagent', 'tool-subagent-worktree']
    .flatMap(id => rowOf(composed, id) ?? [])
  let release!: () => void
  hooks.__agentCrewBoot = {
    gate: new Promise<void>((resolve) => { release = resolve }),
    worktrees: SubagentWorktrees,
    toolSubagent: ToolSubagent,
    toolSubagentWorktree: ToolSubagentWorktree,
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agent-crew-loader-'))
  tempDirs.push(dir)
  const entries = rows.map((row) => {
    const fixture = FIXTURES[row.name as string]
    if (fixture === undefined) throw new Error(`no fixture for the "${row.id}" row's package ${String(row.name)}`)
    writeFileSync(join(dir, fixture.file), fixture.source)
    return { id: row.id, name: pathToFileURL(join(dir, fixture.file)).href, ...row.config === undefined ? {} : { config: row.config } }
  })
  writeFileSync(join(dir, 'cordis.yml'), yaml.dump(entries))

  const ctx = await mountBasePrerequisites()
  disposers.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // A fixed id makes the included rows addressable as `boot:<row id>`, as the Loader resolves nested entries.
  const include: EntryOptions = {
    id: 'boot', name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
  }
  await ctx.loader.create(include)
  return { ctx, composed, release }
}

/** The `isolation` parameter of the Host-level `subagent` tool, or undefined when it is absent or the tool is not mounted. */
function isolationParameter(ctx: Context): unknown {
  const schema = ctx.tools.schemas().find(candidate => candidate.name === 'subagent')
  return (schema?.parameters as { properties: Record<string, unknown> } | undefined)?.properties.isolation
}

const OFFERED = { type: 'string', enum: ['worktree'] }

describe('agent-crew rows booted through a real Loader', () => {
  it('offers isolation on the Host-level tool that mounted before the service, and follows a bundle toggle', async () => {
    const { ctx, release } = await boot([BASE(), CREW()])

    // The tool row mounts first: it does not inject the service, which is still waiting on the gate, so it
    // sees no `ctx.subagentWorktrees` and no offer.
    await vi.waitFor(() => { expect(ctx.tools.schemas().some(schema => schema.name === 'subagent')).toBe(true) })
    expect(ctx.get('subagentWorktrees')).toBeUndefined()
    expect(isolationParameter(ctx)).toBeUndefined()

    release()
    await ctx.loader.await()
    expect(ctx.get('subagentWorktrees')).toBeDefined()
    expect(isolationParameter(ctx)).toMatchObject(OFFERED)

    // Switching the bundle off is an entry update: the worktree tools' fiber is disposed and its offer withdrawn.
    await ctx.loader.update('boot:tool-subagent-worktree', { disabled: true })
    await ctx.loader.await()
    expect(isolationParameter(ctx)).toBeUndefined()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('accept_worktree')

    await ctx.loader.update('boot:tool-subagent-worktree', { disabled: false })
    await ctx.loader.await()
    expect(isolationParameter(ctx)).toMatchObject(OFFERED)
  })

  it('offers no isolation once every row is up when the bundle is not composed', async () => {
    const { ctx, composed, release } = await boot([BASE()])
    expect(rowOf(composed, 'tool-subagent-worktree')).toBeUndefined()

    release()
    await ctx.loader.await()

    expect(ctx.get('subagentWorktrees')).toBeDefined()
    expect(ctx.tools.schemas().some(schema => schema.name === 'subagent')).toBe(true)
    expect(isolationParameter(ctx)).toBeUndefined()
  })

  it('still offers isolation when a user patch replaces the service row config to pin a reviewer route', async () => {
    const { ctx, composed, release } = await boot([BASE(), CREW(), PIN_REVIEWER])
    // The user's patch replaced the service row's whole config; the bundle set nothing there to lose.
    expect(rowOf(composed, 'subagent-worktree')?.config).toEqual({ reviewerProvider: 'mock', reviewerModel: 'mock' })

    release()
    await ctx.loader.await()

    expect(isolationParameter(ctx)).toMatchObject(OFFERED)
    // The pinned route reached the booted service.
    expect(ctx.subagentWorktrees.resolveReviewer({
      workerRoute: { provider: 'worker-provider', model: 'worker-model' },
      callerRoute: { provider: 'lead-provider', model: 'lead-model' },
    })).toMatchObject({ provider: 'mock', model: 'mock' })
  })
})
