/** Shared room transcript, participant prompts, and quorum-authorized collective decisions. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the disposable timer mixin (ctx.timeout) this owner arms.
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type TimerService from '@deepseek-ai/cordis-plugin-timer'
import { errorMessage, TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import type { TeamMailbox } from './mailbox.ts'
import type { TeamState } from './projection.ts'
import type { RoomTally } from './room-quorum.ts'
import { tallyProposal } from './room-quorum.ts'
import { availability } from './roster.ts'
import type { TeamMembership, TeamRoster } from './roster.ts'
import { RoomMessageId, RoomProposalId, TeamId } from './types.ts'
import type {
  EscalateRoomDecisionRequest,
  ProposeRoomDecisionRequest,
  ReviewRoomDecisionRequest,
  RoomMessageSnapshot,
  RoomMessageView,
  RoomParticipantView,
  RoomProposalId as RoomProposalIdType,
  RoomProposalSnapshot,
  RoomProposalView,
  RoomPromptRequest,
  RoomPromptResult,
  RoomRemoteView,
  RoomReviewSnapshot,
  RoomReviewTimeoutKind,
  RoomView,
} from './types.ts'
import { requiredText } from './validation.ts'

/** One live participant stream frame, attributed to its room participant. */
export interface RoomStreamFrame {
  readonly teamId: TeamId
  readonly participantId: SessionId
  readonly participantName: string
  readonly frame: AssistantStreamFrame
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One room participant produced a live assistant stream frame. This is a
     * process-local observation of an in-flight turn; the durable record is the
     * participant's own `assistant/message` and the room transcript. A room
     * opens with its Team's first teammate, so a Lead without one emits none.
     * @param payload.teamId - Team identity of the room the participant belongs to.
     * @param payload.participantId - Session identity of the speaking participant.
     * @param payload.participantName - Model-facing participant name.
     * @param payload.frame - The participant's live stream frame.
     * @mode emit
     */
    'room/stream'(payload: RoomStreamFrame): void
    /**
     * One room committed a change to its own log: a transcript entry, a
     * decision, a revision, a review, or a deadline record. A live reader
     * re-reads the room after it, and the durable record is the appended event.
     * @param payload.teamId - Team identity of the room that changed.
     * @mode emit
     */
    'room/updated'(payload: { readonly teamId: TeamId }): void
  }
}

/** Deployment choices the room enforces on every collective decision. */
export interface RoomConfig {
  /** Whether room transcript and decision records are written at all. */
  readonly enabled: boolean
  /** Maximum transcript entries replayed with one room prompt. */
  readonly transcriptWindow: number
  /** Approvals required for acceptance, as a fraction of eligible reviewers in (0, 1]. */
  readonly approvalRatio: number
  /** Maximum revisions one collective decision may reach before it escalates. */
  readonly maxProposalRevisions: number
  /** Milliseconds without participant activity before the room calls it stalled. */
  readonly reviewGraceMs: number
  /** Reminders sent to stalled reviewers before the decision escalates. */
  readonly reviewReminders: number
}

/** One participant identity resolved from the durable roster. */
interface RoomParticipant {
  readonly id: SessionId
  readonly name: string
  /**
   * Whether the durable mailbox can address this participant. A member still
   * provisioning has no committed Session, so it can be neither asked for a
   * standing nor counted toward quorum; the Lead is always addressable.
   */
  readonly reachable: boolean
  /** Route the member record resolved for this participant, when it recorded one. */
  readonly agentModel?: string
}

/**
 * Owns the shared room: an attributed transcript over the Team Lead log, the
 * floor-grant prompt that carries conversation context to one participant, and
 * collective decisions whose outcomes only quorum can settle.
 */
export class TeamRoom {
  /** Last observed activity per participant, in epoch milliseconds. */
  private readonly activity = new Map<SessionId, number>()
  /**
   * One armed stall check per open decision, replaced on every re-arm. Keyed by
   * Lead and decision: every Team numbers its decisions from `proposal-1`.
   */
  private readonly reviewTimers = new Map<string, () => void>()

