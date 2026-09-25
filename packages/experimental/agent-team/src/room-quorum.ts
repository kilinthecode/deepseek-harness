/** Pure quorum arithmetic for collective room decisions. */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RoomProposalPhase, RoomReviewSnapshot, RoomReviewVerdict } from './types.ts'

/** The settled phase of one proposal revision, before any explicit escalation. */
export type RoomTallyPhase = Exclude<RoomProposalPhase, 'escalated'>

/** Complete quorum arithmetic for one proposal revision. */
export interface RoomTally {
  /** Approvals needed for acceptance at this revision. */
  readonly requiredApprovals: number
  readonly approvals: SessionId[]
  readonly rejections: SessionId[]
  readonly abstentions: SessionId[]
  /** Eligible reviewers with no recorded standing on this revision. */
  readonly awaiting: SessionId[]
  readonly phase: RoomTallyPhase
}

/**
 * Approvals required for acceptance.
 * @param eligibleCount - number of reviewers eligible for this decision.
 * @param ratio - required fraction of eligible reviewers, in (0, 1].
 * @returns at least one approval, never more than the eligible count.
 */
export function requiredApprovals(eligibleCount: number, ratio: number): number {
  return Math.min(eligibleCount, Math.max(1, Math.ceil(eligibleCount * ratio)))
}

/**
 * Keep the last recorded standing per reviewer for one proposal revision.
 * @param reviews - every review in the room, in durable order.
 * @param proposalId - proposal selecting the reviews.
 * @param revision - revision selecting the reviews.
 * @returns each reviewer's latest verdict.
 */
export function latestStandings(
  reviews: readonly RoomReviewSnapshot[],
  proposalId: string,
  revision: number,
): Map<SessionId, RoomReviewVerdict> {
  const standings = new Map<SessionId, RoomReviewVerdict>()
  for (const review of reviews) {
    if (review.proposalId !== proposalId || review.proposalRevision !== revision) continue
    standings.set(review.reviewerId, review.verdict)
  }
  return standings
}

/**
 * Compute the settled phase and vote split for one proposal revision.
 * Acceptance requires every eligible reviewer to have voted, at least the
 * required number of approvals, and no standing rejection. A revision that
 * cannot reach acceptance once every eligible reviewer has voted is rejected.
 * @param eligible - reviewers who may vote on this revision, excluding the proposer.
 * @param reviews - every review in the room, in durable order.
 * @param proposalId - proposal selecting the reviews.
 * @param revision - revision selecting the reviews.
 * @param ratio - required fraction of eligible reviewers, in (0, 1].
 * @returns the vote split and derived phase.
 */
export function tallyProposal(
  eligible: readonly SessionId[],
  reviews: readonly RoomReviewSnapshot[],
  proposalId: string,
  revision: number,
  ratio: number,
): RoomTally {
  const standings = latestStandings(reviews, proposalId, revision)
  const approvals: SessionId[] = []
  const rejections: SessionId[] = []
  const abstentions: SessionId[] = []
  const awaiting: SessionId[] = []
  for (const reviewerId of eligible) {
    switch (standings.get(reviewerId)) {
      case 'approve':
        approvals.push(reviewerId)
        break
      case 'reject':
        rejections.push(reviewerId)
        break
      case 'abstain':
        abstentions.push(reviewerId)
        break
      default:
        awaiting.push(reviewerId)
        break
    }
  }
  const required = requiredApprovals(eligible.length, ratio)
  let phase: RoomTallyPhase = 'open'
  if (rejections.length >= required) phase = 'rejected'
  else if (awaiting.length === 0) {
    phase = approvals.length >= required && rejections.length === 0 ? 'accepted' : 'rejected'
  }
  return { requiredApprovals: required, approvals, rejections, abstentions, awaiting, phase }
}
