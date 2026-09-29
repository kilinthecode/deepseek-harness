import { spawnSync } from 'node:child_process'
import { readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { presenceDirectory, presencePath, sha256Hex } from '../src/paths.ts'
import { mountPeerHarness, readPresenceRows, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

/** One presence row body with the fields a reader validates. */
function rowBody(options: {
  readonly sessionId: string
  readonly repoKey: string
  readonly cwd: string
  readonly name: string
  readonly pid: number
}): string {
  return `${JSON.stringify({
    version: 1,
    sessionId: options.sessionId,
    repoKey: options.repoKey,
    cwd: options.cwd,
    name: options.name,
    status: 'idle',
    pid: options.pid,
  })}\n`
}

/** The repository key the harness workdir resolves to, read from the caller's own row. */
async function repoKeyOf(harness: PeerHarness): Promise<string> {
  const rows = await readPresenceRows(harness.home)
  const row = rows[0]?.body
  if (row === undefined || typeof row !== 'object' || row === null) throw new Error('no presence row published')
  const { repoKey } = row as { repoKey?: unknown }
  if (typeof repoKey !== 'string') throw new Error('presence row carried no repo key')
  return repoKey
}

describe('peer presence', () => {
  it.skipIf(process.platform === 'win32')('unlists and unlinks a row whose process exited', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const repoKey = await repoKeyOf(harness)
    const exited = spawnSync(process.execPath, ['-e', ''])
    const pid = exited.pid
    if (pid === undefined) throw new Error('spawn produced no pid')
    const file = presencePath(harness.home, 'peer-dead')
    await writeFile(file, rowBody({
      sessionId: 'peer-dead',
      repoKey,
      cwd: harness.workdir,
      name: 'peer-dead',
      pid,
    }))
    expect((await harness.ctx.peers.list(caller)).map(peer => peer.id)).toEqual([])
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('keeps a row whose pid exists under another user', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const repoKey = await repoKeyOf(harness)
    const file = presencePath(harness.home, 'peer-root')
    await writeFile(file, rowBody({
      sessionId: 'peer-root',
      repoKey,
      cwd: harness.workdir,
      name: 'peer-root',
      pid: 1,
    }))
    expect((await harness.ctx.peers.list(caller)).map(peer => peer.id)).toEqual(['peer-root'])
    await expect(readFile(file, 'utf8')).resolves.toContain('peer-root')
  })

  it('keeps a live pid however old the row is', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const repoKey = await repoKeyOf(harness)
    const file = presencePath(harness.home, 'peer-old')
    await writeFile(file, rowBody({
      sessionId: 'peer-old',
      repoKey,
      cwd: harness.workdir,
      name: 'peer-old',
      pid: process.pid,
    }))
    const ancient = new Date(Date.now() - 365 * 24 * 60 * 60 * 1_000)
    await utimes(file, ancient, ancient)
    expect((await harness.ctx.peers.list(caller)).map(peer => peer.id)).toEqual(['peer-old'])
  })

  it('skips a row this build cannot read', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    await writeFile(presencePath(harness.home, 'peer-broken'), '{"version":9,"sessionId":"peer-broken"}\n')
    expect(await harness.ctx.peers.list(caller)).toEqual([])
  })

  it('lists nothing from a home without a presence directory and skips entries that are not rows', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const repoKey = await repoKeyOf(harness)
    const directory = presenceDirectory(harness.home)
    await writeFile(join(directory, 'notes.txt'), 'not a row')
    await writeFile(join(directory, 'peer-notjson'), 'not named as a row')
    await writeFile(presencePath(harness.home, 'peer-b'), rowBody({
      sessionId: 'peer-b',
      repoKey,
      cwd: harness.workdir,
      name: 'peer-b',
      pid: process.pid,
    }))
    expect((await harness.ctx.peers.list(caller)).map(peer => peer.id)).toEqual(['peer-b'])
    // A home this process never published into has no presence directory at all.
    await rm(directory, { recursive: true, force: true })
    expect(await harness.ctx.peers.list(caller)).toEqual([])
  })

  it('renames a peer to its logged title and falls back to the session id for an empty one', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const peer = await harness.create('peer-b')
    peer.session.append('session/title', { title: 'reviewer', messageSeqs: [], source: { kind: 'user' } })
    await vi.waitFor(async () => {
      expect((await harness.ctx.peers.list(caller)).map(entry => entry.name)).toEqual(['reviewer'])
    })
    peer.session.append('session/title', { title: '', messageSeqs: [], source: { kind: 'user' } })
    await vi.waitFor(async () => {
      expect((await harness.ctx.peers.list(caller)).map(entry => entry.name)).toEqual(['peer-b'])
    })
    expect(harness.ctx.sessionProjections.stateOf(peer.session, 'title')).toBe('')
  })

  it('removes the row of a session disposed while its rename write is still queued', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const peer = await harness.create('peer-b')
    // The rename queues a row write; the disposal that follows synchronously
    // must land after it, or the queued write recreates the removed row and
    // peers keep seeing a session this process no longer holds.
    peer.session.append('session/title', { title: 'renamed', messageSeqs: [], source: { kind: 'user' } })
    harness.ctx.emit('agent/disposed', { agent: peer })
    await vi.waitFor(async () => {
      expect((await readPresenceRows(harness.home)).map(row => row.name)).toEqual([`${sha256Hex('peer-a')}.json`])
    })
    expect((await harness.ctx.peers.list(caller)).map(entry => entry.id)).toEqual([])
  })

  it('publishes nothing when a session that is not an addressable peer logs a title', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const subagent = await harness.create('peer-sub', { meta: { origin: 'subagent' } })
    const dirless = await harness.create('peer-gone', { cwd: null })
    subagent.session.append('session/title', { title: 'worker', messageSeqs: [], source: { kind: 'user' } })
    dirless.session.append('session/title', { title: 'dirless', messageSeqs: [], source: { kind: 'user' } })
    expect((await harness.ctx.peers.list(caller)).map(entry => entry.id)).toEqual([])
    // The disposer awaits every queued presence operation, so a row for an
    // unaddressable session cannot merely be late; a session without a location
    // could not produce one at all.
    await harness.ctx.fiber.dispose()
    expect(warn.mock.calls.some(call => String(call[0]).includes('publishing presence'))).toBe(false)
    expect((await readPresenceRows(harness.home)).map(row => row.name)).toEqual([`${sha256Hex('peer-a')}.json`])
  })

  it('publishes no provider or model for an agent created without them', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    await harness.create('peer-b', { agentOptions: {} })
    const [entry] = await harness.ctx.peers.list(caller)
    expect(entry).toEqual({
      kind: 'session',
      id: 'peer-b',
      name: 'peer-b',
      status: 'idle',
      cwd: harness.workdir,
    })
  })

  it('publishes nothing for a session whose working directory does not exist', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    await harness.create('peer-gone', { cwd: join(harness.workdir, 'missing') })
    expect(await readPresenceRows(harness.home)).toEqual([])
  })

  it('names a peer by its session id while the title projection records no title', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    await harness.create('peer-b')
    const [entry] = await harness.ctx.peers.list(caller)
    expect(entry).toEqual({
      kind: 'session',
      id: 'peer-b',
      name: 'peer-b',
      status: 'idle',
      cwd: harness.workdir,
      provider: 'mock',
      model: 'mock',
    })
  })

  it('publishes the row at mode 0600 under a directory at mode 0700', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    await harness.create('peer-a')
    const file = presencePath(harness.home, 'peer-a')
    const { stat } = await import('node:fs/promises')
    const fileMode = (await stat(file)).mode & 0o777
    const directoryMode = (await stat(file.slice(0, file.lastIndexOf('/')))).mode & 0o777
    expect(fileMode).toBe(0o600)
    expect(directoryMode).toBe(0o700)
    const rows = await readPresenceRows(harness.home)
    expect(rows.map(row => row.name)).toEqual([`${sha256Hex('peer-a')}.json`])
  })
})
