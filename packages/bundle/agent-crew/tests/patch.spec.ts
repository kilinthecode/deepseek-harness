/** The optional agent-crew bundle switches tool-subagent to worktree isolation and adds its tools and skill. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const root = fileURLToPath(new URL('..', import.meta.url))

interface Manifest {
  name?: string
  icon?: string
  private?: boolean
  publishConfig?: { access?: string }
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

describe('agent-crew bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

  it('publishes as an optional bundle with plugin-manager display metadata', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-agent-crew')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    // Each inserted row names a package the bundle depends on, so the rows resolve from the bundle.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-skill-agent-crew', '@deepseek-ai/dsh-tool-subagent-worktree',
    ])
  })

  it('declares en and zh locale metadata with non-empty title and description', () => {
    for (const locale of ['en', 'zh']) {
      const meta = (JSON.parse(readFileSync(resolve(root, 'locale', `${locale}.json`), 'utf8')) as { meta?: { title?: string; description?: string } }).meta
      expect(meta?.title).toBeTruthy()
      expect(meta?.description).toBeTruthy()
    }
  })

  it('restates the complete tool-subagent config and switches on worktree isolation', () => {
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    if (!Array.isArray(parsed)) throw new TypeError('agent-crew patch must parse to a patch list')
    const rows = parsed as { id?: string; config?: Record<string, unknown>; insert?: { id?: string; name?: string }[] }[]
    expect(rows.find(row => row.id === 'tool-subagent')).toEqual({
      id: 'tool-subagent',
      config: {
        provider: 'spawn',
        toolName: 'subagent',
        backgroundMode: 'continuable',
        worktreeIsolation: true,
      },
    })
    const inserted = rows.flatMap(row => row.insert ?? [])
    expect(inserted).toEqual([
      { id: 'tool-subagent-worktree', name: '@deepseek-ai/dsh-tool-subagent-worktree' },
      { id: 'skill-agent-crew', name: '@deepseek-ai/dsh-skill-agent-crew' },
    ])
  })
})
