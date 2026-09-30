import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mailShardDirectory, presencePath } from '../src/paths.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'
import { readFile } from 'node:fs/promises'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

/** Read the repository key the caller published, so a planted envelope can match it. */
async function publishedRepoKey(harness: PeerHarness, sessionId: string): Promise<string> {
  const raw = await readFile(presencePath(harness.home, sessionId), 'utf8')
  const { repoKey } = JSON.parse(raw) as { repoKey: string }
  return repoKey
}

/** Plant one envelope into a target's mailbox shard. */
async function plantEnvelope(
  harness: PeerHarness,
  targetId: string,
  envelope: Record<string, unknown>,
): Promise<void> {
  await harness.plantMail(targetId, `${String(envelope.messageId)}.json`, `${JSON.stringify(envelope)}\n`)
}

describe('peer authorization', () => {
  it('refuses the caller’s own session, a subagent, and a delegate', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    await harness.create('peer-sub', { meta: { origin: 'subagent' } })
    await harness.create('peer-deep', { meta: { delegationDepth: 1 } })
    await expect(harness.ctx.peers.send(caller, { to: 'peer-a', message: 'hi' }))
      .rejects.toThrow('You cannot message your own session.')
    await expect(harness.ctx.peers.send(caller, { to: 'peer-sub', message: 'hi' }))
      .rejects.toThrow('Only top-level sessions in this repository can message each other.')
    await expect(harness.ctx.peers.send(caller, { to: 'peer-deep', message: 'hi' }))
      .rejects.toThrow('Only top-level sessions in this repository can message each other.')
  })

  it('refuses the display name only the caller itself carries', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const caller = await harness.create('peer-caller')
    // A title that differs from the session id makes the name addressable
    // without the id form, so only the name check can refuse this send.
    caller.session.append('session/title', { title: 'named-self', messageSeqs: [], source: { kind: 'user' } })
    await vi.waitFor(() => {
      expect(harness.ctx.sessionProjections.stateOf(caller.session, 'title')).toBe('named-self')
    })
    await expect(harness.ctx.peers.send(sender, { to: 'named-self', message: 'name me' }))
      .resolves.toMatchObject({ status: 'delivered' })
    await expect(harness.ctx.peers.send(caller, { to: 'named-self', message: 'hi' }))
      .rejects.toThrow('You cannot message your own session.')
  })

  it('refuses a caller’s own published name before a peer elsewhere carries it too', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const elsewhere = await harness.makeDirectory('other-repo')
    const remote = await harness.create('peer-other', { cwd: elsewhere })
    remote.session.append('session/title', { title: 'shared', messageSeqs: [], source: { kind: 'user' } })
    caller.session.append('session/title', { title: 'shared', messageSeqs: [], source: { kind: 'user' } })
    /** The display name one session published in its presence row. */
    const publishedName = async (sessionId: string): Promise<string> => {
      const raw = await readFile(presencePath(harness.home, sessionId), 'utf8')
      return (JSON.parse(raw) as { name: string }).name
    }
    await vi.waitFor(async () => { expect(await publishedName('peer-other')).toBe('shared') })
    await vi.waitFor(async () => { expect(await publishedName('peer-a')).toBe('shared') })
    // A session's own name is not an address at all, so it is a self-address
    // before it is a name that another repository happens to share: the caller
    // is never admitted against itself, and never told about the wrong peer.
    await expect(harness.ctx.peers.send(caller, { to: 'shared', message: 'hi' }))
      .rejects.toThrow('You cannot message your own session.')
  })

  it('accepts a depth-zero fork that records a parent session', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const fork = await harness.create('peer-fork', { meta: { parentSession: SessionId('peer-a'), delegationDepth: 0 } })
    const result = await harness.ctx.peers.send(caller, { to: 'peer-fork', message: 'hi fork' })
    expect(result.status).toBe('delivered')
    await fork.whenIdle()
    expect(harness.userMessages(fork)).toHaveLength(1)
  })

  it('refuses a live peer in another repository', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const elsewhere = await harness.makeDirectory('other-repo')
    const remote = await harness.create('peer-other', { cwd: elsewhere })
    await expect(harness.ctx.peers.send(caller, { to: 'peer-other', message: 'hi' }))
      .rejects.toThrow('That peer is in a different repository.')
    expect(await harness.ctx.peers.list(caller)).toEqual([])
    // A name another repository also uses is no ambiguity: only the peers in
    // the caller's own repository are candidates to choose between.
    remote.session.append('session/title', { title: 'shared', messageSeqs: [], source: { kind: 'user' } })
    const local = await harness.create('peer-local')
    local.session.append('session/title', { title: 'shared', messageSeqs: [], source: { kind: 'user' } })
    const result = await harness.ctx.peers.send(caller, { to: 'shared', message: 'hi local' })
    expect(result.status).toBe('delivered')
    await local.whenIdle()
    expect(harness.userMessages(local)).toHaveLength(1)
  })

  it('drops and deletes an envelope stamped with another repository', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 10 } })
    harnesses.push(harness)
    const target = await harness.create('peer-b')
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    await plantEnvelope(harness, 'peer-b', {
      version: 1,
      messageId: 'peer-message-foreign',
      targetId: 'peer-b',
      senderSessionId: 'peer-a',
      senderName: 'peer-a',
      fromRepo: 'dir:/somewhere/else',
      relayDepth: 1,
      kind: 'peer-message',
      text: 'steal the ref',
    })
    // The poll pass drops the foreign envelope. Wait for the deletion instead
    // of assuming a fixed number of ticks, which a loaded machine can miss.
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-b')).toEqual([]) }, { timeout: 2_000 })
    await target.whenIdle()
    expect(harness.userMessages(target)).toEqual([])
    expect(warn.mock.calls.map(call => String(call[0])))
      .toContain('peer-sessions: dropped envelope "peer-message-foreign" for peer "peer-b": it came from another repository')
  })

  it('drops and deletes an envelope planted for a subagent this process holds', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const parent = await harness.create('peer-a')
    const repoKey = await publishedRepoKey(harness, 'peer-a')
    await plantEnvelope(harness, 'peer-sub', {
      version: 1,
      messageId: 'peer-message-subagent',
      targetId: 'peer-sub',
      senderSessionId: parent.id,
      senderName: 'peer-a',
      fromRepo: repoKey,
      relayDepth: 1,
      kind: 'peer-message',
      text: 'do the work',
    })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    const subagent = await harness.create('peer-sub', { meta: { origin: 'subagent' } })
    // The creation drain drops the envelope before it steers anything, so wait
    // for that deletion instead of for a fixed number of poll ticks.
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-sub')).toEqual([]) })
    expect(harness.userMessages(subagent)).toEqual([])
    expect(warn.mock.calls.map(call => String(call[0])))
      .toContain('peer-sessions: dropped envelope "peer-message-subagent" for peer "peer-sub": the target session is not a top-level peer')
  })

  it('keeps resolving peers for a session whose publisher state this process retired', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    // A duplicate disposal retires the peer state this service tracks for a
    // live root, so every later call has to resolve the caller from its header.
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    harness.ctx.emit('agent/disposed', { agent: caller })
    harness.ctx.emit('agent/disposed', { agent: caller })
    const result = await harness.ctx.peers.send(caller, { to: 'peer-b', message: 'still here' })
    expect(result.status).toBe('delivered')
    await target.whenIdle()
    expect(harness.userMessages(target)).toHaveLength(1)
    // The retired session is skipped as a candidate, so it cannot be addressed.
    await expect(harness.ctx.peers.send(target, { to: 'peer-a', message: 'back' }))
      .rejects.toThrow('No peer session named "peer-a" is live in this repository.')
    // And its own mailbox is no longer drained, so a notice stays queued.
    expect((await harness.ctx.peers.notifyIdle(caller, { to: 'peer-b' })).status).toBe('queued')
    caller.session.append('session/title', { title: 'retired', messageSeqs: [], source: { kind: 'user' } })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect((await harness.ctx.peers.list(target)).map(peer => peer.id)).toEqual([])
    // Nothing about a retired session ever reaches the drained state paths.
    expect(warn.mock.calls.filter(call => String(call[0]).includes('failed'))).toEqual([])
  })

  it('deletes an envelope of a target whose repository key could not be resolved', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const repoKey = await publishedRepoKey(harness, 'peer-a')
    // Planted before the target exists, so its creation is the drain that has
    // to reject an envelope the target has no repository key to authorize.
    await harness.plantMail('peer-nocwd', 'peer-message.json', `${JSON.stringify({
      version: 1,
      messageId: 'peer-message',
      targetId: 'peer-nocwd',
      senderSessionId: caller.id,
      senderName: 'peer-a',
      fromRepo: repoKey,
      relayDepth: 1,
      kind: 'peer-message',
      text: 'hello',
    })}\n`)
    await harness.create('peer-nocwd', { cwd: null })
    expect(await harness.mailFiles('peer-nocwd')).toEqual([])
    expect(await harness.ctx.peers.list(caller)).toEqual([])
    expect(mailShardDirectory(harness.home, 'peer-nocwd')).toContain('mail')
  })
})
