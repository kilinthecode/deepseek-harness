/** Public Agent Teams identities, durable records, and service request values. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies the implicit team rooted at one top-level Session. */
export type TeamId = Branded<'TeamId'>

/**
 * Brand one root Session identity as its implicit Team identity.
 * @param id - Root Session identity.
 * @returns the same string branded as a Team identity.
 */
export function TeamId(id: SessionId | string): TeamId {
  return id as TeamId
}

/** Stable identifier for one task in a Team. */
export type TeamTaskId = Branded<'TeamTaskId'>

/**
 * Brand a validated task id.
 * @param id - Team-local task identity.
 * @returns the same string branded as a Team task identity.
 */
export function TeamTaskId(id: string): TeamTaskId {
  return id as TeamTaskId
}

/** Stable identifier for one durable peer message. */
export type TeamMessageId = Branded<'TeamMessageId'>

/**
 * Brand a generated peer-message id.
 * @param id - Durable mailbox message identity.
 * @returns the same string branded as a Team message identity.
 */
export function TeamMessageId(id: string): TeamMessageId {
  return id as TeamMessageId
}

/** Durable teammate lifecycle. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** Whole durable value written on every teammate lifecycle change. */
export interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  /**
   * Resolved child `agentOptions.provider` for this teammate. A teammate holds
   * no live Agent between turns, so the roster reads its route here instead of
   * reporting the Lead's route. Absent for a member recorded before this field
   * existed or resolved without a provider.
   */
  readonly agentProvider?: string
  /** Resolved child `agentOptions.model`, recorded on {@link agentProvider}'s terms. */
  readonly agentModel?: string
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/** Current runtime-enriched roster row. */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed'
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  readonly model?: string
  readonly diagnostics: string[]
}

/** Durable task lifecycle. Work reaches `completed` only through a peer verdict. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/**
 * Task status as a view reports it. `verifying` is derived from a submitted
 * revision with no verdict yet, so the durable union keeps its committed
 * variants and the awaiting state needs no stored transition.
 */
export type TeamTaskViewStatus = TeamTaskStatus | 'verifying'

/** Peer verification recorded against one submitted task revision. */
export interface TeamTaskVerification {
  /** Task revision the owner submitted for verification. */
  readonly submittedRevision: number
  /** Peer that recorded the latest verdict; absent until one does. */
  readonly verifierId?: SessionId
  /** The peer's verdict on the submitted revision. */
  readonly verdict?: 'approved' | 'rejected'
  /** Why the peer approved or rejected; the owner acts on a rejection. */
  readonly reason?: string
}

/** Peer verification as a task view reports it, with the verifier named. */
export interface TeamTaskVerificationView {
  readonly submittedRevision: number
  readonly verifierName?: string
  readonly verdict?: 'approved' | 'rejected'
  readonly reason?: string
}

/** Whole durable task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  /** Submission and peer verdict, present once the task leaves its owner's hands. */
  readonly verification?: TeamTaskVerification
}

/** Runtime-enriched task view returned to tools and hosts. */
export interface TeamTaskView {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskViewStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
  /** Submission and peer verdict, present once the task leaves its owner's hands. */
  readonly verification?: TeamTaskVerificationView
}

/** One durable roster row published through the `agentTeam` Session projection. */
export interface TeamMemberProjection {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  /** Durable lifecycle; the Lead row is always `active`. Turn activity comes from Session status. */
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/**
 * Durable Team state published to browser clients through the Lead Session's
 * `agentTeam` projection. `failure` names the first rejected persisted Team
 * record; members and tasks then stay at the last valid state.
 */
export interface TeamProjection {
  readonly members: TeamMemberProjection[]
  readonly tasks: TeamTaskView[]
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Durable roster and non-deleted task board of the Team rooted at the projected Session. */
    agentTeam: TeamProjection
  }
}

/** One peer message retained until its target Session records it. */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}

