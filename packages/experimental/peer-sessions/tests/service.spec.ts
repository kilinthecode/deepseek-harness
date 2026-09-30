import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import PeerService, { Config, PeerError, peerRepoKey } from '../src/index.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

describe('PeerService configuration', () => {
  it('adopts agents that existed before the service loaded', async () => {
    const harness = await mountPeerHarness({ deferPeers: true, peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    const repoKey = await peerRepoKey(await realpathNormalize(harness.workdir))
    await harness.plantMail('peer-b', 'peer-message-late.json', `${JSON.stringify({
      version: 1,
      messageId: 'peer-message-late',
      targetId: 'peer-b',
      senderSessionId: 'peer-a',
      senderName: 'peer-a',
      fromRepo: repoKey,
      relayDepth: 1,
      kind: 'peer-message',
      text: 'late load',
    })}\n`)
    await harness.mountPeers()
    // The adopted session publishes its row and drains the mail it already had.
    await vi.waitFor(() => { expect(harness.userMessages(target)).toHaveLength(1) })
    expect((await harness.ctx.peers.list(caller)).map(peer => peer.id)).toEqual(['peer-b'])
  })

  it('ships the documented peer limits and inbound mode', () => {
    expect(Config({})).toEqual({
      pollMs: 1_000,
      maxPendingPerTarget: 8,
      maxPendingPerSenderPerTarget: 4,
      maxMessageBytes: 8_192,
      maxIdleWatches: 32,
      peerInbound: 'steer',
      activityTtlMs: 1_800_000,
      maxActivityFiles: 12,
      maxActivityPeers: 4,
      maxActivityBytes: 4_096,
      overlap: 'warn',
    })
  })

  it('accepts stated limits and an explicit deferred inbound mode', async () => {
    const harness = await mountPeerHarness({
      peer: {
        pollMs: 250,
        maxPendingPerTarget: 8,
        maxPendingPerSenderPerTarget: 8,
        maxMessageBytes: 1_024,
        maxIdleWatches: 1,
        peerInbound: 'deferred',
      },
    })
    harnesses.push(harness)
    expect(harness.ctx.peers).toBeInstanceOf(PeerService)
    expect(typeof harness.ctx.peers.list).toBe('function')
    expect(typeof harness.ctx.peers.send).toBe('function')
    expect(typeof harness.ctx.peers.notifyIdle).toBe('function')
  })

  it('rejects a limit that is not a positive safe integer', () => {
    expect(() => new PeerService(new Context(), { pollMs: 0 }))
      .toThrow(/pollMs must be a positive safe integer/)
    expect(() => new PeerService(new Context(), { maxPendingPerTarget: 1.5 }))
      .toThrow(/maxPendingPerTarget must be a positive safe integer/)
    expect(() => new PeerService(new Context(), { maxMessageBytes: Number.NaN }))
      .toThrow(/maxMessageBytes must be a positive safe integer/)
  })

  it('rejects an unknown inbound mode and a sender cap above the target cap', () => {
    expect(() => new PeerService(new Context(), { peerInbound: 'sometimes' as never }))
      .toThrow(/peerInbound must be 'steer' or 'deferred'/)
    expect(() => new PeerService(new Context(), { maxPendingPerSenderPerTarget: 9 }))
      .toThrow(/maxPendingPerSenderPerTarget must not exceed maxPendingPerTarget/)
  })

  it('declares the schema as the plugin config slot', () => {
    expect(PeerService.Config).toBe(Config)
  })
})

describe('PeerService methods', () => {
  it('lists nothing when the caller is the only peer in its repository', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const agent = await harness.create('peer-a')
    expect(await harness.ctx.peers.list(agent)).toEqual([])
  })

  it('refuses peer messaging for a caller with no working directory', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const agent = await harness.create('peer-a', { cwd: null })
    await expect(harness.ctx.peers.list(agent))
      .rejects.toThrow('This session has no working directory, so it cannot use peer messaging.')
  })

  it('reports an unknown peer by name with the exact model-visible failure', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const agent = await harness.create('peer-a')
    await expect(harness.ctx.peers.send(agent, { to: 'ghost', message: 'hello' }))
      .rejects.toThrow('No peer session named "ghost" is live in this repository.')
    await expect(harness.ctx.peers.notifyIdle(agent, { to: 'ghost' }))
      .rejects.toThrow('No peer session named "ghost" is live in this repository.')
  })

  it('delivers one framed message to an idle peer in the same repository', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'please hold the ref' })
    expect(result.status).toBe('delivered')
    await target.whenIdle()
    expect(harness.userMessages(target).map(message => message.source)).toEqual([{
      kind: 'peer-message',
      form: 'relay',
      messageId: result.messageId,
      senderSessionId: 'peer-a',
      senderName: 'peer-a',
      relayDepth: 1,
    }])
  })
})

describe('PeerError', () => {
  it('carries the code and presents the exact model-visible message', () => {
    const message = 'No peer session named "missing" is live in this repository.'
    const error = new PeerError('PEER_NOT_FOUND', message)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('PeerError')
    expect(error.code).toBe('PEER_NOT_FOUND')
    expect(error.message).toBe(message)
  })
})
