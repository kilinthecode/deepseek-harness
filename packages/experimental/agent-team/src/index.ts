/** Agent Teams service façade over roster, mailbox, task, and runtime lifecycle owners. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TeamActivity } from './activity.ts'
import { errorMessage, TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { TeamRuntimeLifecycle } from './lifecycle.ts'
import { TeamMailbox } from './mailbox.ts'
import { teamProjectionDefinition } from './projection.ts'
import { TeamRoom } from './room.ts'
import { TeamRoster } from './roster.ts'
import { TeamTaskBoard } from './task-board.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type { SpawnTeammateRequest, TeamMembership } from './roster.ts'
import type {
  Config,
  CreateTeamTaskRequest,
  EscalateRoomDecisionRequest,
  ProposeRoomDecisionRequest,
  ReviewRoomDecisionRequest,
  RoomPromptRequest,
  RoomPromptResult,
  RoomProposalView,
  RoomRemoteView,
  RoomView,
  RoomFollowFrame,
  SendTeamMessageRequest,
  SendTeamMessageResult,
  SpawnTeammateResult,
  TeamMemberView,
  TeamTaskMutationResult,
  TeamTaskView,
  TeamView,
  TeamWaitResult,
  UpdateTeamTaskRequest,
} from './types.ts'

export type * from './types.ts'
export type { SpawnTeammateRequest, TeamMembership } from './roster.ts'
export type { RoomConfig, RoomStreamFrame } from './room.ts'
export { TeamId, TeamMessageId, TeamTaskId, RoomMessageId, RoomProposalId } from './types.ts'
export { TeamError } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
  }
}

const DEFAULT_MAX_MEMBERS = 16
const DEFAULT_MAX_TASKS = 256
const DEFAULT_MAX_PENDING_MESSAGES = 64
const DEFAULT_MAX_MESSAGE_BYTES = 65_536
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000
const DEFAULT_ROOM_TRANSCRIPT_WINDOW = 20
const DEFAULT_ROOM_APPROVAL_RATIO = 0.5
const DEFAULT_ROOM_MAX_PROPOSAL_REVISIONS = 4
const DEFAULT_ROOM_REVIEW_GRACE_MS = 120_000
const DEFAULT_ROOM_REVIEW_REMINDERS = 1

/** Validate one positive safe-integer deployment limit. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Validate one non-negative safe-integer deployment limit. */
function nonNegativeLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TeamError(`${name} must be a non-negative safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Validate one approval ratio expressed as a fraction of eligible reviewers. */
function approvalRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TeamError('roomApprovalRatio must be greater than 0 and at most 1', 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents', 'llm']

  static Config: z<Config> = z.object({
    maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_MESSAGES),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
    roomEnabled: z.boolean().default(false),
    roomTranscriptWindow: z.number().step(1).min(1).default(DEFAULT_ROOM_TRANSCRIPT_WINDOW),
    roomApprovalRatio: z.number().min(0.01).max(1).default(DEFAULT_ROOM_APPROVAL_RATIO),
    roomMaxProposalRevisions: z.number().step(1).min(1).default(DEFAULT_ROOM_MAX_PROPOSAL_REVISIONS),
    roomReviewGraceMs: z.number().step(1).min(1).default(DEFAULT_ROOM_REVIEW_GRACE_MS),
    roomReviewReminders: z.number().step(1).min(0).default(DEFAULT_ROOM_REVIEW_REMINDERS),
  })

  /** Validated deployment limits used by every Team operation. */
  private readonly config: Required<Config>

  private readonly activity: TeamActivity
  private readonly lifecycle: TeamRuntimeLifecycle
  private readonly journal: TeamJournal
  private readonly roster: TeamRoster
  private readonly mailbox: TeamMailbox
  private readonly tasks: TeamTaskBoard
  private readonly room: TeamRoom
  /** Open live room readers, ended when this service disposes. */
  private readonly roomReaders = new Set<RoomFollowQueue>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentTeams')
    this.config = {
      maxMembers: positiveLimit('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS),
      maxTasks: positiveLimit('maxTasks', config.maxTasks ?? DEFAULT_MAX_TASKS),
      maxPendingMessagesPerMember: positiveLimit(
        'maxPendingMessagesPerMember',
        config.maxPendingMessagesPerMember ?? DEFAULT_MAX_PENDING_MESSAGES,
      ),
      maxMessageBytes: positiveLimit('maxMessageBytes', config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
      disposalTimeoutMs: positiveLimit(
        'disposalTimeoutMs',
        config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
      ),
      roomEnabled: config.roomEnabled ?? false,
      roomTranscriptWindow: positiveLimit(
        'roomTranscriptWindow',
        config.roomTranscriptWindow ?? DEFAULT_ROOM_TRANSCRIPT_WINDOW,
      ),
      roomApprovalRatio: approvalRatio(config.roomApprovalRatio ?? DEFAULT_ROOM_APPROVAL_RATIO),
      roomMaxProposalRevisions: positiveLimit(
        'roomMaxProposalRevisions',
        config.roomMaxProposalRevisions ?? DEFAULT_ROOM_MAX_PROPOSAL_REVISIONS,
      ),
      roomReviewGraceMs: positiveLimit(
        'roomReviewGraceMs',
        config.roomReviewGraceMs ?? DEFAULT_ROOM_REVIEW_GRACE_MS,
      ),
      roomReviewReminders: nonNegativeLimit(
        'roomReviewReminders',
        config.roomReviewReminders ?? DEFAULT_ROOM_REVIEW_REMINDERS,
      ),
    }

    this.activity = new TeamActivity()
    this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs)
    this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) })
    this.roster = new TeamRoster(ctx, this.journal, this.lifecycle, this.config.maxMembers)
    this.mailbox = new TeamMailbox(
      ctx,
      this.journal,
      this.roster,
      this.lifecycle,
      this.config.maxPendingMessagesPerMember,
      this.config.maxMessageBytes,
    )
    this.tasks = new TeamTaskBoard(this.journal, this.config.maxTasks)
    this.room = new TeamRoom(ctx, this.journal, this.roster, this.mailbox, this.lifecycle, {
      enabled: this.config.roomEnabled,
      transcriptWindow: this.config.roomTranscriptWindow,
      approvalRatio: this.config.roomApprovalRatio,
      maxProposalRevisions: this.config.roomMaxProposalRevisions,
      reviewGraceMs: this.config.roomReviewGraceMs,
      reviewReminders: this.config.roomReviewReminders,
    })

    ctx.on('session/event', (session, event) => { this.mailbox.observeSessionEvent(session, event) })
    ctx.on('session/event', (session, event) => { this.room.observeSessionEvent(session, event) })
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (!this.config.roomEnabled) return
      // A streaming participant is working even before it commits a message.
      this.room.noteActivity(agent.id)
      const membership = this.roster.tryMembership(agent)
      if (membership === undefined) return
      ctx.emit('room/stream', {
        teamId: membership.id,
        participantId: agent.id,
        participantName: membership.name,
        frame,
      })
    }, { global: true })
    ctx.on('agent/created', ({ agent }) => { this.scheduleRecovery(agent) })
    ctx.on('agent/status', ({ agent }) => {
      const membership = this.roster.tryMembership(agent)
      if (membership !== undefined) this.activity.notify(membership.id)
    })
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(teamProjectionDefinition)
      return async () => {
        try {
          await this.disposeRuntime()
        } finally {
          disposeProjection()
        }
      }
    }, 'agentTeams.runtimeLifecycle()')
    for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    return this.roster.membership(agent)
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param agent - exact live Team member.
   * @returns Lead and teammate rows in creation order.
   */
  listMembers(agent: Agent): TeamMemberView[] {
    return this.roster.list(this.roster.membership(agent))
  }

  /**
   * Create one named, continuable direct child of the Team Lead.
   * @param caller - exact live Lead Agent.
   * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
   * @returns the active roster row.
   */
  async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    return await this.roster.spawn(caller, request)
  }

  /**
   * Queue one durable peer message, then attempt immediate delivery.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, and pre-queue cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    return await this.mailbox.send(caller, request)
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.create(this.roster.membership(caller), request)
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param caller - exact live Team member reading the task.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView {
    return this.tasks.get(this.roster.membership(caller), id)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param caller - exact live Team member reading the board.
   * @returns detached current task views.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    return this.tasks.list(this.roster.membership(caller))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.update(caller, this.roster.membership(caller), request)
  }

  /**
   * Wait for the next Team-domain or member-status change.
   * @param caller - exact live Team member waiting for activity.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for the wait only.
   * @returns one observed change or a timeout result.
   */
  async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    const membership = this.roster.membership(caller)
    return await this.activity.wait(membership.id, timeoutMs, signal)
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' } {
    return this.roster.interrupt(caller, targetName)
  }

  /**
   * Resolve a caller without throwing, used by scoped-tool installation and observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.roster.tryMembership(agent)
  }

  /**
   * Give one room participant the floor, carrying the conversation it has not seen.
   * @param caller - exact live Team member granting the floor.
   * @param request - target name, instruction, and cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async roomPrompt(caller: Agent, request: RoomPromptRequest): Promise<RoomPromptResult> {
    return await this.room.prompt(caller, request)
  }

  /**
   * Put one collective decision to the room and ask every eligible reviewer to settle it.
   * @param caller - exact live Team member proposing the decision.
   * @param request - statement, optional superseded decision, and cancellation.
   * @returns the new revision with its quorum arithmetic.
   */
  async roomPropose(caller: Agent, request: ProposeRoomDecisionRequest): Promise<RoomProposalView> {
    return await this.room.propose(caller, request)
  }

  /**
   * Record one participant's standing on one decision revision.
   * @param caller - exact live Team member reviewing the decision.
   * @param request - decision identity, revision, verdict, reason, and cancellation.
   * @returns the decision with its recomputed quorum arithmetic.
   */
  async roomReview(caller: Agent, request: ReviewRoomDecisionRequest): Promise<RoomProposalView> {
    return await this.room.review(caller, request)
  }

  /**
   * Hand one unresolved decision to the human.
   * @param caller - exact live Team member escalating the decision.
   * @param request - decision identity, reason, and cancellation.
   * @returns the escalated decision.
   */
  async roomEscalate(caller: Agent, request: EscalateRoomDecisionRequest): Promise<RoomProposalView> {
    return await this.room.escalate(caller, request)
  }

  /**
   * Read the room roster, transcript, and decision board.
   * @param caller - exact live Team member reading the room.
   * @returns detached current room views.
   */
  roomView(caller: Agent): RoomView {
    return this.room.view(caller)
  }

  /**
   * Read the current roster and non-deleted task board through the generated Remote API.
   * @param agent - exact live Team member used as the authority credential.
   * @returns detached current roster and task views.
   */
  @Remote('view')
  remoteView(agent: Agent): TeamView {
    return {
      members: this.listMembers(agent),
      tasks: this.listTasks(agent),
    }
  }

  /**
   * Read the current room through the generated Remote API.
   * @param agent - exact live Team member used as the authority credential.
   * @returns the room roster, rendered transcript, and decision board.
   */
  @Remote('room')
  remoteRoom(agent: Agent): RoomRemoteView {
    return this.room.remoteView(agent)
  }

  /**
   * Follow one room through the generated Remote API.
   * @param agent - exact live Team member used as the authority credential.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns a complete view first, then a view after every committed room
   *   change and a frame for every text chunk a participant streams.
   */
  @Remote({ mode: 'stream' })
  async *roomStream(agent: Agent, signal: AbortSignal): AsyncIterable<RoomFollowFrame> {
    signal.throwIfAborted()
    const membership = this.roster.membership(agent)
    const root = membership.root
    const reader = new RoomFollowQueue()
    this.roomReaders.add(reader)
    const offUpdated = this.ctx.on('room/updated', (payload) => {
      if (payload.teamId !== membership.id) return
      reader.push({ type: 'view', view: this.room.remoteView(root) })
    })
    const offFrame = this.ctx.on('room/stream', (payload) => {
      if (payload.teamId !== membership.id) return
      if (payload.frame.type !== 'chunk' || payload.frame.chunk.type !== 'text-delta') return
      reader.push({ type: 'stream', participant: payload.participantName, delta: payload.frame.chunk.text })
    })
    try {
      yield { type: 'view', view: this.room.remoteView(root) }
      yield* reader.iterate(signal)
    } finally {
      offUpdated()
      offFrame()
      this.roomReaders.delete(reader)
      reader.end()
    }
  }

  /**
   * Create one shared task through the generated Remote API.
   * @param agent - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task or a typed Team rejection.
   */
  @Remote('createTask')
  remoteCreateTask(agent: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskMutationResult> {
    return this.taskMutationResult(this.createTask(agent, request))
  }

  /**
   * Apply one task mutation and preserve Team rejections as business results.
   * @param agent - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed task or a typed Team rejection.
   */
  @Remote('updateTask')
  remoteUpdateTask(agent: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskMutationResult> {
    return this.taskMutationResult(this.updateTask(agent, request))
  }

  /** Preserve Team task rejections while allowing unexpected failures to reject the Remote call. */
  private async taskMutationResult(operation: Promise<TeamTaskView>): Promise<TeamTaskMutationResult> {
    try {
      return { ok: true, value: await operation }
    } catch (error) {
      if (!(error instanceof TeamError)) throw error
      return {
        ok: false,
        error: {
          code: error.code === 'TEAM_TASK_STALE_REVISION' ? 'team-task-conflict' : 'team-rejected',
          message: error.message,
        },
      }
    }
  }

  /** Queue one contained recovery pass after publication has unwound. */
  private scheduleRecovery(agent: Agent): void {
    queueMicrotask(() => {
      if (this.lifecycle.disposed) return
      void this.recoverFor(agent).catch((error: unknown) => {
        if (this.lifecycle.disposed) return
        this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`)
      })
    })
  }

  /** Reconcile roster provisioning before retrying that member's pending mailbox. */
  private async recoverFor(agent: Agent): Promise<void> {
    await this.roster.recoverFor(agent, this.lifecycle.signal)
    await this.mailbox.recoverFor(agent, this.lifecycle.signal)
    // Stall checks are in-memory; a recovered Lead re-arms them from durable state.
    this.room.resume(agent)
  }

  /** Stop Team-owned live branches and release every waiter before service disposal completes. */
  private async disposeRuntime(): Promise<void> {
    this.lifecycle.close()
    this.activity.close()
    this.room.dispose()
    for (const reader of this.roomReaders) reader.end()
    this.roomReaders.clear()

    const failures: unknown[] = []
    await this.lifecycle.settle(this.roster.pendingCreations(), failures)
    await this.lifecycle.settle(this.mailbox.pendingDispatches(), failures)
    for (const [root, childIds] of this.roster.liveChildrenByRoot()) {
      try {
        await this.roster.stopTeammates(root, childIds)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams runtime disposal failed')
  }
}

/**
 * Buffered hand-off between the room's process-local notifications and one open
 * Remote stream. Frames queue until the consumer asks for them, and the queue is
 * finished by its own abort, by disposal, or by the consumer leaving.
 */
class RoomFollowQueue {
  private readonly buffer: RoomFollowFrame[] = []
  private wake: (() => void) | undefined
  private done = false

  /** Enqueue one frame for the open reader. */
  push(frame: RoomFollowFrame): void {
    /* v8 ignore next -- disposal ends the reader before its listeners stop, so a
       commit racing disposal is the only frame a finished queue can receive. */
    if (this.done) return
    this.buffer.push(frame)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /** Finish the reader: no further frame is delivered. */
  end(): void {
    if (this.done) return
    this.done = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /**
   * Yield buffered frames as they arrive until the reader finishes.
   * @param signal - caller cancellation for this stream.
   * @returns every frame committed while the reader stayed open.
   */
  async *iterate(signal: AbortSignal): AsyncIterable<RoomFollowFrame> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        const frame = this.buffer.shift()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.end()
    }
  }
}

export default TeamService
