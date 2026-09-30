import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

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

/** Wake one idle agent with a human message and its own turn. */
function wake(agent: Awaited<ReturnType<PeerHarness['create']>>): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'carry on' }], source: { kind: 'user' } }))
}

describe('deferred inbound delivery', () => {
  it('holds a message for an idle target and steers it once the target runs', async () => {
    const harness = await mountPeerHarness({ peer: { peerInbound: 'deferred', pollMs: 10 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'later' })
    expect(result.status).toBe('deferred')
    expect(harness.userMessages(target)).toEqual([])
    expect(await harness.mailFiles('peer-b')).toHaveLength(1)
    // Hold the step the human message opened, so the target stays running and
    // the poll has an open turn to steer the deferred envelope into.
    const release = gate(harness, 'peer-b')
    wake(target)
    await vi.waitFor(() => { expect(target.status).toBe('running') })
    await vi.waitFor(() => { expect(harness.pending(target)).toHaveLength(1) })
    release()
    await vi.waitFor(() => {
      expect(harness.userMessages(target).map(message => message.source.kind)).toEqual(['user', 'peer-message'])
    })
    await target.whenIdle()
    await vi.waitFor(async () => { expect(await harness.mailFiles('peer-b')).toEqual([]) })
  })

  it('steers an idle target under the shipped steer mode', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'now' })
    expect(result.status).toBe('delivered')
    await target.whenIdle()
    expect(harness.userMessages(target)).toHaveLength(1)
  })

  it('steers a message into a running target under deferred mode', async () => {
    const harness = await mountPeerHarness({ peer: { peerInbound: 'deferred', pollMs: 10 } })
    harnesses.push(harness)
    const sender = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    const release = gate(harness, 'peer-b')
    try {
      wake(target)
      await vi.waitFor(() => { expect(target.status).toBe('running') })
      const result = await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'mid turn' })
      expect(result.status).toBe('delivered')
    } finally {
      release()
    }
    await target.whenIdle()
    expect(harness.userMessages(target)).toHaveLength(2)
  })

  it('still steers an idle notice to a watcher that defers messages', async () => {
    const harness = await mountPeerHarness({ peer: { peerInbound: 'deferred', pollMs: 10 } })
    harnesses.push(harness)
    const watcher = await harness.create('peer-a')
    const target = await harness.create('peer-b')
    const release = gate(harness, 'peer-b')
    try {
      wake(target)
      await vi.waitFor(() => { expect(target.status).toBe('running') })
      expect((await harness.ctx.peers.notifyIdle(watcher, { to: 'peer-b' })).status).toBe('watching')
    } finally {
      release()
    }
    await vi.waitFor(() => { expect(harness.userMessages(watcher)).toHaveLength(1) })
    const [message] = harness.userMessages(watcher)
    expect(message?.source.kind).toBe('peer-idle')
  })
})
