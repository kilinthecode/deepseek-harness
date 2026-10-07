/**
 * Dedupe side of the activity snapshot: what one step shows again, what it
 * stays silent about, and how a compaction and a resumed log reset that memory.
 *
 * The state is seeded the way the tool package will seed it: a real
 * `user/message` carrying the `peer-activity` source.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
// Type-only: the `compaction/end` event this spec appends, and the session-event
// augmentation the id's module declares.
import type {} from '@deepseek-ai/dsh-compaction/types'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { mountPeerHarness, type PeerHarness } from './harness.ts'
import { overlapSections, peerNames, snapshotFixture, writeTurn, type SnapshotFixture } from './activity-fixture.ts'

const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
})

/** The next compaction attempt of one session, so every attempt gets its own id. */
const compactions = new WeakMap<Session, number>()

/**
 * Append one `compaction/end`, the way the compaction engine closes an attempt.
 * @param agent - the session that ran the attempt.
 * @param error - failure text, for an attempt that did not produce a summary.
 */
function endCompaction(agent: Agent, error?: string): void {
  const attempt = (compactions.get(agent.session) ?? 0) + 1
  compactions.set(agent.session, attempt)
  agent.session.append('compaction/end', {
    compactionId: brandString<CompactionId>(`${agent.id}-compaction-${attempt}`),
    turn: null,
    ...error === undefined ? {} : { error },
  })
}

/** One rendered snapshot, failing the test rather than narrowing at every call. */
async function rendered(fixture: SnapshotFixture, step = 1): Promise<string> {
  const snapshot = await fixture.snapshot(step)
  if (snapshot === undefined) throw new Error('the snapshot rendered nothing')
  return snapshot.text
}

describe('peer activity dedupe', () => {
  it('shows a changed block at step 1 and stays silent when nothing changed', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const fixture = await snapshotFixture(harness, 'peer-step-one')
    await fixture.write({ id: 'peer-b', status: 'running', doing: 'first pass', files: ['rel:src/a.ts'] })
    const first = await fixture.snapshot(1)
    if (first === undefined) throw new Error('the snapshot rendered nothing')
    await fixture.seed(first)

    expect(await fixture.snapshot(1)).toBeUndefined()
    // A peer that moved on to something else changes the block.
    await fixture.write({ id: 'peer-b', status: 'running', doing: 'second pass', files: ['rel:src/a.ts'] })
    const changed = await rendered(fixture)
    expect(changed).not.toBe(first.text)
    expect(changed).toContain('second pass')
  })

  it('stays silent at a later step about an overlap it already warned about', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const fixture = await snapshotFixture(harness, 'peer-later-overlap')
    writeTurn(fixture.caller, 'src/shared.ts')
    await fixture.write({ id: 'peer-b', status: 'running', files: ['rel:src/shared.ts'] })
    const first = await fixture.snapshot(1)
    if (first === undefined) throw new Error('the snapshot rendered nothing')
    await fixture.seed(first)

    // A peer file the caller never wrote changes the block but not the overlap.
    await fixture.write({ id: 'peer-b', status: 'running', files: ['rel:src/shared.ts', 'rel:src/other.ts'] })
    expect(await fixture.snapshot(2)).toBeUndefined()
    expect(await rendered(fixture)).toContain('other.ts')
  })

  it('warns at a later step about an overlap it has not warned about yet', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const fixture = await snapshotFixture(harness, 'peer-new-overlap')
    writeTurn(fixture.caller, 'src/shared.ts')
    await fixture.write({ id: 'peer-b', status: 'running', files: ['rel:src/shared.ts'] })
    const first = await fixture.snapshot(1)
    if (first === undefined) throw new Error('the snapshot rendered nothing')
    await fixture.seed(first)

    writeTurn(fixture.caller, 'src/shared-too.ts')
    await fixture.write({ id: 'peer-b', status: 'running', files: ['rel:src/shared.ts', 'rel:src/shared-too.ts'] })
    const warned = await fixture.snapshot(2)
    if (warned === undefined) throw new Error('the later step rendered nothing')
    expect(overlapSections(warned)).toEqual([
      'Overlap with peer "peer-b": it wrote "src/shared.ts", "src/shared-too.ts", which you also wrote or tried to write. Read each again before your next write to it and keep the peer\'s changes; if you are changing it together, send it a message with send_peer_message. Writes made outside file tools are not published.',
    ])
  })

  it('stays silent at a later step when no peer shares a path', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const fixture = await snapshotFixture(harness, 'peer-empty-overlap')
    await fixture.write({ id: 'peer-b', status: 'running', files: ['rel:src/a.ts'] })
    // An earlier step showed a different block that listed the same peer, so
    // only the empty overlap can keep this step silent.
    await fixture.seed({
      text: 'an earlier block',
      sections: [{ name: 'peer:activity', text: 'an earlier block' }],
      peerIds: [SessionId('peer-b')],
    })

    expect(await fixture.snapshot(2)).toBeUndefined()
    expect(await rendered(fixture)).toContain('peer-b')
  })
})

