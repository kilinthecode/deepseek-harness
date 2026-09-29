import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { boundContextSummary } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import { peerDeliveryProjection } from '../src/projection.ts'
import { presencePath } from '../src/paths.ts'
import { mountPeerHarness, type PeerHarness, textScript } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

/** Plant one envelope with a chosen relay depth into a target's mailbox. */
async function plant(
  harness: PeerHarness,
  targetId: string,
  envelope: { readonly messageId: string; readonly relayDepth: number; readonly kind: 'peer-message' | 'peer-idle' },
): Promise<void> {
  const raw = await readFile(presencePath(harness.home, targetId), 'utf8')
  const { repoKey } = JSON.parse(raw) as { repoKey: string }
  await harness.plantMail(targetId, `${envelope.messageId}.json`, `${JSON.stringify({
    version: 1,
    messageId: envelope.messageId,
    targetId,
    senderSessionId: 'peer-s',
    senderName: 'peer-s',
    fromRepo: repoKey,
    relayDepth: envelope.relayDepth,
    kind: envelope.kind,
    text: 'relayed body',
  })}\n`)
}

/** Wait until one session's delivery projection records `count` applied deliveries. */
async function waitForDeliveries(harness: PeerHarness, agent: Awaited<ReturnType<PeerHarness['create']>>, count: number): Promise<void> {
  await vi.waitFor(() => {
    const state = harness.ctx.sessionProjections.stateOf(agent.session, 'peerDelivery')
    expect(state?.delivered.length).toBe(count)
  })
}

