import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamProjectionState, TeamState } from '../src/projection.ts'
import { RoomMessageId, RoomProposalId, TeamId } from '../src/types.ts'
import type {
  RoomMessageSnapshot, RoomProposalSnapshot, RoomReviewSnapshot, RoomReviewTimeoutSnapshot,
} from '../src/types.ts'

const ROOT = SessionId('room-root')
const TEAM = TeamId(ROOT)
const ALICE = SessionId('alice')
const BOB = SessionId('bob')

function project(events: readonly SessionEvent[]): TeamProjectionState {
  let state = teamProjectionDefinition.init({
    version: SESSION_FORMAT_VERSION,
    id: ROOT,
    createdAt: 0,
    isSeeded: false,
  })
  for (const entry of events) state = teamProjectionDefinition.apply(state, entry)
  return state
}

function room(events: readonly SessionEvent[]): TeamState {
  const projected = project(events)
  if (projected.failure !== undefined) throw new Error(projected.failure)
  return projected
}

function messageEvent(overrides: Partial<RoomMessageSnapshot> = {}, seq = 0): SessionEvent<'room/message'> {
  const message: RoomMessageSnapshot = {
    id: RoomMessageId('room-message-1'),
    authorId: ALICE,
    content: [{ type: 'text', text: 'hello' }],
    ...overrides,
  }
  return { type: 'room/message', data: { version: 1, teamId: TEAM, message }, seq: SessionSeq(seq), time: seq }
}

function proposalEvent(
  overrides: Partial<RoomProposalSnapshot> = {},
  seq = 0,
): SessionEvent<'room/proposal'> {
  const proposal: RoomProposalSnapshot = {
    id: RoomProposalId('proposal-1'),
    revision: 1,
    proposerId: ROOT,
    statement: 'ship it',
    phase: 'open',
    ...overrides,
  }
  return { type: 'room/proposal', data: { version: 1, teamId: TEAM, proposal }, seq: SessionSeq(seq), time: seq }
}

function reviewEvent(overrides: Partial<RoomReviewSnapshot> = {}, seq = 0): SessionEvent<'room/review'> {
  const review: RoomReviewSnapshot = {
    proposalId: RoomProposalId('proposal-1'),
    proposalRevision: 1,
    reviewerId: ALICE,
    verdict: 'approve',
    reason: 'sound',
    ...overrides,
  }
  return { type: 'room/review', data: { version: 1, teamId: TEAM, review }, seq: SessionSeq(seq), time: seq }
}

function timeoutEvent(
  overrides: Partial<RoomReviewTimeoutSnapshot> = {},
  seq = 0,
): SessionEvent<'room/review-timeout'> {
  const timeout: RoomReviewTimeoutSnapshot = {
    proposalId: RoomProposalId('proposal-1'),
    proposalRevision: 1,
    kind: 'reminder',
    stalled: [ALICE],
    ...overrides,
  }
  return { type: 'room/review-timeout', data: { version: 1, teamId: TEAM, timeout }, seq: SessionSeq(seq), time: seq }
}

describe('room transcript projection', () => {
  it('appends attributed utterances and rejects a repeated identity', () => {
    expect(room([messageEvent()]).roomMessages).toHaveLength(1)
    const failed = project([messageEvent(), messageEvent({}, 1)])
    expect(failed.failure).toMatch(/room message "room-message-1" was appended twice/)
  })

  it('ignores a room event owned by another room', () => {
    const foreign = messageEvent()
    const state = room([{ ...foreign, data: { ...foreign.data, teamId: TeamId(SessionId('other')) } }])
    expect(state.roomMessages).toEqual([])
  })
})