describe('peer activity new peers', () => {
  it('lists a peer the last logged block did not list, and then stays silent', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const fixture = await snapshotFixture(harness, 'peer-new-peer')
    await fixture.write({ id: 'peer-b', status: 'running', files: ['rel:src/a.ts'], updatedAgoMs: 5000 })
    const first = await fixture.snapshot(1)
    if (first === undefined) throw new Error('the snapshot rendered nothing')
    await fixture.seed(first)
    // Every live peer is in the last logged block and none shares a path.
    expect(await fixture.snapshot(2)).toBeUndefined()

    await fixture.write({ id: 'peer-c', name: 'latecomer', status: 'running', doing: 'starting on the parser' })
    const second = await fixture.snapshot(2)
    if (second === undefined) throw new Error('the later step rendered nothing')
    expect(second.peerIds).toEqual(['peer-c', 'peer-b'])
    expect(peerNames(second)).toEqual(['latecomer', 'peer-b'])
    expect(overlapSections(second)).toEqual([])
    await fixture.seed(second)
    expect(await fixture.snapshot(3)).toBeUndefined()
  })

  it('lists a peer that appeared mid-turn to a session that was shown nothing before', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const fixture = await snapshotFixture(harness, 'peer-first')
    // No peer existed at step 1, so this session logged no block.
    expect(await fixture.snapshot(1)).toBeUndefined()
    await fixture.write({ id: 'peer-late', name: 'latecomer', status: 'running', doing: 'starting on the parser' })

    const snapshot = await fixture.snapshot(2)
    if (snapshot === undefined) throw new Error('the later step rendered nothing')
    expect(peerNames(snapshot)).toEqual(['latecomer'])
    expect(overlapSections(snapshot)).toEqual([])
  })

  it('compares against the peers the block lists, not against every live peer', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000, maxActivityPeers: 1 } })
    harnesses.push(harness)
    const fixture = await snapshotFixture(harness, 'peer-capped')
    await fixture.write({ id: 'peer-listed', status: 'running' })
    await fixture.write({ id: 'peer-cut', status: 'running', updatedAgoMs: 5000 })
    const first = await fixture.snapshot(1)
    if (first === undefined) throw new Error('the snapshot rendered nothing')
    expect(first.peerIds).toEqual(['peer-listed'])
    await fixture.seed(first)

    // The cap keeps the second peer out of every block, so it is never a new one.
    expect(await fixture.snapshot(2)).toBeUndefined()
  })
})

describe('peer activity compaction', () => {
  it('shows the block again after a successful compaction and not after a failed one', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const fixture = await snapshotFixture(harness, 'peer-compaction')
    await fixture.write({ id: 'peer-b', status: 'running', files: ['rel:src/a.ts'] })
    const first = await fixture.snapshot(1)
    if (first === undefined) throw new Error('the snapshot rendered nothing')

    // Nothing to reset yet: the first attempt of a session changes nothing.
    endCompaction(fixture.caller)
    expect((await fixture.snapshot(1))?.text).toBe(first.text)

    await fixture.seed(first)
    expect(await fixture.snapshot(1)).toBeUndefined()

    // A compaction rewrites the context around the block, so the next step shows it again.
    endCompaction(fixture.caller)
    expect((await fixture.snapshot(1))?.text).toBe(first.text)

    await fixture.seed(first)
    expect(await fixture.snapshot(1)).toBeUndefined()

    // A failed attempt leaves the context as it was, block included.
    endCompaction(fixture.caller, 'summarization failed')
    expect(await fixture.snapshot(1)).toBeUndefined()
  })

  it('forgets the listed peers after a successful compaction and not after a failed one', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const fixture = await snapshotFixture(harness, 'peer-compaction-peers')
    const listed = (): readonly string[] | undefined =>
      harness.ctx.sessionProjections.stateOf(fixture.caller.session, 'peerActivity')?.lastPeerIds
    await fixture.write({ id: 'peer-b', status: 'running', files: ['rel:src/a.ts'] })
    const first = await fixture.snapshot(1)
    if (first === undefined) throw new Error('the snapshot rendered nothing')
    expect(listed()).toEqual([])

    await fixture.seed(first)
    expect(listed()).toEqual(['peer-b'])
    expect(await fixture.snapshot(2)).toBeUndefined()

    // A failed attempt leaves the context as it was, so the peer stays shown.
    endCompaction(fixture.caller, 'summarization failed')
    expect(listed()).toEqual(['peer-b'])
    expect(await fixture.snapshot(2)).toBeUndefined()

    // A compaction drops the block from the context, so the peer is new again.
    endCompaction(fixture.caller)
    expect(listed()).toEqual([])
    expect((await fixture.snapshot(2))?.peerIds).toEqual(['peer-b'])
  })
})

describe('peer activity resume', () => {
  it('dedupes against a block an inherited log already carries', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    const origin = await snapshotFixture(harness, 'peer-origin')
    await origin.write({ id: 'peer-b', status: 'running', files: ['rel:src/a.ts'] })
    const first = await origin.snapshot(1)
    if (first === undefined) throw new Error('the snapshot rendered nothing')
    await origin.seed(first)
    expect(await origin.snapshot(1)).toBeUndefined()

    const prefix = harness.events(origin.caller)
    const resumed = await harness.create('peer-resumed', {
      meta: { isSeeded: true, parentSession: origin.caller.id },
      seed: prefix,
      inheritedEventCount: SessionLogOffset(prefix.length),
    })
    expect(await harness.ctx.peers.activitySnapshot(resumed, 1)).toBeUndefined()
    // The peers that block listed are recovered from the log too, so a later step lists none as new.
    expect(await harness.ctx.peers.activitySnapshot(resumed, 2)).toBeUndefined()
  })
})
