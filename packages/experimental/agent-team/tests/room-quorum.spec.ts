import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { latestStandings, requiredApprovals, tallyProposal } from '../src/room-quorum.ts'
import type { RoomReviewSnapshot } from '../src/types.ts'
import { RoomProposalId } from '../src/types.ts'

const ALICE = SessionId('alice')
const BOB = SessionId('bob')
const CAROL = SessionId('carol')
const PROPOSAL = RoomProposalId('proposal-1')

function review(
  reviewerId: ReturnType<typeof SessionId>,
  verdict: RoomReviewSnapshot['verdict'],
  revision = 1,
): RoomReviewSnapshot {
  return { proposalId: PROPOSAL, proposalRevision: revision, reviewerId, verdict, reason: `${verdict} reason` }
}

describe('room quorum arithmetic', () => {
  it('requires at least one approval and never more than the eligible count', () => {
    expect(requiredApprovals(1, 0.5)).toBe(1)
    expect(requiredApprovals(2, 0.5)).toBe(1)
    expect(requiredApprovals(2, 1)).toBe(2)
    expect(requiredApprovals(3, 0.5)).toBe(2)
    expect(requiredApprovals(4, 0.5)).toBe(2)
    expect(requiredApprovals(5, 1)).toBe(5)
  })

  it('keeps only the latest standing per reviewer and ignores other proposals and revisions', () => {
    const standings = latestStandings([
      review(ALICE, 'reject'),
      { ...review(BOB, 'approve'), proposalId: RoomProposalId('proposal-2') },
      review(CAROL, 'approve', 2),
      review(ALICE, 'approve'),
    ], PROPOSAL, 1)
    expect([...standings]).toEqual([[ALICE, 'approve']])
  })

  it('stays open while an eligible reviewer has not voted', () => {
    const tally = tallyProposal([ALICE, BOB], [review(ALICE, 'approve')], PROPOSAL, 1, 0.5)
    expect(tally.phase).toBe('open')
    expect(tally.awaiting).toEqual([BOB])
    expect(tally.requiredApprovals).toBe(1)
  })

  it('accepts only when every eligible reviewer voted, quorum approved, and no rejection stands', () => {
    const tally = tallyProposal(
      [ALICE, BOB, CAROL],
      [review(ALICE, 'approve'), review(BOB, 'approve'), review(CAROL, 'abstain')],
      PROPOSAL,
      1,
      0.5,
    )
    expect(tally.phase).toBe('accepted')
    expect(tally.approvals).toEqual([ALICE, BOB])
    expect(tally.abstentions).toEqual([CAROL])
    expect(tally.awaiting).toEqual([])
  })

  it('rejects as soon as rejecting reviewers reach quorum', () => {
    const tally = tallyProposal(
      [ALICE, BOB, CAROL],
      [review(ALICE, 'reject'), review(BOB, 'reject')],
      PROPOSAL,
      1,
      0.5,
    )
    expect(tally.phase).toBe('rejected')
    expect(tally.rejections).toEqual([ALICE, BOB])
    expect(tally.awaiting).toEqual([CAROL])
  })

  it('rejects once everyone voted without reaching quorum', () => {
    const tally = tallyProposal(
      [ALICE, BOB, CAROL],
      [review(ALICE, 'approve'), review(BOB, 'abstain'), review(CAROL, 'abstain')],
      PROPOSAL,
      1,
      0.5,
    )
    expect(tally.phase).toBe('rejected')
    expect(tally.approvals).toEqual([ALICE])
  })

  it('rejects a unanimous approval that still falls short of a unanimous quorum', () => {
    const tally = tallyProposal(
      [ALICE, BOB, CAROL],
      [review(ALICE, 'approve'), review(BOB, 'approve'), review(CAROL, 'reject')],
      PROPOSAL,
      1,
      1,
    )
    expect(tally.phase).toBe('rejected')
    expect(tally.requiredApprovals).toBe(3)
    expect(tally.rejections).toEqual([CAROL])
  })
})
