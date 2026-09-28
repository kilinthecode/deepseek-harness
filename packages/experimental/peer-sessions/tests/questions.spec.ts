import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

describe('peer presence while a user question is in flight', () => {
  it('publishes awaiting-user during a running turn before the answer resolves and always calls next', async () => {
    const harness = await mountPeerHarness()
    harnesses.push(harness)
    const caller = await harness.create('peer-a')
    const asked = await harness.create('peer-b')
    // Hold the step open so the asking agent is genuinely running; a real
    // question reaches the waterfall from inside that turn.
    let releaseStep = (): void => {}
    const stepHeld = new Promise<void>((resolve) => { releaseStep = resolve })
    harness.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.agent.id === 'peer-b') await stepHeld
      return await next()
    })
    asked.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(asked.status).toBe('running') })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    let nextCalls = 0
    const answered = harness.ctx.waterfall('user-questions/request', {
      questions: [{ id: 'q-ref', question: 'which ref?' }],
      agent: asked,
    }, async () => {
      nextCalls += 1
      await held
      return { answers: [] }
    })
    await vi.waitFor(async () => {
      expect((await harness.ctx.peers.list(caller)).map(peer => peer.status)).toEqual(['awaiting-user'])
    })
    release()
    await answered
    expect(nextCalls).toBe(1)
    releaseStep()
    await asked.whenIdle()
    await vi.waitFor(async () => {
      expect((await harness.ctx.peers.list(caller)).map(peer => peer.status)).toEqual(['idle'])
    })
  })
})