/** Source retained by the target Session for durable mailbox de-duplication. */
export interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Stable identifier for one utterance recorded in the shared room transcript. */
export type RoomMessageId = Branded<'RoomMessageId'>

/**
 * Brand a generated room-utterance id.
 * @param id - Durable room transcript identity.
 * @returns the same string branded as a room utterance identity.
 */
export function RoomMessageId(id: string): RoomMessageId {
  return id as RoomMessageId
}

/** Stable identifier for one collective decision put to the room. */
export type RoomProposalId = Branded<'RoomProposalId'>

/**
 * Brand a generated collective-decision id.
 * @param id - Room-local proposal identity.
 * @returns the same string branded as a room proposal identity.
 */
export function RoomProposalId(id: string): RoomProposalId {
  return id as RoomProposalId
}

/** Durable lifecycle of one collective decision. */
export type RoomProposalPhase = 'open' | 'accepted' | 'rejected' | 'escalated'

/** One participant's recorded standing on one proposal revision. */
export type RoomReviewVerdict = 'approve' | 'reject' | 'abstain'

/** One attributed utterance in the shared room transcript. */
export interface RoomMessageSnapshot {
  readonly id: RoomMessageId
  readonly authorId: SessionId
  readonly content: ContentBlock[]
}

/**
 * One collective decision. Every revision is a complete snapshot, so the fold
 * never reconstructs a proposal by replaying edits.
 */
export interface RoomProposalSnapshot {
  readonly id: RoomProposalId
  /** Revision number, starting at one and incrementing per superseding statement. */
  readonly revision: number
  readonly proposerId: SessionId
  /** The exact statement every reviewer is asked to accept or reject. */
  readonly statement: string
  readonly phase: RoomProposalPhase
}

/**
 * One participant's verdict on one proposal revision. A reviewer changing its
 * standing appends a new record; the fold keeps the latest per reviewer.
 */
export interface RoomReviewSnapshot {
  readonly proposalId: RoomProposalId
  readonly proposalRevision: number
  readonly reviewerId: SessionId
  readonly verdict: RoomReviewVerdict
  /** Why the reviewer chose this verdict; shown to the proposer on settlement. */
  readonly reason: string
}

/** One frame of a live room follow: a complete view, or live participant text. */
export type RoomFollowFrame =
  /** A complete room view, delivered first and after every committed room change. */
  | { readonly type: 'view'; readonly view: RoomRemoteView }
  /** Text one participant is streaming into its in-flight turn. */
  | { readonly type: 'stream'; readonly participant: string; readonly delta: string }

/** One room participant with runtime status and the model it runs. */
export interface RoomParticipantView {
  readonly id: SessionId
  readonly name: string
  readonly status: TeamMemberView['status']
  readonly model?: string
  /**
   * Whether this live participant produced no observed work within
   * `roomReviewGraceMs`. A streaming participant is never quiet, and a
   * participant this process has not observed yet is not called quiet.
   */
  readonly quiet: boolean
}

/** One attributed transcript entry. */
export interface RoomMessageView {
  readonly id: RoomMessageId
  readonly authorName: string
  readonly content: ContentBlock[]
}

/** One collective decision with its quorum arithmetic. */
export interface RoomProposalView {
  readonly id: RoomProposalId
  readonly revision: number
  readonly proposerName: string
  readonly statement: string
  readonly phase: RoomProposalPhase
  /** Approvals needed for acceptance at this revision. */
  readonly requiredApprovals: number
  readonly approvals: string[]
  readonly rejections: string[]
  readonly abstentions: string[]
  /**
   * Eligible reviewers whose latest standing on this revision is still missing.
   * Empty once the decision settles: nothing is awaited from a final outcome.
   */
  readonly awaiting: string[]
  /** Reviewers the room found unresponsive at this revision, once it acted. */
  readonly stalled: string[]
  /**
   * Latest standing per reviewer that recorded one at this revision, in the
   * order they first did, with each reviewer's reason.
   */
  readonly standings: RoomStandingView[]
}

