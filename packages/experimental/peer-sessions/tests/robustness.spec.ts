/**
 * Failure tests for the peers tree itself.
 *
 * A home whose `peers` subtree is a file instead of a directory, or whose watch
 * shard path is a file, must degrade to a warning: peer coordination can never
 * break the idle transition or the poll loop of the sessions that own it.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mailDirectory, presenceDirectory, watchShardDirectory, watchesDirectory } from '../src/paths.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

/** Replace one path with a plain file, creating its parent directory first. */
async function blockPath(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await rm(path, { recursive: true, force: true })
  await writeFile(path, 'not a directory', { mode: 0o600 })
}

describe('a peers tree that is not a tree', () => {
  it('finishes the idle transition when a watch shard path cannot be read', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const target = await harness.create('peer-t')
    await blockPath(watchShardDirectory(harness.home, 'peer-t'))
    target.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await target.whenIdle()
    expect(target.status).toBe('idle')
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(call => String(call[0]).includes('listener work failed'))).toBe(true)
    })
  })

  it('keeps polling when the watches directory cannot be read', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    await harness.create('peer-t')
    await blockPath(watchesDirectory(harness.home))
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(call => String(call[0]).includes('poll work failed'))).toBe(true)
    }, { timeout: 2_000 })
  })

  it('keeps polling when the mail directory cannot be read', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    await harness.create('peer-t')
    await blockPath(mailDirectory(harness.home))
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(call => String(call[0]).includes('poll work failed'))).toBe(true)
    }, { timeout: 2_000 })
  })

  it('reports an unreadable presence directory instead of reporting no peers', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    await blockPath(presenceDirectory(harness.home))
    // Only a missing presence directory means "no peers"; a broken one is a
    // real failure and must not read as an empty roster.
    await expect(harness.ctx.peers.list(caller)).rejects.toThrow()
  })
})
