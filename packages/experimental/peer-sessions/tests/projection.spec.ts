/**
 * Fold tests for the host-only `peerDelivery` projection.
 *
 * The fold is the mailbox's acceptance record: a replayed delivery must not
 * count twice, and the durable state is validated at its boundary.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { peerDeliveryProjection } from '../src/projection.ts'
import type { PeerMessageId } from '../src/types.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

/** Append one framed relay from the fixed peer sender to an agent's own log. */
function appendRelay(agent: Agent, messageId: PeerMessageId): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: `relayed ${messageId}` }],
    source: {
      kind: 'peer-message',
      form: 'relay',
      messageId,
      senderSessionId: SessionId('peer-s'),
      senderName: 'peer-s',
      relayDepth: 2,
    },
  }))
}

/** Append one framed idle notice from the fixed peer sender to an agent's own log. */
function appendNotice(agent: Agent, messageId: PeerMessageId): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: `notice ${messageId}` }],
    source: {
      kind: 'peer-idle',
      form: 'notice',
      summary: boundContextSummary('Peer "peer-s" is idle.'),
      messageId,
      senderSessionId: SessionId('peer-s'),
      senderName: 'peer-s',
    },
  }))
}

describe('peer delivery projection', () => {
  it('records a relayed delivery once even when the same envelope is logged twice', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const agent = await harness.create('peer-a')
    const messageId = brandString<PeerMessageId>('peer-message-replayed')
    appendRelay(agent, messageId)
    appendRelay(agent, messageId)
    await agent.whenIdle()
    expect(harness.ctx.sessionProjections.stateOf(agent.session, 'peerDelivery')?.delivered).toEqual([messageId])
  })

  it('records a replayed idle notice once and marks the turn it opened', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const agent = await harness.create('peer-a')
    const messageId = brandString<PeerMessageId>('peer-idle-replayed')
    appendNotice(agent, messageId)
    appendNotice(agent, messageId)
    await agent.whenIdle()
    expect(harness.ctx.sessionProjections.stateOf(agent.session, 'peerDelivery')?.delivered).toEqual([messageId])
  })

  it('accepts its own durable state and rejects a foreign one', () => {
    const schema = peerDeliveryProjection.stateSchema
    const delivered = brandString<PeerMessageId>('peer-message-durable')
    expect(schema.parse({ delivered: [delivered], relayDepth: { 'peer-s': 3 }, peerIdleTurn: true }))
      .toEqual({ delivered: [delivered], relayDepth: { 'peer-s': 3 }, peerIdleTurn: true })
    expect(schema.safeParse({ delivered: [''], relayDepth: {}, peerIdleTurn: false }).success).toBe(false)
    expect(schema.safeParse({ delivered: [], relayDepth: { 'peer-s': 0 }, peerIdleTurn: false }).success).toBe(false)
  })
})