/** One reviewer's recorded standing on a decision revision. */
export interface RoomStandingView {
  readonly reviewer: string
  readonly verdict: RoomReviewVerdict
  /** Why the reviewer chose this verdict, readable by every room participant. */
  readonly reason: string
}

/** One instruction a browser client delivers to a room participant. */
export interface PanelRoomPromptRequest {
  /** Participant name to address. */
  readonly target: string
  /** Instruction delivered with the transcript that participant has not seen. */
  readonly instruction: string
}

/** One statement a browser client puts to the room. */
export interface PanelProposeRoomDecisionRequest {
  /** Exact statement every eligible reviewer is asked to settle. */
  readonly statement: string
}

/** One unresolved decision a browser client hands to the human. */
export interface PanelEscalateRoomDecisionRequest {
  readonly proposalId: RoomProposalId
  /** Why the decision cannot settle without the human. */
  readonly reason: string
}

/** One transcript entry rendered to plain text for browser clients. */
export interface RoomTranscriptEntry {
  readonly author: string
  readonly text: string
}

/**
 * Browser-facing room snapshot. Transcript entries arrive as text so content
 * blocks stay off the Remote wire, where the panel only ever renders text.
 */
export interface RoomRemoteView {
  /** Whether this composition has a room at all; see {@link RoomView.enabled}. */
  readonly enabled: boolean
  readonly participants: RoomParticipantView[]
  /** Rotating chair for the next utterance; carries no decision authority. */
  readonly chair: string
  readonly messages: RoomTranscriptEntry[]
  readonly proposals: RoomProposalView[]
}

/** What the room did when one decision revision left reviewers unresponsive. */
export type RoomReviewTimeoutKind = 'reminder' | 'escalated'

/**
 * Durable record that reviewers of one decision revision produced no activity
 * for the configured grace period. A reminder re-prompts them; an escalation
 * hands the decision to the human. Neither records a standing the reviewer
 * never cast.
 */
export interface RoomReviewTimeoutSnapshot {
  readonly proposalId: RoomProposalId
  readonly proposalRevision: number
  readonly kind: RoomReviewTimeoutKind
  /** Reviewers that were silent at this revision when the room acted. */
  readonly stalled: SessionId[]
}

/** Point-in-time room transcript, roster, and decision board. */
export interface RoomView {
  /**
   * Whether this composition has a room at all. A deployment without one
   * reports an empty view with this false, which a panel renders as absence
   * rather than as failure.
   */
  readonly enabled: boolean
  readonly participants: RoomParticipantView[]
  /** Rotating chair for the next utterance; carries no decision authority. */
  readonly chair: string
  readonly messages: RoomMessageView[]
  readonly proposals: RoomProposalView[]
}

/** Input for delivering the room context and one instruction to a participant. */
export interface RoomPromptRequest {
  readonly target: string
  readonly instruction: ContentBlock[]
  readonly signal: AbortSignal
}

/** Result after one room prompt is durably queued. */
export interface RoomPromptResult {
  readonly messageId: TeamMessageId
  readonly status: 'accepted' | 'queued'
}

/** Input for opening or superseding one collective decision. */
export interface ProposeRoomDecisionRequest {
  readonly statement: string
  /** Existing open proposal this statement supersedes, if any. */
  readonly supersedes?: RoomProposalId
  readonly signal: AbortSignal
}

/** Input for recording one participant's standing on one proposal revision. */
export interface ReviewRoomDecisionRequest {
  readonly proposalId: RoomProposalId
  readonly proposalRevision: number
  readonly verdict: RoomReviewVerdict
  readonly reason: string
  readonly signal: AbortSignal
}

/** Input for handing one unresolved decision to the human. */
export interface EscalateRoomDecisionRequest {
  readonly proposalId: RoomProposalId
  readonly reason: string
  readonly signal: AbortSignal
}