describe('relay depth', () => {
  it('refuses a further send once this session recorded a depth-four delivery', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-s')
    const target = await harness.create('peer-t')
    await plant(harness, 'peer-t', { messageId: 'peer-message-depth4', relayDepth: 4, kind: 'peer-message' })
    await waitForDeliveries(harness, target, 1)
    await target.whenIdle()
    expect(harness.ctx.sessionProjections.stateOf(target.session, 'peerDelivery')?.relayDepth['peer-s']).toBe(4)
    await expect(harness.ctx.peers.send(target, { to: 'peer-s', message: 'again' }))
      .rejects.toThrow('This peer conversation already relayed 4 times. Stop and wait for the user.')
    expect(sender.id).toBe('peer-s')
  })

  it('restarts the relay budget when the user sends a message', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    const peer = await harness.create('peer-s')
    const target = await harness.create('peer-t')
    await plant(harness, 'peer-t', { messageId: 'peer-message-depth4', relayDepth: 4, kind: 'peer-message' })
    await waitForDeliveries(harness, target, 1)
    await target.whenIdle()
    target.followup(createUserMessage({
      content: [{ type: 'text', text: 'hello from the user' }],
      source: { kind: 'user' },
    }))
    await target.whenIdle()
    expect(harness.ctx.sessionProjections.stateOf(target.session, 'peerDelivery')?.relayDepth).toEqual({})
    // The fresh budget must reach the peer rather than trip the relay limit.
    // Whether this call's own pass or a concurrent poll pass steered the
    // envelope decides between the two durable statuses, so the delivery
    // itself is asserted instead of the status word.
    const fresh = await harness.ctx.peers.send(target, { to: 'peer-s', message: 'fresh budget' })
    expect(['delivered', 'queued']).toContain(fresh.status)
    await vi.waitFor(() => { expect(harness.userMessages(peer)).toHaveLength(1) })
    // The reset restarts the budget at one hop, not merely above the bound.
    const [delivered] = harness.userMessages(peer)
    expect(delivered?.source.kind === 'peer-message' && delivered.source.relayDepth).toBe(1)
  })

  it('does not reset the mark for a message a producer other than the user appended', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    await harness.create('peer-s')
    const target = await harness.create('peer-t')
    await plant(harness, 'peer-t', { messageId: 'peer-message-depth4', relayDepth: 4, kind: 'peer-message' })
    await waitForDeliveries(harness, target, 1)
    await target.whenIdle()
    target.followup(createUserMessage({
      content: [{ type: 'text', text: 'this turn runs a schedule, not a person' }],
      source: { kind: 'schedule', summary: boundContextSummary('scheduled wake') },
    }))
    await target.whenIdle()
    await expect(harness.ctx.peers.send(target, { to: 'peer-s', message: 'not reset' }))
      .rejects.toThrow('This peer conversation already relayed 4 times. Stop and wait for the user.')
  })

  it('reports delivered for an envelope the target applied before this call lost its own record of the steer', async () => {
    // The target applies the steer and retires the in-flight mark before this
    // call's pass reaches its durability checkpoint, so the applied delivery is
    // the only surviving record that the envelope reached the target.
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-t')
    let lostCheckpoint = false
    harness.ctx.on('session/flush', async (session: Session) => {
      if (lostCheckpoint || session.id !== 'peer-t') return
      lostCheckpoint = true
      // The idle settle deletes the file only after it retired the in-flight
      // mark, so an empty shard proves this process no longer tracks the steer.
      await vi.waitFor(async () => { expect(await harness.mailFiles('peer-t')).toEqual([]) })
      throw new Error('the steer could not be checkpointed')
    })
    const result = await harness.ctx.peers.send(sender, { to: 'peer-t', message: 'applied, not self-recorded' })
    expect(lostCheckpoint).toBe(true)
    expect(harness.userMessages(target).some(message =>
      message.source.kind === 'peer-message' && message.source.messageId === result.messageId)).toBe(true)
    expect(result.status).toBe('delivered')
  })

  it('does not raise the relay depth of the delivery a notice produced', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 }, script: textScript(8) })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    await harness.create('peer-s')
    await plant(harness, 'peer-w', { messageId: 'peer-idle-depth', relayDepth: 4, kind: 'peer-idle' })
    await waitForDeliveries(harness, watcher, 1)
    await watcher.whenIdle()
    // A notice carries no budget: it neither spends nor raises a relay depth.
    expect(harness.ctx.sessionProjections.stateOf(watcher.session, 'peerDelivery')?.relayDepth).toEqual({})
  })

  it('refuses a further send from a fork whose inherited prefix already reached depth four', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    await harness.create('peer-s')
    const origin = await harness.create('peer-t')
    await plant(harness, 'peer-t', { messageId: 'peer-message-depth4', relayDepth: 4, kind: 'peer-message' })
    await waitForDeliveries(harness, origin, 1)
    await origin.whenIdle()
    // The fork inherits the whole delivered log, so the depth gating its send
    // sits below `inheritedEventCount`: only a fold over the full log sees it.
    const prefix = harness.events(origin)
    const fork = await harness.create('peer-fork', {
      meta: { isSeeded: true, parentSession: origin.id },
      seed: prefix,
      inheritedEventCount: SessionLogOffset(prefix.length),
    })
    expect(harness.ctx.sessionProjections.stateOf(fork.session, 'peerDelivery')?.relayDepth['peer-s']).toBe(4)
    await expect(harness.ctx.peers.send(fork, { to: 'peer-s', message: 'again' }))
      .rejects.toThrow('This peer conversation already relayed 4 times. Stop and wait for the user.')
  })

  it('sets the idle-turn mark from a delivered notice and clears it at turn end', async () => {
    // The first model call hangs, so the notice-opened turn is still running
    // after the notice is applied; cancellation then ends that turn.
    const harness = await mountPeerHarness({ peer: { pollMs: 10 }, script: ['hang', ...textScript(4)] })
    harnesses.push(harness)
    const watcher = await harness.create('peer-w')
    await harness.create('peer-s')
    await plant(harness, 'peer-w', { messageId: 'peer-idle-1', relayDepth: 1, kind: 'peer-idle' })
    await waitForDeliveries(harness, watcher, 1)
    await expect(harness.ctx.peers.notifyIdle(watcher, { to: 'peer-s' }))
      .rejects.toThrow('This turn was opened by an idle notice. Do not subscribe to another idle notice.')
    watcher.cancel({ kind: 'user' })
    await watcher.whenIdle()
    expect(harness.ctx.sessionProjections.stateOf(watcher.session, 'peerDelivery')?.peerIdleTurn).toBe(false)
    await expect(harness.ctx.peers.notifyIdle(watcher, { to: 'peer-s' }))
      .resolves.toMatchObject({ status: 'delivered' })
    expect(peerDeliveryProjection.key).toBe('peerDelivery')
  })
})