describe('room decision projection', () => {
  it('requires a first revision to open at revision one', () => {
    expect(room([proposalEvent()]).roomProposals).toEqual([
      { id: RoomProposalId('proposal-1'), revision: 1, proposerId: ROOT, statement: 'ship it', phase: 'open' },
    ])
    expect(project([proposalEvent({ revision: 2 })]).failure).toMatch(/must begin at revision 1/)
    expect(project([proposalEvent({ phase: 'accepted' })]).failure).toMatch(/must begin open/)
    expect(room([proposalEvent()]).nextProposalNumber).toBe(2)
  })

  it('allocates the next identity only from numeric proposal ids', () => {
    const custom = room([proposalEvent({ id: RoomProposalId('proposal-custom') })])
    expect(custom.nextProposalNumber).toBe(1)
    const numeric = room([proposalEvent({ id: RoomProposalId('proposal-4') })])
    expect(numeric.nextProposalNumber).toBe(5)
    // A saturated suffix must not overflow into an unusable next identity.
    const saturated = room([proposalEvent({ id: RoomProposalId(`proposal-${String(Number.MAX_SAFE_INTEGER)}`) })])
    expect(saturated.nextProposalNumber).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('settles an open decision in place and refuses to reopen it', () => {
    const settled = room([proposalEvent(), proposalEvent({ phase: 'accepted' }, 1)])
    expect(settled.roomProposals[0]!.phase).toBe('accepted')
    expect(project([proposalEvent(), proposalEvent({ phase: 'accepted' }, 1), proposalEvent({ phase: 'rejected' }, 2)]).failure)
      .toMatch(/final room proposal "proposal-1" cannot change/)
    expect(project([proposalEvent(), proposalEvent({ phase: 'escalated' }, 1), proposalEvent({ phase: 'open' }, 2)]).failure)
      .toMatch(/final room proposal "proposal-1" cannot change/)
  })

  it('refuses to change the proposer or the statement without a revision', () => {
    expect(project([proposalEvent(), proposalEvent({ proposerId: ALICE }, 1)]).failure)
      .toMatch(/proposer changed/)
    expect(project([proposalEvent(), proposalEvent({ statement: 'other' }, 1)]).failure)
      .toMatch(/statement changed without a revision/)
    expect(project([proposalEvent(), proposalEvent({}, 1)]).failure)
      .toMatch(/reasserted an unchanged open revision/)
  })

  it('reopens a rejected decision only through the next contiguous revision', () => {
    const reopened = room([
      proposalEvent(),
      proposalEvent({ phase: 'rejected' }, 1),
      proposalEvent({ revision: 2, statement: 'ship on Monday' }, 2),
    ])
    expect(reopened.roomProposals[0]).toMatchObject({ revision: 2, phase: 'open', statement: 'ship on Monday' })
    expect(project([proposalEvent(), proposalEvent({ phase: 'rejected' }, 1), proposalEvent({}, 2)]).failure)
      .toMatch(/must be revised, not amended/)
    expect(project([proposalEvent(), proposalEvent({ revision: 3 }, 1)]).failure)
      .toMatch(/revision is not contiguous/)
    expect(project([proposalEvent(), proposalEvent({ revision: 2, phase: 'rejected' }, 1)]).failure)
      .toMatch(/revision must reopen the decision/)
  })


  it('records abandonment against a reached revision and rejects one it cannot place', () => {
    const state = room([
      proposalEvent(),
      timeoutEvent(),
      timeoutEvent({ kind: 'escalated', stalled: [ALICE, BOB] }, 1),
    ])
    expect(state.roomTimeouts.map(timeout => timeout.kind)).toEqual(['reminder', 'escalated'])
    expect(state.roomTimeouts.at(-1)?.stalled).toEqual([ALICE, BOB])
    expect(project([proposalEvent(), timeoutEvent({ proposalRevision: 2 }, 1)]).failure)
      .toMatch(/room timeout names unreached revision 2/)
    expect(project([timeoutEvent()]).failure)
      .toMatch(/room timeout names unknown proposal "proposal-1"/)
  })

  it('keeps every recorded review and rejects reviews it cannot place', () => {
    const state = room([proposalEvent(), reviewEvent(), reviewEvent({ verdict: 'reject' }, 1)])
    expect(state.roomReviews.map(review => review.verdict)).toEqual(['approve', 'reject'])
    expect(project([reviewEvent()]).failure).toMatch(/room review names unknown proposal "proposal-1"/)
    expect(project([proposalEvent(), reviewEvent({ proposalRevision: 2 }, 1)]).failure)
      .toMatch(/room review names unreached revision 2/)
    // The payload schema already requires a positive revision, so the fold only bounds the upper end.
    expect(project([proposalEvent(), reviewEvent({ proposalRevision: 0 }, 1)]).failure)
      .toMatch(/persisted Agent Teams room\/review payload is invalid/)
    expect(room([proposalEvent(), reviewEvent({ reviewerId: BOB }, 1)]).roomReviews[0]!.reviewerId).toBe(BOB)
  })
})
