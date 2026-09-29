/** The experimental peer sessions bundle must carry one parseable, explicit coordination layer. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface InsertedRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

describe('Peer sessions profile bundle', () => {
  it('declares a public parseable layer that mounts the service and its tools with the shipped limits', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      publishConfig?: { access?: string }
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-experimental-peer-sessions': 'workspace:*',
      '@deepseek-ai/dsh-experimental-tool-peer-sessions': 'workspace:*',
    })

    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const patches = parsed as { insert?: InsertedRow[] }[]
    const inserted = patches.flatMap(patch => patch.insert ?? [])
    expect(inserted.find(row => row.id === 'peer-sessions')?.name)
      .toBe('@deepseek-ai/dsh-experimental-peer-sessions')
    // The shipped caps are the service defaults spelled out, so a profile that
    // needs different limits overrides these rows instead of the package.
    expect(inserted.find(row => row.id === 'peer-sessions')?.config).toEqual({
      pollMs: 1000,
      maxPendingPerTarget: 8,
      maxPendingPerSenderPerTarget: 4,
      maxMessageBytes: 8192,
      maxIdleWatches: 32,
      peerInbound: 'steer',
    })
    // The tool row follows the service it injects, and carries no config of its own.
    expect(inserted.map(row => row.id)).toEqual(['peer-sessions', 'tool-peer-sessions'])
    expect(inserted.find(row => row.id === 'tool-peer-sessions')?.name)
      .toBe('@deepseek-ai/dsh-experimental-tool-peer-sessions')
    // Peer coordination is opt-in: the layer inserts rows and disables nothing.
    expect(patches.every(patch => Object.keys(patch).every(key => key === 'insert'))).toBe(true)
  })
})
