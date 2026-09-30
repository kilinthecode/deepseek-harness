import { lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { presencePath, watchShardDirectory } from '../src/paths.ts'
import { PEER_WATCH_VERSION, writeWatch } from '../src/watches.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

/** Read the repository key one watcher published, so a planted watch can carry it. */
async function publishedRepoKey(harness: PeerHarness, sessionId: string): Promise<string> {
  const raw = await readFile(presencePath(harness.home, sessionId), 'utf8')
  const { repoKey } = JSON.parse(raw) as { repoKey: string }
  return repoKey
}

/** Hold one agent's next step open until the returned release function runs. */
function gate(harness: PeerHarness, sessionId: string): () => void {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  harness.ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent.id === sessionId) await held
    return await next()
  })
  return release
}

/** Start one agent's turn so it is running while a test watches it. */
function start(agent: Awaited<ReturnType<PeerHarness['create']>>): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
}

describe('peer idle watches', () => {
  it('enqueues one notice on the idle transition and retires the watch', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    const target = await harness.create('peer-t')
    const release = gate(harness, 'peer-t')
    start(target)
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    expect((await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-t' })).status).toBe('watching')
    expect(await harness.watchFiles('peer-t')).toHaveLength(1)
    release()
    await vi.waitFor(async () => { expect(await harness.watchFiles('peer-t')).toEqual([]) })
    // The target's own process leaves exactly one notice in the watcher's
    // mailbox, and the watcher's drain delivers it.
    await vi.waitFor(() => {
      expect(harness.userMessages(watcher).map(message => message.source.kind)).toEqual(['peer-idle'])
    })
  })

  it('drains a local watcher as soon as the target goes idle', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    const target = await harness.create('peer-t')
    const release = gate(harness, 'peer-t')
    start(target)
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    expect((await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-t' })).status).toBe('watching')
    release()
    // The watcher is held by this process, so its mailbox drains on the notice
    // rather than waiting out the poll interval.
    await vi.waitFor(() => {
      expect(harness.userMessages(watcher).map(message => message.source.kind)).toEqual(['peer-idle'])
    })
  })

  it('queues the notice of a watcher another process holds', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const target = await harness.create('peer-t')
    await writeWatch(harness.home, {
      version: PEER_WATCH_VERSION,
      targetId: SessionId('peer-t'),
      watcherId: SessionId('peer-elsewhere'),
      watcherRepo: await publishedRepoKey(harness, 'peer-t'),
      watcherName: 'peer-elsewhere',
    }, 32, 'peer-t')
    const release = gate(harness, 'peer-t')
    start(target)
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    release()
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-elsewhere')).toHaveLength(1) })
    expect(await harness.watchFiles('peer-t')).toEqual([])
  })

  it('reaps a stale watch before it occupies another shard slot', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    const target = await harness.create('peer-t')
    await writeWatch(harness.home, {
      version: PEER_WATCH_VERSION,
      targetId: SessionId('peer-gone'),
      watcherId: SessionId('peer-w'),
      watcherRepo: await publishedRepoKey(harness, 'peer-w'),
      watcherName: 'peer-w',
    }, 32, 'peer-gone')
    const release = gate(harness, 'peer-t')
    start(target)
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    // The subscription path reaps the watch whose peer is gone, without a poll.
    expect((await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-t' })).status).toBe('watching')
    expect(await harness.watchFiles('peer-gone')).toEqual([])
    release()
  })

  it('delivers a notice immediately for a target that is already idle', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    await harness.create('peer-t')
    expect((await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-t' })).status).toBe('delivered')
    expect(await harness.watchFiles('peer-t')).toEqual([])
    const [message] = harness.userMessages(watcher)
    expect(message?.source.kind).toBe('peer-idle')
    expect(message?.source.kind === 'peer-idle' && message.source.senderSessionId).toBe('peer-t')
  })

  it('retires watches of a disposed target without enqueueing a notice', async () => {
    // No poll pass runs in this window, so only the disposal path can retire
    // the watch: the reaper that a missing presence row would trigger stays out.
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    const handle = await harness.createHandle('peer-t')
    // Planted as if the target were busy when the watcher subscribed, so only
    // the disposal path can retire it: an idle target emits no status change.
    await writeWatch(harness.home, {
      version: PEER_WATCH_VERSION,
      targetId: SessionId('peer-t'),
      watcherId: SessionId('peer-w'),
      watcherRepo: await publishedRepoKey(harness, 'peer-w'),
      watcherName: 'peer-w',
    }, 32, 'peer-t')
    expect(await harness.watchFiles('peer-t')).toHaveLength(1)
    await handle.dispose()
    await vi.waitFor(async () => { expect(await harness.watchFiles('peer-t')).toEqual([]) })
    expect(await harness.mailFiles('peer-w')).toEqual([])
    expect(harness.userMessages(watcher)).toEqual([])
  })

  it('reaps a watch whose target presence row is gone', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    const target = await harness.create('peer-t')
    const release = gate(harness, 'peer-t')
    try {
      start(target)
      await vi.waitFor(() => { expect(target.status).toBe('running') })
      await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-t' })
      // The running transition's publication is the only writer the service
      // still has queued; awaiting it makes the removal below the final write
      // instead of racing the coalesced publish behind it.
      await harness.ctx.peers.whenSettled()
      await rm(presencePath(harness.home, 'peer-t'), { force: true })
      // The reap this call awaits reads the row first, so it retires the watch
      // without telling anyone; only the name resolution then fails.
      await expect(harness.ctx.peers.notifyIdle(watcher, { to: 'peer-gone' }))
        .rejects.toThrow('No peer session named "peer-gone" is live in this repository.')
      expect(await harness.watchFiles('peer-t')).toEqual([])
      expect(await harness.mailFiles('peer-w')).toEqual([])
    } finally {
      release()
    }
  })

  it('reaps a watch whose target row is held by a process that cannot exist', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    const target = await harness.create('peer-t')
    const release = gate(harness, 'peer-t')
    try {
      start(target)
      await vi.waitFor(() => { expect(target.status).toBe('running') })
      await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-t' })
      // The running transition's publication is the only writer the service
      // still has queued; awaiting it makes the rewrite below the final write.
      await harness.ctx.peers.whenSettled()
      // A pid no process can hold: the same signal probe the atomic-write lock uses.
      const raw = await readFile(presencePath(harness.home, 'peer-t'), 'utf8')
      const row = JSON.parse(raw) as Record<string, unknown>
      await writeFile(presencePath(harness.home, 'peer-t'), `${JSON.stringify({ ...row, pid: 2_147_483_647 })}\n`)
      // The reap this call awaits probes the pid, retires the row it cannot
      // find alive, and then reaps the watch the row no longer backs.
      await expect(harness.ctx.peers.notifyIdle(watcher, { to: 'peer-gone' }))
        .rejects.toThrow('No peer session named "peer-gone" is live in this repository.')
      await expect(stat(presencePath(harness.home, 'peer-t'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await harness.watchFiles('peer-t')).toEqual([])
      expect(await harness.mailFiles('peer-w')).toEqual([])
    } finally {
      release()
    }
  })

  it('does not count a notice still pending in the open turn as a failed attempt', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    await harness.create('peer-t')
    const release = gate(harness, 'peer-w')
    start(watcher)
    await vi.waitFor(() => { expect(watcher.status).toBe('running') })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    expect((await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-t' })).status).toBe('delivered')
    // The notice waits in the held step, so the idle settle proves it is
    // pending rather than undeliverable, however often it runs.
    for (let report = 0; report < 3; report += 1) {
      harness.ctx.emit('agent/status', { agent: watcher, status: 'idle' })
    }
    expect(harness.pending(watcher).map(message => message.source.kind)).toEqual(['peer-idle'])
    expect(await harness.mailFiles('peer-w')).toHaveLength(1)
    expect(warn.mock.calls.some(call => String(call[0]).includes('dropped peer message'))).toBe(false)
    release()
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-w')).toEqual([]) })
  })

  it('caps new watches at maxIdleWatches while replacing an existing one', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000, maxIdleWatches: 1 } })
    harnesses.push(harness)
    const first = await harness.create('peer-a')
    const second = await harness.create('peer-b')
    const target = await harness.create('peer-t')
    const release = gate(harness, 'peer-t')
    start(target)
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    expect((await harness.ctx.peers.notifyIdle(first, { to: 'peer-t' })).status).toBe('watching')
    await expect(harness.ctx.peers.notifyIdle(second, { to: 'peer-t' }))
      .rejects.toThrow('Peer "peer-t" already has 1 idle watches.')
    expect((await harness.ctx.peers.notifyIdle(first, { to: 'peer-t' })).status).toBe('watching')
    release()
  })

  it('counts a watch shard entry that is not a record toward the cap and leaves it on reap', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10, maxIdleWatches: 2 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    const other = await harness.create('peer-x')
    const target = await harness.create('peer-t')
    const release = gate(harness, 'peer-t')
    start(target)
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    // A stray file is not a subscription, but it is still a directory entry: it
    // counts toward the cap, and reaping a retired watch leaves it in place.
    const shard = watchShardDirectory(harness.home, 'peer-t')
    await mkdir(shard, { recursive: true, mode: 0o700 })
    const stray = join(shard, 'peer-watch-notes.txt')
    await writeFile(stray, 'not a watch record\n', { mode: 0o600 })
    expect((await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-t' })).status).toBe('watching')
    expect(await harness.watchFiles('peer-t')).toHaveLength(2)
    await expect(harness.ctx.peers.notifyIdle(other, { to: 'peer-t' }))
      .rejects.toThrow('Peer "peer-t" already has 2 idle watches.')
    release()
    await vi.waitFor(async () => { expect(await harness.watchFiles('peer-t')).toEqual([stray]) }, { timeout: 2_000 })
    expect((await stat(shard)).isDirectory()).toBe(true)
  })

  it('skips a watch shard entry that vanished between the listing and the read', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    const target = await harness.create('peer-t')
    const release = gate(harness, 'peer-t')
    start(target)
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    // A dangling link named as a watch fails its read with ENOENT, which is a
    // vanished entry rather than an invalid one: the idle transition must leave
    // it alone and still notify the subscription next to it.
    const shard = watchShardDirectory(harness.home, 'peer-t')
    const vanished = join(shard, 'peer-watch-vanished.json')
    await mkdir(shard, { recursive: true, mode: 0o700 })
    // A junction is the link Windows creates without a privilege.
    await symlink(join(shard, 'gone.json'), vanished, process.platform === 'win32' ? 'junction' : 'file')
    expect((await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-t' })).status).toBe('watching')
    expect(await harness.watchFiles('peer-t')).toHaveLength(1)
    release()
    await vi.waitFor(() => {
      expect(harness.userMessages(watcher).map(message => message.source.kind)).toEqual(['peer-idle'])
    })
    // The real subscription is retired and the vanished entry stays: it is
    // neither a watch to notify nor an invalid file to delete.
    expect(await harness.watchFiles('peer-t')).toEqual([])
    expect((await readdir(shard)).includes('peer-watch-vanished.json')).toBe(true)
    expect((await lstat(vanished)).isSymbolicLink()).toBe(true)
  })
})
