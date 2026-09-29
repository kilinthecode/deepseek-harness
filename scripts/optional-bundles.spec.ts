/** Every bundle the installation ships switched off composes over the shipped Web layers and carries display metadata. */

import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadOverlayPatches } from '../packages/boot/app-boot/src/index.ts'
import { readPluginMeta } from '../packages/boot/app-boot/src/package-meta.ts'
import { OPTIONAL_BUNDLES, bundlePatchPaths, composeEntries } from '../packages/boot/app-boot/src/profile.ts'
import type { DshBundleManifest } from '../packages/util/package-manifest/src/types.ts'

const root = resolve(import.meta.dirname, '..')

interface Manifest {
  name: string
  dsh?: { bundle?: DshBundleManifest }
}

const bundles = new Map(globSync('packages/*/*/package.json', { cwd: root }).map((path) => {
  const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Manifest
  return [manifest.name, { dir: dirname(resolve(root, path)), manifest }]
}))

function bundle(name: string): { dir: string; patches: ReturnType<typeof loadOverlayPatches> } {
  const entry = bundles.get(name)
  if (entry?.manifest.dsh?.bundle === undefined) throw new Error(`${name} is not a workspace bundle`)
  return { dir: entry.dir, patches: bundlePatchPaths(entry.dir, entry.manifest.dsh.bundle).flatMap(path => loadOverlayPatches('test', path)) }
}

describe('optional bundles', () => {
  const shipped = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].map(name => bundle(name).patches)

  it('ships at least one bundle switched off', () => {
    expect(OPTIONAL_BUNDLES.length).toBeGreaterThan(0)
  })

  it('keeps the Inspector out of the default plugin list', () => {
    expect(OPTIONAL_BUNDLES).not.toContain('@deepseek-ai/dsh-experimental-inspector')
  })

  it.each(OPTIONAL_BUNDLES)('%s composes over the Web profile without a skipped patch', (name) => {
    const { patches } = bundle(name)
    const warnings: string[] = []
    const composed = composeEntries([...shipped, patches], message => warnings.push(message))
    const ids = new Set(composed.map(entry => entry.id))
    expect(warnings).toEqual([])
    // Inserted rows carry stable ids at the profile root, so a later profile patch can configure or disable them.
    for (const row of patches.flatMap(patch => patch.insert ?? [])) {
      expect(typeof row.id).toBe('string')
      expect(ids.has(row.id)).toBe(true)
    }
    // One top-level row per id: a duplicate declaration leaves the Loader with the last one, silently
    // replacing the layer that declared the id first.
    const topLevelIds = composed.flatMap(entry => typeof entry.id === 'string' ? [entry.id] : [])
    expect(topLevelIds).toHaveLength(new Set(topLevelIds).size)
    // An id-targeted patch reaches a row another layer inserted: the id resolves to exactly one top-level
    // row, and the override keeps the package the shipped layer declared on it.
    const shippedComposed = composeEntries([...shipped])
    for (const patch of patches) {
      if (patch.insert !== undefined || typeof patch.id !== 'string') continue
      const matches = composed.filter(entry => entry.id === patch.id)
      expect(matches).toHaveLength(1)
      expect(matches[0]?.name).toBe(shippedComposed.find(entry => entry.id === patch.id)?.name)
    }
  })

  it('adds the Agent crew worktree tools, which offer isolation, to every shipped profile shape and leaves the service and tool rows alone', () => {
    const { patches } = bundle('@deepseek-ai/dsh-agent-crew')
    const profiles = {
      web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
      sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
      acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
    }
    for (const [profile, names] of Object.entries(profiles)) {
      const layers = names.map(name => bundle(name).patches)
      const without = composeEntries(layers)
      const withCrew = composeEntries([...layers, patches])
      const rowOf = (entries: typeof withCrew, id: string) => entries.find(entry => entry.id === id)

      // The worktree tools' row registers the offer, so the bundle patches neither the service row nor a
      // delegation tool row: Host-level rows (headless, sdk, acp) and the preset-owned rows on Web are as shipped.
      for (const id of ['subagent-worktree', 'tool-subagent', 'tool-subagent-fork']) {
        expect(rowOf(withCrew, id), `${profile} ${id}`).toEqual(rowOf(without, id))
      }
      expect(rowOf(without, 'subagent-worktree')?.config, profile).toBeUndefined()
      expect(rowOf(without, 'tool-subagent-worktree'), profile).toBeUndefined()
      expect(rowOf(withCrew, 'tool-subagent-worktree'), profile).toEqual({
        id: 'tool-subagent-worktree', name: '@deepseek-ai/dsh-tool-subagent-worktree',
      })
    }
    // A base-backed profile mounts the Host-level `subagent` row, which the offer reaches.
    const headless = composeEntries([...profiles.headless.map(name => bundle(name).patches), patches])
    expect(headless.find(entry => entry.id === 'tool-subagent')?.disabled).toBeUndefined()
  })

  it('keeps the Agent crew worktree tools when a profile patch replaces the service row config to pin a reviewer route', () => {
    const { patches } = bundle('@deepseek-ai/dsh-agent-crew')
    const layers = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'].map(name => bundle(name).patches)
    // The documented way to pin the reviewer is a patch on the service row, which replaces that row's whole config.
    const pinReviewer = [{ id: 'subagent-worktree', config: { reviewerProvider: 'p', reviewerModel: 'm' } }]
    const composed = composeEntries([...layers, patches, pinReviewer])

    expect(composed.find(entry => entry.id === 'subagent-worktree')?.config).toEqual({
      reviewerProvider: 'p', reviewerModel: 'm',
    })
    // The offer is registered by the worktree tools' row, not read from the service config, so it stands.
    expect(composed.find(entry => entry.id === 'tool-subagent-worktree')).toEqual({
      id: 'tool-subagent-worktree', name: '@deepseek-ai/dsh-tool-subagent-worktree',
    })
  })

  it('adds the three Schedule rows the shipped Web composition leaves out', () => {
    const { patches } = bundle('@deepseek-ai/dsh-experimental-schedule-bundle')
    const scheduleRows = (entries: ReturnType<typeof composeEntries>) =>
      entries.filter(entry => ['time-context', 'schedule', 'ui-schedule'].includes(entry.id))
    expect(scheduleRows(composeEntries(shipped))).toEqual([])
    expect(scheduleRows(composeEntries([...shipped, patches]))).toEqual([
      { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
      { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
      { id: 'ui-schedule', name: '@deepseek-ai/dsh-client-ui-schedule' },
    ])
  })

  it.each(OPTIONAL_BUNDLES)('%s resolves a title, description, and icon in both shipped languages', (name) => {
    const meta = readPluginMeta(name, pathToFileURL(`${bundle(name).dir}/package.json`).href)
    expect(meta?.error).toBeUndefined()
    for (const field of [meta?.title, meta?.description]) {
      expect(typeof field).toBe('object')
      for (const language of ['en', 'zh']) expect((field as Record<string, string>)[language]).toMatch(/\S/)
    }
    expect(meta?.icon).toMatch(/^data:image\//)
  })
})