/** Team-service deployment limits. */
export interface Config {
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum queued-minus-delivered messages for one target member. */
  readonly maxPendingMessagesPerMember?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds allowed for Team-owned runtime disposal. */
  readonly disposalTimeoutMs?: number
  /**
   * Whether participant utterances enter a shared transcript and collective
   * decisions are authorized by quorum. When false the Team records no room
   * events and the room operations refuse.
   */
  readonly roomEnabled?: boolean
  /** Maximum transcript entries replayed with one room prompt. */
  readonly roomTranscriptWindow?: number
  /** Approvals required for acceptance, as a fraction of eligible reviewers in (0, 1]. */
  readonly roomApprovalRatio?: number
  /** Maximum revisions one collective decision may reach before it escalates. */
  readonly roomMaxProposalRevisions?: number
  /**
   * Milliseconds of a reviewer's own work that a standing request waits for.
   * Activity is a durable event from that participant's own turn or a live
   * stream frame, so a model still streaming an answer is never counted silent;
   * room and mailbox records, which the Lead Session holds for every actor, are
   * not activity.
   */
  readonly roomReviewGraceMs?: number
  /**
   * Reminders per revision before the decision escalates. A reminder restarts
   * the window of the reviewer it reaches.
   */
  readonly roomReviewReminders?: number
}

/** Result after one teammate reaches a durable active or failed edge. */
export interface SpawnTeammateResult {
  readonly member: TeamMemberView
}

/** Input for one durable peer message. */
export interface SendTeamMessageRequest {
  readonly target: string
  readonly content: ContentBlock[]
  readonly signal: AbortSignal
}

/** Result after a peer message enters the durable mailbox. */
export interface SendTeamMessageResult {
  readonly messageId: TeamMessageId
  readonly status: 'accepted' | 'queued'
}

/** Input for creating one shared task. */
export interface CreateTeamTaskRequest {
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
}

/** Supported task mutation actions. */
export type TeamTaskAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  /** Owner hands the finished work to a peer, which the view reports as `verifying`. */
  | 'submit'
  /** Peer records its verdict on a submitted revision; only a peer may complete work. */
  | 'verify'
  | 'reopen'
  | 'reassign'
  | 'delete'

/** Compare-and-set mutation of one shared task. */
export interface UpdateTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  readonly owner?: string
  /** Peer verdict, required by `verify`. */
  readonly verdict?: 'approved' | 'rejected'
  /** Why the peer approved or rejected; required by `verify`. */
  readonly reason?: string
}

/** Result of waiting for Team activity. */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole teammate lifecycle value, stored only in the Team Lead Session. */
    'team/member': { version: 2; teamId: TeamId; member: TeamMemberSnapshot }
    /** Whole shared-task value, stored only in the Team Lead Session. */
    'team/task': { version: 2; teamId: TeamId; task: TeamTaskSnapshot }
    /** Durable mailbox enqueue, stored before delivery is attempted. */
    'team/message/queued': { version: 2; teamId: TeamId; message: TeamMessageSnapshot }
    /** Durable acknowledgement that the target Session recorded the message. */
    'team/message/delivered': {
      version: 2
      teamId: TeamId
      messageId: TeamMessageId
      targetId: SessionId
    }
    /** One attributed utterance appended to the shared room transcript. */
    'room/message': { version: 1; teamId: TeamId; message: RoomMessageSnapshot }
    /** Whole collective-decision value, superseding any earlier revision. */
    'room/proposal': { version: 1; teamId: TeamId; proposal: RoomProposalSnapshot }
    /** One participant's appended standing on one proposal revision. */
    'room/review': { version: 1; teamId: TeamId; review: RoomReviewSnapshot }
    /** Durable record that one decision revision left reviewers unresponsive. */
    'room/review-timeout': { version: 1; teamId: TeamId; timeout: RoomReviewTimeoutSnapshot }
  }
}
