import { mkdir, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as entry from '../src/index.ts'
import { framedRelay, readMailShard } from '../src/mailbox.ts'
import { mailDirectory, mailShardDirectory, watchShardDirectory } from '../src/paths.ts'
import { readPresence } from '../src/presence.ts'
import type { PeerMessageId } from '../src/types.ts'
import { mountPeerHarness, type PeerHarness, textScript } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

/** One envelope body, as a sender in `fromRepo` would have written it. */
function envelopeFor(targetId: string, messageId: string, fromRepo: string): string {
  return `${JSON.stringify({
    version: 1,
    messageId,
    targetId,
    senderSessionId: 'peer-sender',
    senderName: 'peer-sender',
    fromRepo,
    relayDepth: 1,
    kind: 'peer-message',
    text: 'planted',
  })}\n`
}

/** Repository key one created agent published, read back from its presence row. */
async function repoKeyOf(harness: PeerHarness, id: string): Promise<string> {
  const row = await readPresence(harness.home, SessionId(id))
  if (row === undefined) throw new Error(`${id} published no presence row`)
  return row.repoKey
}

describe('peer mailbox', () => {
  it('commits one envelope into the target shard through the public entry', async () => {
    const harness = await mountPeerHarness({
      peer: { maxPendingPerTarget: 8, maxPendingPerSenderPerTarget: 4 },
    })
    harnesses.push(harness)
    const messageId = brandString<PeerMessageId>('peer-msg-1')
    expect(typeof entry.enqueueMail).toBe('function')
    expect(entry.PEER_MAIL_VERSION).toBe(1)
    await entry.enqueueMail(harness.home, {
      version: entry.PEER_MAIL_VERSION,
      messageId,
      targetId: SessionId('peer-absent'),
      senderSessionId: SessionId('peer-sender'),
      senderName: 'peer-sender',
      fromRepo: 'git:/repo',
      relayDepth: 1,
      kind: 'peer-message',
      text: 'PEER_ENTRY_BODY',
    }, { maxPendingPerTarget: 8, maxPendingPerSenderPerTarget: 4 }, 'peer-absent')
    expect(await harness.mailFiles('peer-absent')).toHaveLength(1)
    const shard = await readMailShard(mailShardDirectory(harness.home, 'peer-absent'))
    expect(shard.entries).toEqual([expect.objectContaining({
      messageId,
      kind: 'peer-message',
      text: 'PEER_ENTRY_BODY',
    })])
  })

  it('enforces the per-sender and per-target caps', async () => {
    const harness = await mountPeerHarness({
      peer: { peerInbound: 'deferred', maxPendingPerTarget: 2, maxPendingPerSenderPerTarget: 1 },
    })
    harnesses.push(harness)
    const first = await harness.create('peer-a')
    const second = await harness.create('peer-b')
    await harness.create('peer-t')
    expect((await harness.ctx.peers.send(first, { to: 'peer-t', message: 'one' })).status).toBe('deferred')
    await expect(harness.ctx.peers.send(first, { to: 'peer-t', message: 'two' }))
      .rejects.toThrow('This session already has 1 pending messages for peer "peer-t".')
    expect((await harness.ctx.peers.send(second, { to: 'peer-t', message: 'three' })).status).toBe('deferred')
    await expect(harness.ctx.peers.send(second, { to: 'peer-t', message: 'four' }))
      .rejects.toThrow('Peer "peer-t" already has 2 pending messages.')
    expect(await harness.mailFiles('peer-t')).toHaveLength(2)
  })

  it('counts the framed body, one byte over a multibyte character', async () => {
    const sized = await mountPeerHarness({ peer: { peerInbound: 'deferred', maxPendingPerTarget: 8, maxPendingPerSenderPerTarget: 8 } })
    harnesses.push(sized)
    const sender = await sized.create('peer-a')
    await sized.create('peer-t')
    const first = await sized.ctx.peers.send(sender, { to: 'peer-t', message: '' })
    const shard = await readMailShard(mailShardDirectory(sized.home, 'peer-t'))
    const [envelope] = shard.entries
    if (envelope === undefined) throw new Error('no envelope was written')
    const overhead = Buffer.byteLength(framedRelay(envelope), 'utf8')
    await sized.dispose()

    const exact = await mountPeerHarness({
      peer: { peerInbound: 'deferred', maxMessageBytes: overhead + 5, maxPendingPerTarget: 8, maxPendingPerSenderPerTarget: 8 },
    })
    harnesses.push(exact)
    const caller = await exact.create('peer-a')
    await exact.create('peer-t')
    expect((await exact.ctx.peers.send(caller, { to: 'peer-t', message: 'ééx' })).status).toBe('deferred')
    await expect(exact.ctx.peers.send(caller, { to: 'peer-t', message: 'ééé' }))
      .rejects.toThrow(`Peer message exceeds ${overhead + 5} bytes.`)
    expect(first.status).toBe('deferred')
  })

  it('writes one mailbox at mode 0600 and accepts a second sender while one enqueue holds the lock', async () => {
    const harness = await mountPeerHarness({ peer: { peerInbound: 'deferred' } })
    harnesses.push(harness)
    const first = await harness.create('peer-a')
    const second = await harness.create('peer-b')
    await harness.create('peer-t')
    const shard = mailShardDirectory(harness.home, 'peer-t')
    // The lock is a sibling of the shard directory, so its parent must exist.
    await mkdir(mailDirectory(harness.home), { recursive: true, mode: 0o700 })
    // The holder releases once the contending enqueue is checked to still be
    // waiting, so no fixed hold can outlast that enqueue's lock deadline.
    let release = (): void => {}
    const released = new Promise<void>((resolve) => { release = resolve })
    let entered = (): void => {}
    const acquired = new Promise<void>((resolve) => { entered = resolve })
    const held = withFileLock(shard, async () => {
      entered()
      await released
    })
    await acquired
    let settled = false
    const sending = harness.ctx.peers.send(second, { to: 'peer-t', message: 'while locked' })
      .then((result) => {
        settled = true
        return result
      })
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      // The enqueue waits for the held lock instead of committing under it.
      expect(settled).toBe(false)
    } finally {
      // Await the holder even when the assertion fails, so no retry outlives
      // the temp tree this harness removes.
      release()
      await held
    }
    await expect(sending).resolves.toMatchObject({ status: 'deferred' })
    await harness.ctx.peers.send(first, { to: 'peer-t', message: 'after lock' })
    const files = await harness.mailFiles('peer-t')
    expect(files).toHaveLength(2)
    const mode = (await stat(files[0] ?? '')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('deletes the envelope only after the delivery reached the log', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 5 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    // Hold the running target before its step claims the inbox, so the message
    // is only a pending splice while the envelope is already on disk.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    harness.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent.id === 'peer-b') await held
      return await next()
    })
    target.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'hold the ref' })
    expect(result.status).toBe('delivered')
    const peerDeliveries = (): readonly unknown[] => harness.userMessages(target)
      .filter(message => message.source.kind === 'peer-message')
    expect(peerDeliveries()).toEqual([])
    expect(await harness.mailFiles('peer-b')).toHaveLength(1)
    release()
    await vi.waitFor(() => { expect(peerDeliveries()).toHaveLength(1) })
    expect(harness.userMessages(target).some(message =>
      message.source.kind === 'peer-message' && message.source.messageId === result.messageId)).toBe(true)
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-b')).toEqual([]) })
    await expect(stat(mailShardDirectory(harness.home, 'peer-b'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enqueues while a poll pass is removing an empty shard', async () => {
    // A coarse poll keeps the removal attempts queued behind the held lock few,
    // so the enqueue waiting with them acquires the lock instead of starving.
    const harness = await mountPeerHarness({ peer: { pollMs: 20, peerInbound: 'deferred' } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    await harness.create('peer-t')
    const shard = mailShardDirectory(harness.home, 'peer-t')
    await mkdir(mailDirectory(harness.home), { recursive: true, mode: 0o700 })
    // The removal attempt blocks on this lock; the holder is released once the
    // checks below have run, never after a fixed hold a loaded machine could
    // stretch past the waiting enqueue's lock deadline.
    let release = (): void => {}
    const released = new Promise<void>((resolve) => { release = resolve })
    let entered = (): void => {}
    const acquired = new Promise<void>((resolve) => { entered = resolve })
    const held = withFileLock(shard, async () => {
      entered()
      await released
    })
    await acquired
    // A watch file that is not a record makes the first poll pass observable:
    // the pass deletes it while reaping, right before it removes the empty mail
    // shards below.
    const watchShard = watchShardDirectory(harness.home, 'peer-a')
    await mkdir(watchShard, { recursive: true, mode: 0o700 })
    await writeFile(join(watchShard, 'peer-watch-garbage.json'), '{ not a watch record', { mode: 0o600 })
    await vi.waitFor(async () => { expect(await harness.watchFiles('peer-a')).toEqual([]) })
    // The empty shard appears under the held lock, so the pass removing it
    // cannot be one that ran before the lock was taken.
    await mkdir(shard, { recursive: true, mode: 0o700 })
    let settled = false
    const sending = harness.ctx.peers.send(sender, { to: 'peer-t', message: 'raced' })
      .then((result) => {
        settled = true
        return result
      })
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      // A poll pass may not delete the shard an enqueue is about to write into,
      // and the enqueue cannot commit under the lock the removal holds.
      expect((await stat(shard)).isDirectory()).toBe(true)
      expect(settled).toBe(false)
    } finally {
      release()
      await held
    }
    await expect(sending).resolves.toMatchObject({ status: 'deferred' })
    expect(await harness.mailFiles('peer-t')).toHaveLength(1)
  })

  it('does not steer the same envelope twice when a second pass runs mid-flight', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 5 }, script: textScript(32) })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    harness.ctx.on('session/flush', async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
    const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'once' })
    await target.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 40))
    const delivered = harness.userMessages(target).filter(message => message.source.kind === 'peer-message')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.source.kind === 'peer-message' && delivered[0].source.messageId).toBe(result.messageId)
  })

  it('does not steer an envelope the target step already claimed', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 5 }, script: textScript(32) })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    // The step claims the splice before its first await, so a pass inside the
    // pre-step window sees a message that is neither pending nor delivered.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    let reachedPreStep = (): void => {}
    const inPreStep = new Promise<void>((resolve) => { reachedPreStep = resolve })
    harness.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent.id !== 'peer-b') return await next()
      reachedPreStep()
      await held
      return await next()
    })
    const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'once' })
    await inPreStep
    await new Promise(resolve => setTimeout(resolve, 40))
    release()
    await target.whenIdle()
    const delivered = harness.userMessages(target).filter(message => message.source.kind === 'peer-message')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.source.kind === 'peer-message' && delivered[0].source.messageId).toBe(result.messageId)
  })

  it('keeps an envelope whose delivery is only pending in the open turn', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 5 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    // Hold the step that claimed its own work message: a peer envelope steered
    // during that step waits in the next-turn queue, spliced but unclaimed.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    let reachedStep = (): void => {}
    const inStep = new Promise<void>((resolve) => { reachedStep = resolve })
    harness.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent.id !== 'peer-b') return await next()
      reachedStep()
      await held
      return await next()
    })
    target.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await inStep
    // A second queued user message keeps the inbox non-peer while the pass runs,
    // so the pending check compares a message that is not a peer envelope.
    target.followup(createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } }))
    try {
      const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'pending splice' })
      expect(result.status).toBe('delivered')
      // Passes run while the splice waits for the next step. A pending delivery is
      // not a delivery, and this file is the only copy a cancellation could lose.
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(await harness.mailFiles('peer-b')).toEqual([expect.stringContaining(`${result.messageId}.json`)])
    } finally {
      release()
    }
    await target.whenIdle()
  })

  it('keeps an envelope whose waking steer the target aborted before the step delivered it', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 25 }, script: textScript(8) })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    // The wake claims the splice before the pre-step waterfall runs, so an
    // abort inside that window consumes it without logging a delivery and
    // without a discarded-splice event.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    let reachedStep = (): void => {}
    const inStep = new Promise<void>((resolve) => { reachedStep = resolve })
    harness.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent.id !== 'peer-b') return await next()
      reachedStep()
      await held
      return await next()
    })
    const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'cancel me' })
    expect(result.status).toBe('delivered')
    await inStep
    target.cancel({ kind: 'user' })
    const peerMessages = (): readonly UserMessage[] => harness.userMessages(target)
      .filter(message => message.source.kind === 'peer-message')
    const canceled = harness.events(target).some(event =>
      event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')
    expect(canceled).toBe(false)
    expect(peerMessages()).toEqual([])
    // The aborted attempt delivered nothing, so the only copy of the body must
    // still be on disk for the next drain.
    expect(await harness.mailFiles('peer-b')).toEqual([expect.stringContaining(`${result.messageId}.json`)])
    release()
    await target.whenIdle()
    // The next drain steers it exactly once, and that delivery retires the file.
    await vi.waitFor(() => { expect(peerMessages()).toHaveLength(1) })
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-b')).toEqual([]) })
  })

  it('drops an envelope after three undeliverable attempts and warns once', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 }, script: textScript(8) })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    const pusher = await harness.create('peer-c')
    harness.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent.id === 'peer-b') return { kind: 'reject' as const }
      return await next()
    })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'reject me' })
    expect(result.status).toBe('delivered')
    const kept = [expect.stringContaining(`${result.messageId}.json`)]
    /** Whether the target's shard still holds this envelope. */
    const holdsEnvelope = async (): Promise<boolean> => (await harness.mailFiles('peer-b'))
      .some(file => file.endsWith(`${result.messageId}.json`))
    /** One further drain of the target's mailbox, which steers the envelope again. */
    const drain = async (message: string): Promise<void> => {
      await harness.ctx.peers.send(pusher, { to: 'peer-b', message })
      await new Promise(resolve => setTimeout(resolve, 60))
    }
    // Attempt one: the rejected step consumed the splice, and the settle kept the
    // only copy. Two more steers spend the remaining attempts.
    await target.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(await harness.mailFiles('peer-b')).toEqual(kept)
    await drain('second attempt')
    expect(await holdsEnvelope()).toBe(true)
    await drain('third attempt')
    await vi.waitFor(async () => { expect(await holdsEnvelope()).toBe(false) }, { timeout: 2_000 })
    expect(harness.userMessages(target)).toEqual([])
    expect(warn.mock.calls.filter(call => String(call[0]).includes(`dropped peer message "${result.messageId}"`)))
      .toHaveLength(1)
  })

  it('leaves the envelope in place when the delivery cannot be checkpointed', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    // Hold the running step so the steered splice stays pending, then fail the
    // durability checkpoint of that steer.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    harness.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent.id === 'peer-b') await held
      return await next()
    })
    target.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    let failFlush = true
    harness.ctx.on('session/flush', (session: Session) => {
      if (session.id === 'peer-b' && failFlush) throw new Error('flush failed')
    })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'durable?' })
    // A steer whose checkpoint failed did not deliver: the caller is told the
    // envelope is still queued, and the next pass may steer it again.
    expect(result.status).toBe('queued')
    expect(warn.mock.calls.some(call => String(call[0]).includes('failed'))).toBe(true)
    // A checkpoint failure must not delete a body the log never accepted.
    expect(await harness.mailFiles('peer-b')).toHaveLength(1)
    expect(harness.userMessages(target).some(message => message.source.kind === 'peer-message')).toBe(false)
    failFlush = false
    release()
    await vi.waitFor(() => {
      expect(harness.userMessages(target).some(message => message.source.kind === 'peer-message')).toBe(true)
    })
  })

  it('counts a file that is not an envelope toward the target cap', async () => {
    const harness = await mountPeerHarness({ peer: { maxPendingPerTarget: 2, maxPendingPerSenderPerTarget: 2 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    await harness.create('peer-t')
    await harness.plantMail('peer-t', 'notes.txt', 'not an envelope')
    await harness.plantMail('peer-t', 'peer-message-garbage.json', '{ not an envelope')
    // Every directory entry counts toward the cap, readable as an envelope or not.
    await expect(harness.ctx.peers.send(sender, { to: 'peer-t', message: 'one' }))
      .rejects.toThrow('Peer "peer-t" already has 2 pending messages.')
  })

  it('deletes an unreadable envelope without delivering it and leaves a foreign file alone', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-t')
    const garbage = await harness.plantMail('peer-t', 'peer-message-garbage.json', '{ not an envelope')
    const foreign = await harness.plantMail('peer-t', 'notes.txt', 'not an envelope')
    const result = await harness.ctx.peers.send(sender, { to: 'peer-t', message: 'the readable one' })
    await vi.waitFor(() => { expect(harness.userMessages(target)).toHaveLength(1) })
    const [message] = harness.userMessages(target)
    expect(message?.source.kind === 'peer-message' && message.source.messageId).toBe(result.messageId)
    expect(await harness.mailFiles('peer-t')).not.toContain(garbage)
    expect(await harness.mailFiles('peer-t')).toContain(foreign)
  })

  it('warns with the envelope id and the schema reason when it deletes an invalid file', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-t')
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    // Valid JSON that fails the envelope schema: the drop is reported by the id
    // its file name carries, and the body a peer wrote is never quoted.
    const stale = await harness.plantMail('peer-t', 'peer-message-stale.json', `${JSON.stringify({
      version: 2,
      messageId: 'peer-message-stale',
      targetId: 'peer-t',
      senderSessionId: 'peer-a',
      senderName: 'peer-a',
      fromRepo: 'git:/repo',
      relayDepth: 1,
      kind: 'peer-message',
      text: 'the only copy of this body',
    })}\n`)
    const result = await harness.ctx.peers.send(sender, { to: 'peer-t', message: 'the readable one' })
    await vi.waitFor(() => { expect(harness.userMessages(target)).toHaveLength(1) })
    const [message] = harness.userMessages(target)
    expect(message?.source.kind === 'peer-message' && message.source.messageId).toBe(result.messageId)
    expect(await harness.mailFiles('peer-t')).not.toContain(stale)
    const lines = warn.mock.calls.map(call => String(call[0]))
    expect(lines.filter(line => line.includes('peer-message-stale')))
      .toEqual(['peer-sessions: dropped envelope "peer-message-stale" for peer "peer-t": it does not satisfy the envelope schema'])
    expect(lines.filter(line => line.includes('the only copy of this body'))).toEqual([])
  })

  it('skips a mailbox entry that vanished between the listing and the read', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-t')
    // A dangling link named as an envelope fails its read with ENOENT, which is
    // a vanished entry rather than an invalid one: the pass must leave it alone
    // and still steer the envelope next to it.
    const shard = mailShardDirectory(harness.home, 'peer-t')
    const vanished = join(shard, 'peer-message-vanished.json')
    await mkdir(shard, { recursive: true, mode: 0o700 })
    // A junction is the link Windows creates without a privilege.
    await symlink(join(shard, 'gone.json'), vanished, process.platform === 'win32' ? 'junction' : 'file')
    const result = await harness.ctx.peers.send(sender, { to: 'peer-t', message: 'the readable one' })
    await vi.waitFor(() => { expect(harness.userMessages(target)).toHaveLength(1) })
    const [message] = harness.userMessages(target)
    expect(message?.source.kind === 'peer-message' && message.source.messageId).toBe(result.messageId)
    expect((await readdir(shard)).includes('peer-message-vanished.json')).toBe(true)
  })

  it('deletes an envelope addressed to another session', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-t')
    const repoKey = await repoKeyOf(harness, 'peer-t')
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const misaddressed = await harness.plantMail(
      'peer-t',
      'peer-message-misaddressed.json',
      envelopeFor('peer-other', 'peer-message-misaddressed', repoKey),
    )
    const result = await harness.ctx.peers.send(sender, { to: 'peer-t', message: 'the addressed one' })
    await vi.waitFor(() => { expect(harness.userMessages(target)).toHaveLength(1) })
    const [message] = harness.userMessages(target)
    expect(message?.source.kind === 'peer-message' && message.source.messageId).toBe(result.messageId)
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-t')).not.toContain(misaddressed) })
    expect(warn.mock.calls.map(call => String(call[0])))
      .toContain('peer-sessions: dropped envelope "peer-message-misaddressed" for peer "peer-t": it names another session as its target')
  })

  it('does not count a still-pending splice as a failed delivery attempt', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const repoKey = await repoKeyOf(harness, sender.id)
    await harness.plantMail('peer-t', 'peer-message-pending.json', envelopeFor('peer-t', 'peer-message-pending', repoKey))
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    // Idle reports inside the creation maintenance window: the drain already
    // latched the splice, so the message is pending and not yet a logged
    // delivery. A pending splice is not a failed attempt.
    harness.ctx.on('agent/created', ({ agent }) => {
      if (agent.id !== 'peer-t') return
      for (let report = 0; report < 3; report += 1) {
        harness.ctx.emit('agent/status', { agent, status: 'idle' })
      }
    })
    const target = await harness.create('peer-t')
    await vi.waitFor(() => {
      expect(harness.userMessages(target).map(message => message.source.kind)).toEqual(['peer-message'])
    })
    expect(warn.mock.calls.filter(call => String(call[0]).includes('dropped peer message'))).toEqual([])
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-t')).toEqual([]) })
  })

  it('drops a replayed envelope the target already applied', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 }, script: textScript(16) })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-t')
    const first = await harness.ctx.peers.send(sender, { to: 'peer-t', message: 'once' })
    await target.whenIdle()
    const repoKey = await repoKeyOf(harness, 'peer-t')
    await harness.plantMail('peer-t', `${first.messageId}.json`, envelopeFor('peer-t', first.messageId, repoKey))
    await harness.ctx.peers.send(sender, { to: 'peer-t', message: 'again' })
    await target.whenIdle()
    const relayed = harness.userMessages(target).filter(message => message.source.kind === 'peer-message')
    expect(relayed.map(message => message.source.kind === 'peer-message' && message.source.messageId))
      .toEqual([first.messageId, expect.any(String)])
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-t')).toEqual([]) })
  })

  it('leaves an existing envelope alone when a new enqueue fails inside the shard lock', async () => {
    const harness = await mountPeerHarness({ peer: { peerInbound: 'deferred' } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    await harness.create('peer-t')
    await harness.ctx.peers.send(sender, { to: 'peer-t', message: 'kept' })
    const [existing] = await harness.mailFiles('peer-t')
    if (existing === undefined) throw new Error('no envelope was written')
    // A directory named like an envelope makes the shard reading the enqueue
    // runs under its lock fail (EISDIR) before it can write its own entry.
    await mkdir(`${mailShardDirectory(harness.home, 'peer-t')}/peer-message-blocked.json`, { recursive: true, mode: 0o700 })
    await expect(harness.ctx.peers.send(sender, { to: 'peer-t', message: 'second' }))
      .rejects.toMatchObject({ code: 'EISDIR' })
    expect(await harness.mailFiles('peer-t')).toEqual([existing])
  })

  it('deletes a planted envelope whose message id could name a path outside the shard', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-t')
    const repoKey = await repoKeyOf(harness, 'peer-t')
    // The id names the envelope file, so a hand-planted id that walks out of the
    // shard must fail the envelope schema instead of steering a delivery whose
    // later delete resolves to another file.
    await harness.plantMail('peer-t', 'escape.json', envelopeFor('peer-t', '../../presence/peer-a', repoKey))
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-t')).toEqual([]) })
    expect(harness.userMessages(target)).toEqual([])
    expect(await readPresence(harness.home, sender.id)).toBeDefined()
  })
})
