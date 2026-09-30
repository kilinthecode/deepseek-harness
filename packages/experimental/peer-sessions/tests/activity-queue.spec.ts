import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { openWriteTurn } from './activity-fixture.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

/**
 * A gate that holds every activity row write while `hold` is set, reports when a
 * held write committed, and lists the session of every write the service started.
 */
const gate = vi.hoisted(() => ({
  hold: undefined as Promise<void> | undefined,
  landed: undefined as (() => void) | undefined,
  started: [] as string[],
}))

vi.mock('../src/activity.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/activity.ts')>()
  return {
    ...original,
    writeActivity: async (...args: Parameters<typeof original.writeActivity>): Promise<void> => {
      gate.started.push(args[1].sessionId)
      const hold = gate.hold
      if (hold === undefined) return original.writeActivity(...args)
      await hold
      await original.writeActivity(...args)
      gate.landed?.()
    },
  }
})

// Imported after the mock so the service and this spec share the gated module.
const { listActivity } = await import('../src/activity.ts')

const harnesses: PeerHarness[] = []

afterEach(async () => {
  gate.hold = undefined
  gate.landed = undefined
  gate.started.length = 0
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

it('removes the row after a publish that was already queued when the session was disposed', async () => {
  const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
  harnesses.push(harness)
  const peer = await harness.create('peer-a')
  let release = (): void => undefined
  gate.hold = new Promise<void>((resolve) => { release = resolve })
  const landed = new Promise<void>((resolve) => { gate.landed = resolve })
  // The title change queues a row write that cannot commit until the gate opens.
  peer.session.append('session/title', { title: 'renamed', messageSeqs: [], source: { kind: 'user' } })
  harness.ctx.emit('agent/disposed', { agent: peer })
  // Give the disposal every chance to run ahead of the held write.
  await new Promise(resolve => setTimeout(resolve, 20))
  release()
  await landed
  // The held write has committed; only a removal queued behind it can clear the row.
  await vi.waitFor(async () => {
    expect(await listActivity(harness.home)).toEqual([])
  })
})

it('publishes no row for a root that was disposed before its subagent\'s write result arrived', async () => {
  const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
  harnesses.push(harness)
  const root = await harness.createHandle('peer-a')
  const subagent = await harness.create('peer-sub', {
    meta: { origin: 'subagent', parentSession: SessionId('peer-a'), delegationDepth: 1 },
  })
  const finish = openWriteTurn(subagent, 'src/late.ts')
  await root.dispose()
  await vi.waitFor(async () => { expect(await listActivity(harness.home)).toEqual([]) })
  gate.started.length = 0

  finish()
  // Every publish the result queues has started its write once the microtask queue drains.
  await new Promise(resolve => setImmediate(resolve))
  expect(gate.started).toEqual([])
  expect(await listActivity(harness.home)).toEqual([])
})