  /**
   * @param ctx - Team service context with Agent, Session, and subagent services.
   * @param journal - authoritative Lead-log transaction owner.
   * @param roster - Team membership and member-name resolver.
   * @param mailbox - durable peer delivery used for room prompts.
   * @param lifecycle - shared Team runtime admission cutoff.
   * @param config - deployment choices enforced on every room operation.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly roster: TeamRoster,
    private readonly mailbox: TeamMailbox,
    private readonly lifecycle: TeamRuntimeLifecycle,
    private readonly config: RoomConfig,
  ) {}

  /**
   * Append one participant utterance to the shared transcript.
   * @param session - Session that committed an assistant message.
   * @param event - newly appended Session event.
   */
  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (!this.config.enabled) return
    // A durable event is evidence that its author is still working. The team log
    // is written to the Lead's Session whatever the actor, so room records and
    // peer delivery prove nothing about the Session that committed them.
    const own = !event.type.startsWith('room/') && !event.type.startsWith('team/')
    if (own) this.noteActivity(session.header.id)
    if (event.type !== 'assistant/message') return
    const content = messageText(event.data.message.content)
    if (content.length === 0) return
    const agent = this.ctx.agents.get(session.header.id)
    /* v8 ignore next -- the loop appends an assistant message only while its Agent is registered. */
    if (agent === undefined) return
    const membership = this.speaker(agent)
    if (membership === undefined) return
    const message: RoomMessageSnapshot = {
      // The author name and its own event sequence identify the utterance in both
      // a live run and a replay, where the Session identity differs.
      id: RoomMessageId(`room-message-${membership.name}-${event.seq}`),
      authorId: agent.id,
      content,
    }
    const { root } = membership
    void this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      /* v8 ignore next -- the identity is derived from the committed event, so a reload cannot duplicate it. */
      if (state.roomMessages.some(candidate => candidate.id === message.id)) return
      await this.journal.appendAndFlush(root, 'room/message', {
        version: 1,
        teamId: TeamId(root.id),
        message,
      })
      // Readers re-read the room only after an entry this call appended.
      this.published(root.id)
    }).catch((error: unknown) => {
      // An append that races shutdown is not a room failure, and the injected
      // agents service is already unreachable in that context.
      /* v8 ignore next -- disposal during the append is the only quiet path, observed by teardown tests. */
      if (this.ctx.get('agents')?.get(root.id) === undefined) return
      this.ctx.logger.warn(`room transcript append failed: ${errorMessage(error)}`)
    })
  }

  /**
   * Publish one participant's live stream frame to room readers.
   * @param agent - Agent whose turn produced the frame.
   * @param frame - live assistant stream frame of that turn.
   */
  observeStream(agent: Agent, frame: AssistantStreamFrame): void {
    if (!this.config.enabled) return
    // A streaming participant is working even before it commits a message.
    this.noteActivity(agent.id)
    const membership = this.speaker(agent)
    if (membership === undefined) return
    this.ctx.emit('room/stream', {
      teamId: membership.id,
      participantId: agent.id,
      participantName: membership.name,
      frame,
    })
  }

  /**
   * Deliver the room context and one instruction to a participant.
   * @param caller - exact live Team member granting the floor.
   * @param request - target name, instruction, and cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async prompt(caller: Agent, request: RoomPromptRequest): Promise<RoomPromptResult> {
    const membership = this.membership(caller)
    const target = requiredText(request.target, 'target', 200)
    if (target === membership.name) {
      throw new TeamError('a room participant cannot prompt itself', 'TEAM_ROOM_SELF_PROMPT')
    }
    const content = this.contextContent(membership.root.id, target, request.instruction)
    return await this.mailbox.send(caller, { target, content, signal: request.signal })
  }

  /**
   * Open or supersede one collective decision and ask every eligible reviewer to settle it.
   * @param caller - exact live Team member proposing the decision.
   * @param request - statement, optional superseded proposal, and cancellation.
   * @returns the new revision with its quorum arithmetic.
   */
  async propose(caller: Agent, request: ProposeRoomDecisionRequest): Promise<RoomProposalView> {
    const membership = this.membership(caller)
    const statement = requiredText(request.statement, 'statement', 4_000)
    const proposal = await this.journal.transact(membership.root.id, async () => {
      request.signal.throwIfAborted()
      const state = this.journal.state(membership.root)
      if (this.eligibleReviewers(state, caller.id).length === 0) {
        throw new TeamError(
          'a collective decision needs at least one reviewer besides its proposer',
          'TEAM_ROOM_NO_REVIEWERS',
        )
      }
      const prior = request.supersedes === undefined ? undefined : this.revisableProposal(state, request.supersedes)
      const revision = prior === undefined ? 1 : prior.revision + 1
      if (revision > this.config.maxProposalRevisions) {
        throw new TeamError(
          `room decision reached its ${this.config.maxProposalRevisions}-revision limit and must be escalated`,
          'TEAM_ROOM_REVISION_LIMIT',
        )
      }
      const next: RoomProposalSnapshot = {
        id: prior?.id ?? RoomProposalId(`proposal-${state.nextProposalNumber}`),
        revision,
        proposerId: caller.id,
        statement,
        phase: 'open',
      }
      await this.journal.appendAndFlush(membership.root, 'room/proposal', {
        version: 1,
        teamId: TeamId(membership.root.id),
        proposal: next,
      })
      return next
    })
    this.published(membership.root.id)
    // Resolve the timer before asking anyone, so a composition that cannot serve
    // a deadline fails before the room delivers its requests.
    this.requireTimer()
    try {
      await this.requestReviews(caller, proposal)
    } finally {
      // A refused delivery still leaves a committed open decision, so the
      // deadline is armed either way; otherwise nothing would ever settle it.
      this.armReview(membership.root, proposal)
    }
    return this.proposalView(membership.root.id, proposal.id)
  }

  /**
   * Record one participant's standing on one proposal revision.
   * @param caller - exact live Team member reviewing the decision.
   * @param request - proposal identity, revision, verdict, reason, and cancellation.
   * @returns the decision with its recomputed quorum arithmetic.
   */
  async review(caller: Agent, request: ReviewRoomDecisionRequest): Promise<RoomProposalView> {
    const membership = this.membership(caller)
    const reason = requiredText(request.reason, 'reason', 2_000)
    const settled = await this.journal.transact(membership.root.id, async () => {
      request.signal.throwIfAborted()
      const state = this.journal.state(membership.root)
      const proposal = this.openProposal(state, request.proposalId)
      if (proposal.proposerId === caller.id) {
        throw new TeamError('a proposer cannot review its own decision', 'TEAM_ROOM_SELF_REVIEW')
      }
      if (request.proposalRevision !== proposal.revision) {
        throw new TeamError(
          `room decision "${proposal.id}" is at revision ${proposal.revision}`,
          'TEAM_ROOM_STALE_REVISION',
        )
      }
      const review: RoomReviewSnapshot = {
        proposalId: proposal.id,
        proposalRevision: proposal.revision,
        reviewerId: caller.id,
        verdict: request.verdict,
        reason,
      }
      await this.journal.appendAndFlush(membership.root, 'room/review', {
        version: 1,
        teamId: TeamId(membership.root.id),
        review,
      })
      const tally = this.tally(this.journal.state(membership.root), proposal)
      if (tally.phase === 'open') return undefined
      const settledProposal: RoomProposalSnapshot = { ...proposal, phase: tally.phase }
      await this.journal.appendAndFlush(membership.root, 'room/proposal', {
        version: 1,
        teamId: TeamId(membership.root.id),
        proposal: settledProposal,
      })
      return { proposal: settledProposal, tally }
    })
    this.published(membership.root.id)
    if (settled !== undefined) {
      this.disarmReview(membership.root.id, request.proposalId)
      // The standing is already durable, so the notice is best effort.
      await this.notify(() => this.announceOutcome(membership.root.id, caller, settled.proposal, settled.tally))
    }
    else {
      const current = this.journal.state(membership.root).roomProposals.find(c => c.id === request.proposalId)
      /* v8 ignore next -- the proposal this call just read is always present. */
      if (current !== undefined) this.armReview(membership.root, current)
    }
    return this.proposalView(membership.root.id, request.proposalId)
  }

  /**
   * Hand one unresolved decision to the human.
   * @param caller - exact live Team member escalating the decision.
   * @param request - proposal identity, reason, and cancellation.
   * @returns the escalated decision.
   */
  async escalate(caller: Agent, request: EscalateRoomDecisionRequest): Promise<RoomProposalView> {
    const membership = this.membership(caller)
    const reason = requiredText(request.reason, 'reason', 2_000)
    const proposal = await this.journal.transact(membership.root.id, async () => {
      request.signal.throwIfAborted()
      const current = this.openProposal(this.journal.state(membership.root), request.proposalId)
      await this.journal.appendAndFlush(membership.root, 'room/proposal', {
        version: 1,
        teamId: TeamId(membership.root.id),
        proposal: { ...current, phase: 'escalated' },
      })
      return current
    })
    this.published(membership.root.id)
    this.disarmReview(membership.root.id, request.proposalId)
    // Delivery takes its own root transaction to checkpoint the receipt, so it
    // must run after this one commits rather than nested inside it.
    if (membership.role !== 'lead') {
      await this.notify(() => this.mailbox.send(caller, {
        target: 'lead',
        content: [{ type: 'text', text: `Room decision ${proposal.id} needs a human decision: ${reason}` }],
        signal: request.signal,
      }))
    }
    return this.proposalView(membership.root.id, request.proposalId)
  }

  /**
   * Run one notice that follows an already committed room change. A refused
   * delivery must not report the committed change as failed, which would make
   * the caller repeat an operation the log has already recorded.
   * @param notice - delivery to attempt; only its outcome is observed here.
   */
  private async notify(notice: () => Promise<unknown>): Promise<void> {
    try {
      await notice()
    } catch (error: unknown) {
      /* v8 ignore next -- a notice refused because the room is disposing is the only quiet path. */
      if (this.lifecycle.disposed) return
      this.ctx.logger.warn(`room notice failed: ${errorMessage(error)}`)
    }
  }

  /**
   * Read the current room roster, transcript, and decision board.
   * @param caller - exact live Team member reading the room.
   * @returns detached current room views.
   */
  view(caller: Agent): RoomView {
    // Reading is total: a composition without rooms has no room, which is a
    // state a browser panel renders, not a failure it reports. Mutations still
    // refuse, so nothing can be recorded into a room that is not mounted.
    if (!this.config.enabled) {
      return { enabled: false, participants: [], chair: 'lead', messages: [], proposals: [] }
    }
    const membership = this.membership(caller)
    const rootId = membership.root.id
    const state = this.journal.state(membership.root)
    const participants = this.participants(rootId, state)
    return {
      enabled: true,
      participants: participants.map(participant => this.participantView(rootId, participant)),
      chair: chairOf(participants, state.roomMessages.length),
      messages: state.roomMessages.map(message => ({
        id: message.id,
        authorName: this.nameOf(rootId, state, message.authorId),
        content: structuredClone(message.content),
      } satisfies RoomMessageView)),
      proposals: state.roomProposals.map(proposal => this.proposalView(rootId, proposal.id)),
    }
  }

  /**
   * Build the browser-facing room snapshot with transcript entries rendered to text.
   * @param caller - exact live Team member reading the room.
   * @returns the room roster, rendered transcript, and decision board.
   */
  remoteView(caller: Agent): RoomRemoteView {
    const view = this.view(caller)
    return {
      enabled: view.enabled,
      participants: view.participants,
      chair: view.chair,
      messages: view.messages.map(message => ({
        author: message.authorName,
        text: textOf(message.content),
      })),
      proposals: view.proposals,
    }
  }

  /**
   * Record that one participant produced activity, durable or streamed.
   * @param id - participant Session identity.
   */
  private noteActivity(id: SessionId): void {
    this.activity.set(id, Date.now())
  }

  /** Notify live readers that this room committed a change. */
  private published(rootId: SessionId): void {
    this.ctx.emit('room/updated', { teamId: TeamId(rootId) })
  }

  /**
   * Arm the stall check for every open decision the Lead still owns.
   * @param root - exact live Team Lead.
   */
  resume(root: Agent): void {
    if (!this.config.enabled) return
    for (const proposal of this.journal.state(root).roomProposals) this.armReview(root, proposal)
  }

  /** Release every armed stall check. */
  dispose(): void {
    for (const timer of this.reviewTimers.values()) timer()
    this.reviewTimers.clear()
  }

  /** Arm one revision's stall check at its earliest deadline, replacing any armed check. */
  private armReview(root: Agent, proposal: RoomProposalSnapshot): void {
    this.disarmReview(root.id, proposal.id)
    if (proposal.phase !== 'open') return
    const key = reviewTimerKey(root.id, proposal.id)
    const now = Date.now()
    const pending = this.deadlines(this.tally(this.journal.state(root), proposal).awaiting, now)
      .map(candidate => candidate.at)
      .filter(at => at > now)
    // The grace window floors the delay, so a revision whose reviewers are all
    // already stalled is still rechecked once more rather than never.
    const delay = Math.max(0, Math.min(now + this.config.reviewGraceMs, ...pending) - now)
    const arm = this.requireTimer().timeout(() => {
      this.reviewTimers.delete(key)
      /* v8 ignore next 4 -- containment for an unexpected failure inside the sweep. */
      void this.sweepReview(root, proposal.id).catch((error: unknown) => {
        if (this.lifecycle.disposed) return
        this.ctx.logger.warn(`room stall check failed: ${errorMessage(error)}`)
      })
    }, delay)
    this.reviewTimers.set(key, arm)
  }

  /**
   * Remind reviewers that produced no own work, or hand the decision to the
   * human once every reviewer still owing a standing has exhausted its window.
   * A reviewer that is still streaming is never counted silent: frames count as
   * activity, and a reminder restarts the window of the reviewer it reaches.
   */
  private async sweepReview(root: Agent, proposalId: RoomProposalIdType): Promise<void> {
    const state = this.journal.state(root)
    const proposal = state.roomProposals.find(candidate => candidate.id === proposalId)
    /* v8 ignore next 2 -- settling a decision disarms its deadline, so the sweep
       only ever runs for a decision that is still open. */
    if (proposal?.phase !== 'open') return
    const tally = this.tally(state, proposal)
    const now = Date.now()
    const deadlines = this.deadlines(tally.awaiting, now)
    const stalled = deadlines.filter(candidate => candidate.at <= now).map(candidate => candidate.id)
    const reminders = state.roomTimeouts.filter(timeout => timeout.proposalId === proposal.id
      && timeout.proposalRevision === proposal.revision
      && timeout.kind === 'reminder').length
    // Nudge first: a reminded reviewer is given its grace window back before the
    // room hands the decision to the human.
    if (stalled.length > 0 && reminders < this.config.reviewReminders) {
      await this.recordTimeout(root, proposal, 'reminder', stalled)
      await this.promptStalled(root, proposal, stalled)
      this.armReview(root, proposal)
      return
    }
    // A reviewer still inside its grace window keeps the decision open, so an
    // escalation never pre-empts a deadline the room has not reached.
    if (deadlines.some(candidate => candidate.at > now)) {
      this.armReview(root, proposal)
      return
    }
    await this.recordTimeout(root, proposal, 'escalated', stalled)
    await this.announceAbandonment(root, proposal, stalled)
  }

  /**
   * Stall deadline per awaiting reviewer, measured from that reviewer's last
   * observed activity. A reviewer this process has not observed gets a full
   * grace window rather than an immediate stall, so no deadline depends on
   * process uptime.
   */
  private deadlines(awaiting: readonly SessionId[], now: number): Array<{ id: SessionId; at: number }> {
    return awaiting.map((id) => {
      // A reviewer this process has not observed is anchored to the moment it
      // was first awaited, so its deadline is stable and the sweep converges.
      let seen = this.activity.get(id)
      if (seen === undefined) {
        seen = now
        this.activity.set(id, seen)
      }
      return { at: seen + this.config.reviewGraceMs, id }
    })
  }

  /** Append one durable abandonment record. */
  private async recordTimeout(
    root: Agent,
    proposal: RoomProposalSnapshot,
    kind: RoomReviewTimeoutKind,
    stalled: SessionId[],
  ): Promise<void> {
    await this.journal.transact(root.id, async () => {
      await this.journal.appendAndFlush(root, 'room/review-timeout', {
        version: 1,
        teamId: TeamId(root.id),
        timeout: { proposalId: proposal.id, proposalRevision: proposal.revision, kind, stalled },
      })
    })
    this.published(root.id)
  }

  /** Re-prompt stalled reviewers and re-arm the check. */
  private async promptStalled(
    root: Agent,
    proposal: RoomProposalSnapshot,
    stalled: readonly SessionId[],
  ): Promise<void> {
    const state = this.journal.state(root)
    for (const id of stalled) {
      // The Lead's own silence is the human's to resolve; it is not a peer to wake.
      if (id === root.id) continue
      await this.mailbox.send(root, {
        target: this.nameOf(root.id, state, id),
        content: [{
          type: 'text',
          text: `Room decision ${proposal.id} (revision ${proposal.revision}) is still waiting for your standing. `
            + 'Call room_review with approve, reject, or abstain and a reason.',
        }],
        signal: this.lifecycle.signal,
      })
      this.noteActivity(id)
    }
  }

  /**
   * Record the escalation that the human resolves. Committing the record wakes
   * every waiter through the room's own change notification, which is why this
   * does not also address the Lead: the Lead is the room, and a peer message
   * from it to itself is not a delivery.
   */
  private async announceAbandonment(
    root: Agent,
    proposal: RoomProposalSnapshot,
    stalled: readonly SessionId[],
  ): Promise<void> {
    await this.journal.transact(root.id, async () => {
      const current = this.journal.state(root).roomProposals.find(candidate => candidate.id === proposal.id)
      /* v8 ignore next -- only a concurrent settle can close the decision this sweep just read. */
      if (current === undefined || current.phase !== 'open') return
      await this.journal.appendAndFlush(root, 'room/proposal', {
        version: 1,
        teamId: TeamId(root.id),
        proposal: { ...current, phase: 'escalated' },
      })
    })
    this.published(root.id)
    this.ctx.logger.info(
      `room decision ${proposal.id} escalated: ${String(stalled.length)} reviewer(s) produced no activity for `
      + `${String(this.config.reviewGraceMs)}ms`,
    )
  }

  /** Resolve the caller's membership or refuse the room operation. */
  private membership(caller: Agent): TeamMembership {
    if (!this.config.enabled) {
      throw new TeamError('room operations are disabled in this composition', 'TEAM_ROOM_DISABLED')
    }
    return this.roster.membership(caller)
  }

  /**
   * Resolve the membership of one Agent whose turns the room transcribes and
   * streams. Every root Agent is an implicit Lead, so a room opens with its
   * Team's first teammate; until then the Lead's turns are its own
   * conversation. The roster never shrinks, so a turn streamed into an open
   * room is transcribed when it commits.
   * @param agent - Agent whose streamed frame or committed message is observed.
   * @returns its Team membership, or undefined when the room ignores its turns.
   */
  private speaker(agent: Agent): TeamMembership | undefined {
    const membership = this.roster.tryMembership(agent)
    if (membership === undefined) return undefined
    let state: TeamState
    try {
      state = this.journal.state(membership.root)
    } catch {
      // A Lead log the Team projection refused opens no room. Team operations
      // report the refusal; this runs for every streamed chunk, so it does not.
      return undefined
    }
    return state.members.length === 0 ? undefined : membership
  }

  /** Release the armed stall check for one decision of one Lead. */
  private disarmReview(rootId: SessionId, id: RoomProposalIdType): void {
    const key = reviewTimerKey(rootId, id)
    this.reviewTimers.get(key)?.()
    this.reviewTimers.delete(key)
  }

  /** Resolve one open proposal or refuse the operation. */
  private openProposal(state: TeamState, id: RoomProposalIdType): RoomProposalSnapshot {
    const proposal = this.revisableProposal(state, id)
    if (proposal.phase !== 'open') {
      throw new TeamError(`room decision "${id}" is already ${proposal.phase}`, 'TEAM_ROOM_PROPOSAL_SETTLED')
    }
    return proposal
  }

  /**
   * Resolve one decision its proposer may still supersede. An accepted or
   * escalated decision is final; a rejected one is resolved only by carrying a
   * revised statement back to the room.
   */
  private revisableProposal(state: TeamState, id: RoomProposalIdType): RoomProposalSnapshot {
    const proposal = state.roomProposals.find(candidate => candidate.id === id)
    /* v8 ignore next -- every caller passes an identity committed by the operation that called it. */
    if (proposal === undefined) throw new TeamError(`room decision "${id}" not found`, 'TEAM_ROOM_PROPOSAL_NOT_FOUND')
    if (proposal.phase === 'accepted' || proposal.phase === 'escalated') {
      throw new TeamError(`room decision "${id}" is already ${proposal.phase}`, 'TEAM_ROOM_PROPOSAL_SETTLED')
    }
    return proposal
  }

  /**
   * Participants in creation order, Lead first. A member is a participant from
   * the moment provisioning records it until it fails, which is the same rule
   * the roster uses to resolve a live member's Team identity.
   */
  private participants(rootId: SessionId, state: TeamState): RoomParticipant[] {
    const result: RoomParticipant[] = [{ id: rootId, name: 'lead', reachable: true }]
    for (const member of state.members) {
      if (member.phase !== 'failed') {
        result.push({
          id: member.id,
          name: member.name,
          reachable: member.phase === 'active',
          ...member.agentModel === undefined ? {} : { agentModel: member.agentModel },
        })
      }
    }
    return result
  }

  /**
   * The timer service, optional for Team compositions and required once a room
   * arms a review deadline.
   */
  private requireTimer(): TimerService {
    const timer = this.ctx.get('timer')
    if (timer === undefined) {
      throw new TeamError(
        'room review deadlines need the timer plugin mounted in this composition',
        'TEAM_TIMER_REQUIRED',
      )
    }
    return timer
  }

  /**
   * Reviewers one decision may count on: every addressable participant other
   * than the proposer. A member that is still provisioning is a participant the
   * room shows but cannot ask, so it never holds a decision open.
   */
  private eligibleReviewers(state: TeamState, proposerId: SessionId): RoomParticipant[] {
    return this.participants(brandString<SessionId>(state.id), state)
      .filter(candidate => candidate.reachable && candidate.id !== proposerId)
  }

  /** Resolve one durable participant name for transcript attribution. */
  private nameOf(rootId: SessionId, state: TeamState, id: SessionId): string {
    if (id === rootId) return 'lead'
    /* v8 ignore next -- every attributed identity comes from this roster. */
    return state.members.find(member => member.id === id)?.name ?? id
  }

  /** Build one runtime participant row. */
  private participantView(rootId: SessionId, participant: RoomParticipant): RoomParticipantView {
    const live = participant.id === rootId ? this.ctx.agents.get(rootId) : this.ctx.agents.get(participant.id)
    const model = participant.agentModel ?? live?.options.model
    // The same window the stall sweep uses, so a board that shows a quiet
    // participant is showing exactly the loaded reviewer the room is waiting on.
    const seen = this.activity.get(participant.id)
    return {
      id: participant.id,
      name: participant.name,
      status: availability(live),
      quiet: seen !== undefined
        && live !== undefined
        && Date.now() - seen >= this.config.reviewGraceMs,
      ...model === undefined ? {} : { model },
    }
  }

  /**
   * Latest recorded standing per reviewer for one decision revision, keyed by
   * reviewer so a changed verdict replaces the earlier one in place.
   */
  private latestStandingsFor(
    state: TeamState,
    proposalId: RoomProposalIdType,
    revision: number,
  ): Map<SessionId, RoomReviewSnapshot> {
    const latest = new Map<SessionId, RoomReviewSnapshot>()
    for (const review of state.roomReviews) {
      if (review.proposalId !== proposalId || review.proposalRevision !== revision) continue
      latest.set(review.reviewerId, review)
    }
    return latest
  }

  /** Compute the quorum arithmetic for one proposal's current revision. */
  private tally(state: TeamState, proposal: RoomProposalSnapshot): RoomTally {
    return tallyProposal(
      this.eligibleReviewers(state, proposal.proposerId).map(candidate => candidate.id),
      state.roomReviews,
      proposal.id,
      proposal.revision,
      this.config.approvalRatio,
    )
  }

  /** Build one proposal view from durable state. */
  private proposalView(rootId: SessionId, id: RoomProposalIdType): RoomProposalView {
    const state = this.journal.state(this.rootAgent(rootId))
    const proposal = state.roomProposals.find(candidate => candidate.id === id)
    /* v8 ignore next -- every caller passes an identity committed by the operation that called it. */
    if (proposal === undefined) throw new TeamError(`room decision "${id}" not found`, 'TEAM_ROOM_PROPOSAL_NOT_FOUND')
    const tally = this.tally(state, proposal)
    const render = (ids: readonly SessionId[]): string[] =>
      ids.map(candidate => this.nameOf(rootId, state, candidate))
    return {
      id: proposal.id,
      revision: proposal.revision,
      proposerName: this.nameOf(rootId, state, proposal.proposerId),
      statement: proposal.statement,
      phase: proposal.phase,
      requiredApprovals: tally.requiredApprovals,
      stalled: render(state.roomTimeouts
        .filter(timeout => timeout.proposalId === proposal.id
          && timeout.proposalRevision === proposal.revision
          && timeout.kind === 'escalated')
        .at(-1)?.stalled ?? []),
      approvals: render(tally.approvals),
      rejections: render(tally.rejections),
      abstentions: render(tally.abstentions),
      standings: [...this.latestStandingsFor(state, proposal.id, proposal.revision).values()]
        .map(review => ({
          reviewer: this.nameOf(rootId, state, review.reviewerId),
          verdict: review.verdict,
          reason: review.reason,
        })),
      // A settled decision awaits nobody: a reviewer that never voted cannot
      // change an outcome that quorum already reached.
      awaiting: proposal.phase === 'open' ? render(tally.awaiting) : [],
    }
  }

  /** Recover the exact live Lead Agent owning one room. */
  private rootAgent(rootId: SessionId): Agent {
    const root = this.ctx.agents.get(rootId)
    /* v8 ignore next -- a room operation runs inside a call that resolved this Lead as live. */
    if (root === undefined) throw new TeamError('room Lead Agent is not live', 'TEAM_ROOM_NOT_LIVE')
    return root
  }

  /** Ask every eligible reviewer to settle the current revision. */
  private async requestReviews(caller: Agent, proposal: RoomProposalSnapshot): Promise<void> {
    const rootId = (this.roster.membership(caller)).root.id
    const state = this.journal.state(this.rootAgent(rootId))
    const instruction: ContentBlock[] = [{
      type: 'text',
      text: `Room decision ${proposal.id} (revision ${proposal.revision}) needs your standing.\n\nStatement:\n${proposal.statement}\n\nCall room_review with verdict approve, reject, or abstain and a reason. Approve only if you would defend this decision yourself. Reject when you found a specific problem; state it in the reason.`,
    }]
    for (const reviewer of this.eligibleReviewers(state, proposal.proposerId)) {
      await this.mailbox.send(caller, {
        target: reviewer.name,
        content: this.contextContent(rootId, reviewer.name, instruction),
        signal: this.lifecycle.signal,
      })
      // The ask starts this reviewer's grace window: a participant that was
      // already quiet when the decision opened is still owed the chance to
      // answer it, and delivery to a busy participant is only queued.
      this.noteActivity(reviewer.id)
    }
  }

  /** Tell the proposer the collective outcome. */
  private async announceOutcome(
    rootId: SessionId,
    caller: Agent,
    proposal: RoomProposalSnapshot,
    tally: RoomTally,
  ): Promise<void> {
    const state = this.journal.state(this.rootAgent(rootId))
    const render = (ids: readonly SessionId[]): string =>
      ids.map(candidate => this.nameOf(rootId, state, candidate)).join(', ') || 'none'
    const text = [
      `Room decision ${proposal.id} (revision ${proposal.revision}) is ${tally.phase}.`,
      `approvals: ${render(tally.approvals)}`,
      `rejections: ${render(tally.rejections)}`,
      `abstentions: ${render(tally.abstentions)}`,
    ].join('\n')
    await this.mailbox.send(caller, {
      target: this.nameOf(rootId, state, proposal.proposerId),
      content: [{ type: 'text', text }],
      signal: this.lifecycle.signal,
    })
  }

  /** Build the room context followed by one instruction. */
  private contextContent(rootId: SessionId, target: string, instruction: ContentBlock[]): ContentBlock[] {
    const state = this.journal.state(this.rootAgent(rootId))
    const transcript = this.transcriptDelta(rootId, state, target)
    return [
      ...transcript.length === 0
        ? []
        : [{ type: 'text' as const, text: `Room conversation so far:\n${transcript.join('\n')}` }],
      ...structuredClone(instruction),
    ]
  }

  /** Render transcript entries after the target's own last utterance, bounded by the configured window. */
  private transcriptDelta(rootId: SessionId, state: TeamState, target: string): string[] {
    const targetId = target === 'lead'
      ? rootId
      : state.members.find(member => member.name === target)?.id
    let start = 0
    if (targetId !== undefined) {
      for (const [position, message] of state.roomMessages.entries()) {
        if (message.authorId === targetId) start = position + 1
      }
    }
    return state.roomMessages
      .slice(Math.max(start, state.roomMessages.length - this.config.transcriptWindow))
      .map(message => `${this.nameOf(rootId, state, message.authorId)}: ${textOf(message.content)}`)
  }
}

/**
 * Model-facing name of the participant that holds the floor for the next utterance.
 * The rotation carries no decision authority: every participant votes through
 * {@link TeamRoom.review} under the same quorum.
 * @param participants - current room participants, Lead first.
 * @param messageCount - utterances recorded so far, which advances the rotation.
 * @returns the name of the participant speaking next.
 */
function chairOf(participants: readonly RoomParticipant[], messageCount: number): string {
  const index = messageCount % participants.length
  let chair = 'lead'
  for (const [position, participant] of participants.entries()) {
    if (position === index) chair = participant.name
  }
  return chair
}

/**
 * Key one decision's stall check by its Lead as well as its id.
 * @param rootId - Lead Session that owns the decision.
 * @param id - Team-local decision identity.
 * @returns a key no other Lead's decision shares.
 */
function reviewTimerKey(rootId: SessionId, id: RoomProposalIdType): string {
  return `${rootId}\u0000${id}`
}

/** Join the text content of one message for model-facing transcript rendering. */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Keep only the non-empty text content of one assistant message. */
function messageText(content: readonly ContentBlock[]): ContentBlock[] {
  return content.filter((block): block is { type: 'text'; text: string } =>
    block.type === 'text' && block.text.length > 0)
}
