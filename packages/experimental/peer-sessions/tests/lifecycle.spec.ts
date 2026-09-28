import { mkdir, readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { mailDirectory, mailShardDirectory, presencePath } from '../src/paths.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

describe('PeerService lifecycle', () => {
  it('awaits an in-flight drain, clears the poll, and unregisters the delivery projection', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    let enteredFlush = false
    harness.ctx.on('session/flush', async (session) => {
      if (session.id !== 'peer-b') return
      enteredFlush = true
      await held
    })
    const sending = harness.ctx.peers.send(sender, { to: 'peer-b', message: 'steered before dispose' })
      // This caller's own result may settle after the fiber has torn the
      // projection registry down; the test asserts quiescence, not its status.
      .catch((error: unknown) => error)
    await vi.waitFor(() => { expect(enteredFlush).toBe(true) })
    const projections = harness.ctx.sessionProjections
    const peers = harness.ctx.peers
    const peerDeliveries = (): number => harness.userMessages(target)
      .filter(message => message.source.kind === 'peer-message').length
    const pending = (): number => {
      const state = projections.stateOf(target.session, 'inbox')
      return state === undefined ? 0 : state['next-turn'].length + state['next-step'].length
    }
    let disposed = false
    const disposal = harness.ctx.fiber.dispose().then(() => { disposed = true })
    try {
      await new Promise(resolve => setTimeout(resolve, 40))
      // Disposal waits for the drain in flight instead of abandoning its steer:
      // the delivery is either pending in the target's inbox or already logged.
      expect(disposed).toBe(false)
      expect(pending() + peerDeliveries()).toBeGreaterThan(0)
    } finally {
      release()
    }
    await disposal
    expect(disposed).toBe(true)
    await sending
    expect(projections.stateOf(target.session, 'peerDelivery')).toBeUndefined()
    const before = harness.userMessages(target).length
    // A disposed service may reject or throw; either way no steer reaches the target.
    try {
      await peers.send(sender, { to: 'peer-b', message: 'after dispose' })
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error)
    }
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(harness.userMessages(target)).toHaveLength(before)
    expect(target.id).toBe('peer-b')
  })

  it('awaits a drain pass the mailbox shard lock is holding', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 5 } })
    harnesses.push(harness)
    const target = await harness.create('peer-b')
    const raw = await readFile(presencePath(harness.home, 'peer-b'), 'utf8')
    const { repoKey } = JSON.parse(raw) as { repoKey: string }
    // The lock is a sibling of the shard directory, so its parent must exist.
    await mkdir(mailDirectory(harness.home), { recursive: true, mode: 0o700 })
    // Holding the shard lock leaves the pass that steers this envelope blocked
    // in `removeEmptyShard`, so the only work keeping disposal pending is that
    // drain: the target's own teardown never touches this lock.
    const shard = mailShardDirectory(harness.home, 'peer-b')
    let release = (): void => {}
    const released = new Promise<void>((resolve) => { release = resolve })
    let entered = (): void => {}
    const acquired = new Promise<void>((resolve) => { entered = resolve })
    const held = withFileLock(shard, async () => {
      entered()
      await released
    })
    await acquired
    await harness.plantMail('peer-b', 'peer-message-held.json', `${JSON.stringify({
      version: 1,
      messageId: 'peer-message-held',
      targetId: 'peer-b',
      senderSessionId: 'peer-a',
      senderName: 'peer-a',
      fromRepo: repoKey,
      relayDepth: 1,
      kind: 'peer-message',
      text: 'steered by the blocked pass',
    })}\n`)
    const peerDeliveries = (): number => harness.userMessages(target)
      .filter(message => message.source.kind === 'peer-message').length
    // The logged delivery proves a drain pass steered this envelope, and that
    // pass cannot finish: its next step takes the shard lock this test holds.
    await vi.waitFor(() => { expect(peerDeliveries()).toBe(1) })
    let disposed = false
    const disposal = harness.ctx.fiber.dispose().then(() => { disposed = true })
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      // Disposal waits for the blocked pass instead of abandoning its steer.
      expect(disposed).toBe(false)
    } finally {
      release()
      await held
    }
    await disposal
    expect(disposed).toBe(true)
    expect(peerDeliveries()).toBe(1)
  })

  it('clears the poll interval so a planted envelope is never steered after dispose', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    const raw = await readFile(presencePath(harness.home, 'peer-b'), 'utf8')
    const { repoKey } = JSON.parse(raw) as { repoKey: string }
    await harness.ctx.fiber.dispose()
    await harness.plantMail('peer-b', 'peer-message-late.json', `${JSON.stringify({
      version: 1,
      messageId: 'peer-message-late',
      targetId: 'peer-b',
      senderSessionId: sender.id,
      senderName: 'peer-a',
      fromRepo: repoKey,
      relayDepth: 1,
      kind: 'peer-message',
      text: 'planted after dispose',
    })}\n`)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(harness.userMessages(target)).toEqual([])
    expect(await harness.mailFiles('peer-b')).toHaveLength(1)
  })
})
