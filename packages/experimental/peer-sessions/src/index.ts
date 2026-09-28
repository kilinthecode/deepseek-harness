/**
 * Peer sessions: independent top-level sessions that share one Harness home and
 * one repository coordinate through durable mailbox files, exposed as
 * `ctx.peers` with `list`, `send`, and `notifyIdle`.
 *
 * Peers group by repository ({@link peerRepoKey}), not by exact directory: two
 * worktrees of one repository see each other, while a session in the same
 * directory of another checkout does not. Presence, mailbox envelopes, and idle
 * watches live under `$DSH_HOME/peers/`, so sessions in different processes
 * coordinate without a shared parent. Only the process that holds a live target
 * drains that target's mailbox: it steers one `user/message` per envelope
 * through `Agent.steer()` and deletes the envelope once the log carries it. The
 * capability is off until a profile mounts the peer-sessions bundle.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions
 */

import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Agent, AgentStatus, InboxState } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
// Type-only: the `title` projection key this service reads for display names.
import type {} from '@deepseek-ai/dsh-session-title'
// Type-only: the `approval/asked` and `approval/decided` session events this service folds.
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: the `user-questions/request` waterfall this service observes.
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import {
  peerAmbiguous,
  peerIdleTurn,
  peerMessageTooLarge,
  peerNotTopLevel,
  peerNotFound,
  peerNoCwd,
  peerOtherRepository,
  peerRelayLimit,
  peerSelf,
  PeerError,
} from './errors.ts'
import {
  deleteMailFile,
  enqueueMail,
  framedBody,
  framedRelay,
  noticeSummary,
  PEER_MAIL_VERSION,
  readMailShard,
  type PeerMailboxLimits,
  type PeerMailEnvelope,
} from './mailbox.ts'
import { mailDirectory, mailShardDirectory, watchShardDirectory } from './paths.ts'
import { listPresence, readPresence, removePresence, writePresence } from './presence.ts'
import { removeEmptyShard } from './record.ts'
import { deleteWatch, listWatchShards, PEER_WATCH_VERSION, readWatchShard, writeWatch, type PeerWatchRecord } from './watches.ts'
import { peerDeliveryProjection, type PeerDeliveryState } from './projection.ts'
import { peerRepoKey } from './repo.ts'
import type {
  NotifyPeerIdleRequest,
  NotifyPeerIdleResult,
  PeerEntry,
  PeerMessageId,
  PeerStatus,
  SendPeerMessageRequest,
  SendPeerMessageResult,
} from './types.ts'

export { peerRepoKey }
export { PeerError }
export type { PeerErrorCode } from './errors.ts'
export type {
  NotifyPeerIdleRequest,
  NotifyPeerIdleResult,
  PeerEntry,
  PeerIdleSource,
  PeerMessageId,
  PeerMessageSource,
  PeerStatus,
  SendPeerMessageRequest,
  SendPeerMessageResult,
} from './types.ts'

/** Relay hops one peer conversation may accumulate before its user must re-engage. */
export const PEER_RELAY_DEPTH_LIMIT = 4

/** Steer attempts spent on one envelope before an undeliverable message is dropped. */
export const PEER_DELIVERY_ATTEMPTS = 3

const DEFAULT_POLL_MS = 1_000
const DEFAULT_MAX_PENDING_PER_TARGET = 8
const DEFAULT_MAX_PENDING_PER_SENDER_PER_TARGET = 4
const DEFAULT_MAX_MESSAGE_BYTES = 8_192
const DEFAULT_MAX_IDLE_WATCHES = 32
const DEFAULT_PEER_INBOUND = 'steer'

/** Peer-service deployment limits. Invalid values fail plugin load. */
export interface Config {
  /** Milliseconds between mailbox drain passes for every agent this process holds. */
  readonly pollMs?: number
  /** Maximum queued messages retained for one target session. */
  readonly maxPendingPerTarget?: number
  /** Maximum queued messages one sender may retain for one target; at most `maxPendingPerTarget`. */
  readonly maxPendingPerSenderPerTarget?: number
  /** Maximum UTF-8 bytes in one complete framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum idle subscriptions retained for one target session. */
  readonly maxIdleWatches?: number
  /** Whether an idle target receives a message in a new turn (`steer`) or holds it until it runs again (`deferred`). */
  readonly peerInbound?: 'steer' | 'deferred'
}

/** Schemastery validation for {@link Config}; omitted fields take the shipped values. */
export const Config: z<Config, ResolvedLimits> = z.object({
  pollMs: z.number().step(1).min(1).default(DEFAULT_POLL_MS),
  maxPendingPerTarget: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_PER_TARGET),
  maxPendingPerSenderPerTarget: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_PER_SENDER_PER_TARGET),
  maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
  maxIdleWatches: z.number().step(1).min(1).default(DEFAULT_MAX_IDLE_WATCHES),
  peerInbound: z.union(['steer', 'deferred']).default(DEFAULT_PEER_INBOUND),
})

/** Reject one stated deployment limit that is not a positive safe integer. */
function requirePositiveLimit(name: string, value: number | undefined): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`peer-sessions: ${name} must be a positive safe integer, got ${value}`)
  }
}

/** Reject an inbound delivery mode that is not one of the two implemented modes. */
function requirePeerInbound(value: string | undefined): void {
  if (value !== undefined && value !== 'steer' && value !== 'deferred') {
    throw new Error(`peer-sessions: peerInbound must be 'steer' or 'deferred', got ${value}`)
  }
}

/**
 * Validate one peer-session configuration at load and apply the shipped defaults.
 * @param config - stated limits; omitted fields take the shipped values, so this checks only what a caller set.
 * @throws when a limit is not a positive safe integer, the inbound mode is unknown, or the sender cap exceeds the target cap.
 */
function resolveLimits(config: Config): ResolvedLimits {
  requirePositiveLimit('pollMs', config.pollMs)
  requirePositiveLimit('maxPendingPerTarget', config.maxPendingPerTarget)
  requirePositiveLimit('maxPendingPerSenderPerTarget', config.maxPendingPerSenderPerTarget)
  requirePositiveLimit('maxMessageBytes', config.maxMessageBytes)
  requirePositiveLimit('maxIdleWatches', config.maxIdleWatches)
  requirePeerInbound(config.peerInbound)
  // The plugin config slot hands the service already-defaulted values; parsing
  // them again resolves the same defaults for a service built from a partial
  // config, so one schema owns what every limit defaults to.
  const limits = Config(config)
  if (limits.maxPendingPerSenderPerTarget > limits.maxPendingPerTarget) {
    throw new Error('peer-sessions: maxPendingPerSenderPerTarget must not exceed maxPendingPerTarget')
  }
  return limits
}

/** Every peer limit with its shipped default applied. */
interface ResolvedLimits {
  readonly pollMs: number
  readonly maxPendingPerTarget: number
  readonly maxPendingPerSenderPerTarget: number
  readonly maxMessageBytes: number
  readonly maxIdleWatches: number
  readonly peerInbound: 'steer' | 'deferred'
}

/** Render one thrown value for a warning line without replacing the original rejection. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return inspect(error, { breakLength: Infinity, compact: true, depth: 4 })
}

/** Where one session's peers live: its recorded directory and that directory's repository key. */
interface PeerLocation {
  /** Working directory recorded on the session header. */
  readonly cwd: string
  /** Repository key of that directory; peers group by it, not by the exact directory. */
  readonly repoKey: string
}

/** Process-local peer state of one agent this service observed being created. */
interface AgentPeerState {
  /** The live agent this state describes. */
  readonly agent: Agent
  /** Repository location of that session, or `undefined` when it has no usable working directory. */
  readonly location: PeerLocation | undefined
  /** Approval questions raised in this process and not yet decided. */
  openAsks: number
  /** Whether a user question from this agent is waiting for its answer. */
  questioning: boolean
  /** Envelope ids this process steered and has not settled as delivered or failed. */
  readonly inFlight: Set<PeerMessageId>
  /** Steer attempts already spent on an in-flight envelope. */
  readonly attempts: Map<PeerMessageId, number>
}

/** The caller's authorization facts. */
interface PeerCaller {
  /** Repository key that scopes every peer this caller may address. */
  readonly repoKey: string
}

/** One addressable peer: a presence row, and in this process its live agent. */
interface PeerCandidate {
  readonly id: SessionId
  readonly name: string
  readonly repoKey: string | undefined
  readonly cwd: string
  readonly status: PeerStatus
  readonly live: Agent | undefined
  readonly topLevel: boolean
}

/** A resolved target, ready to receive an envelope. */
interface ResolvedPeer {
  readonly id: SessionId
  readonly name: string
  readonly repoKey: string
  readonly cwd: string
  readonly status: PeerStatus
  readonly live: Agent | undefined
}

/**
 * One agent's queue of mailbox drain passes.
 *
 * A pass that already began reading the mailbox cannot see an envelope
 * committed after that read, so a caller that just wrote one queues behind it
 * instead of joining it; a pass that has not started yet is read-after-write
 * safe and is joined as is.
 */
interface DrainQueue {
  /** Resolves with every envelope the tail pass steered, whether it delivered or failed. */
  result: Promise<ReadonlySet<PeerMessageId>>
  /** Whether the tail pass already began reading the mailbox. */
  started: boolean
}

/** One idle notice to enqueue into a watcher's mailbox. */
interface NoticeRequest {
  /** Session whose mailbox receives the notice. */
  readonly watcherId: SessionId
  /** Repository key stamped on the envelope; the watcher's drain compares it. */
  readonly watcherRepo: string
  /** Watcher's display name, used in the mailbox-cap failure text. */
  readonly watcherName: string
  /** Session that became idle and is therefore the envelope's sender. */
  readonly senderId: SessionId
  /** Display name of that session. */
  readonly senderName: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Peer session registry for this Host process. */
    peers: PeerService
  }
}

/**
 * `ctx.peers`: peer discovery, messaging, and idle watches for the top-level
 * sessions one Host process holds.
 *
 * One instance owns the file provider for every live agent in that process;
 * peers in other processes coordinate only through the mailbox files under the
 * Harness home. Methods take the calling agent explicitly, so authorization
 * follows the caller rather than ambient context.
 */
export default class PeerService extends Service {
  static inject = ['agents', 'sessions', 'sessionProjections']

  static Config = Config

  /** Peer storage root: `resolveDshHome()` read once at load. */
  private readonly home: string

  /** Every limit with its shipped default applied. */
  private readonly limits: ResolvedLimits

  /** Peer state of every agent this service observed being created, keyed by session id. */
  private readonly states = new Map<SessionId, AgentPeerState>()

  /** The queue of in-flight drain passes per live target, so passes never overlap for one mailbox. */
  private readonly drains = new Map<SessionId, DrainQueue>()

  /** The last queued presence-file operation per session, so writes land in call order. */
  private readonly presenceWrites = new Map<SessionId, Promise<void>>()

  /** Listener work whose completion the disposer must await. */
  private readonly pendingWork = new Set<Promise<void>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'peers')
    this.limits = resolveLimits(config)
    this.home = resolveDshHome()
    ctx.on('agent/created', async ({ agent }) => { await this.observeCreated(agent) })
    ctx.on('agent/status', ({ agent, status }) => { this.track(this.observeStatus(agent, status)) })
    ctx.on('agent/disposed', ({ agent }) => { this.track(this.observeDisposed(agent)) })
    ctx.on('session/event', (session, event) => { this.observeSessionEvent(session, event) })
    ctx.on('user-questions/request', async (request, next) => await this.observeQuestion(request, next))
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(peerDeliveryProjection)
      return () => { disposeProjection() }
    }, 'peers.deliveryProjection()')
    ctx.effect(() => {
      const timer = setInterval(() => { this.track(this.pollPass(), 'poll') }, this.limits.pollMs)
      timer.unref()
      return async () => {
        clearInterval(timer)
        await Promise.all([...this.pendingWork])
      }
    }, 'peers.drainLoop()')
  }

  /**
   * List the caller's peers: other top-level sessions in its repository with
   * peer coordination enabled, ordered by name and then session id.
   * @param agent - calling agent, whose cached repository key selects the listed peers.
   * @returns one entry per listed peer, excluding the caller.
   * @throws {PeerError} `PEER_NOT_TOP_LEVEL` for a caller that is not a peer, `PEER_NO_CWD` for a caller with no usable directory.
   */
  async list(agent: Agent): Promise<readonly PeerEntry[]> {
    const caller = await this.requireCaller(agent)
    const rows = await listPresence(this.home)
    return rows
      .filter(row => row.repoKey === caller.repoKey && row.sessionId !== agent.id)
      .map((row): PeerEntry => ({
        kind: 'session',
        id: row.sessionId,
        name: row.name,
        status: row.status,
        cwd: row.cwd,
        ...row.provider === undefined ? {} : { provider: row.provider },
        ...row.model === undefined ? {} : { model: row.model },
      }))
      .sort((left, right) => left.name === right.name
        ? left.id.localeCompare(right.id)
        : left.name.localeCompare(right.name))
  }

  /**
   * Send one message to a peer, queueing it durably when no process holds a
   * live target.
   * @param agent - calling agent; the message is attributed to its session.
   * @param request - target and complete message text.
   * @returns the envelope identity and how far delivery got.
   * @throws {PeerError} for an unresolved, ambiguous, unauthorized, oversized, or relay-limited send.
   */
  async send(agent: Agent, request: SendPeerMessageRequest): Promise<SendPeerMessageResult> {
    const caller = await this.requireCaller(agent)
    const target = await this.resolvePeer(agent, caller, request.to)
    const relayDepth = (this.deliveryOf(agent.session).relayDepth[target.id] ?? 0) + 1
    if (relayDepth > PEER_RELAY_DEPTH_LIMIT) throw peerRelayLimit(PEER_RELAY_DEPTH_LIMIT)
    const envelope: PeerMailEnvelope = {
      version: PEER_MAIL_VERSION,
      messageId: brandString<PeerMessageId>(`peer-message-${randomUUID()}`),
      targetId: target.id,
      senderSessionId: agent.id,
      senderName: this.nameOf(agent),
      fromRepo: caller.repoKey,
      relayDepth,
      kind: 'peer-message',
      text: request.message,
    }
    this.requireFramedSize(envelope)
    await enqueueMail(this.home, envelope, this.mailboxLimits(), target.name)
    const deferred = target.live !== undefined
      && this.limits.peerInbound === 'deferred'
      && target.live.status === 'idle'
    const targetState = target.live === undefined ? undefined : this.states.get(target.live.id)
    const steered = target.live === undefined
      ? new Set<PeerMessageId>()
      : await this.drainTarget(target.live)
    if (deferred) return { messageId: envelope.messageId, status: 'deferred' }
    const delivered = target.live !== undefined
      && this.hasSteered(target.live, targetState, steered, envelope.messageId)
    return { messageId: envelope.messageId, status: delivered ? 'delivered' : 'queued' }
  }

  /**
   * Whether this process steered one envelope into a live target.
   *
   * Three records answer it, because the pass this call awaited may have lost
   * its own record of the steer: a concurrent pass can have committed the steer
   * this call was about to make, and a pass that already retired its steer
   * leaves only the applied `user/message` behind.
   * @param agent - the live target whose log carries an applied delivery.
   * @param state - that target's peer state, when this process tracks it.
   * @param steered - envelope ids the pass this call awaited steered.
   * @param messageId - the envelope identity to look for.
   * @returns whether this process steered the envelope.
   */
  private hasSteered(
    agent: Agent,
    state: AgentPeerState | undefined,
    steered: ReadonlySet<PeerMessageId>,
    messageId: PeerMessageId,
  ): boolean {
    if (steered.has(messageId)) return true
    if (state?.inFlight.has(messageId) === true) return true
    return this.deliveryOf(agent.session).delivered.includes(messageId)
  }

  /**
   * Subscribe once to a peer's next idle transition.
   * @param agent - calling agent, which receives the notice in its own mailbox.
   * @param request - target to watch.
   * @returns whether this call added a subscription, or a notice was already due.
   * @throws {PeerError} for an unresolved, unauthorized, full, or idle-turn-limited watch.
   */
  async notifyIdle(agent: Agent, request: NotifyPeerIdleRequest): Promise<NotifyPeerIdleResult> {
    const caller = await this.requireCaller(agent)
    if (this.deliveryOf(agent.session).peerIdleTurn) throw peerIdleTurn()
    const target = await this.resolvePeer(agent, caller, request.to)
    if (target.status === 'idle') {
      const messageId = await this.enqueueNotice({
        watcherId: agent.id,
        watcherRepo: caller.repoKey,
        watcherName: this.nameOf(agent),
        senderId: target.id,
        senderName: target.name,
      })
      // The notice sits in the caller's mailbox, so the caller's own process
      // delivers it; the watched peer is not woken by this call.
      const steered = await this.drainTarget(agent)
      const delivered = this.hasSteered(agent, this.states.get(agent.id), steered, messageId)
      return { status: delivered ? 'delivered' : 'queued' }
    }
    const watch: PeerWatchRecord = {
      version: PEER_WATCH_VERSION,
      targetId: target.id,
      watcherId: agent.id,
      watcherRepo: caller.repoKey,
      watcherName: this.nameOf(agent),
    }
    await writeWatch(this.home, watch, this.limits.maxIdleWatches, target.name)
    return { status: 'watching' }
  }

  /** Caps handed to the mailbox writer. */
  private mailboxLimits(): PeerMailboxLimits {
    return {
      maxPendingPerTarget: this.limits.maxPendingPerTarget,
      maxPendingPerSenderPerTarget: this.limits.maxPendingPerSenderPerTarget,
    }
  }

  /**
   * Track one listener-owned operation so the disposer can await it and a
   * failure is reported instead of escaping as an unhandled rejection.
   * @param operation - the operation to run to completion.
   * @param label - short description used in the warning line.
   */
  private track(operation: Promise<void>, label = 'listener'): void {
    const settled = operation.catch((error: unknown) => {
      this.ctx.logger.warn(`peer-sessions: ${label} work failed: ${describeError(error)}`)
    })
    this.pendingWork.add(settled)
    void settled.finally(() => { this.pendingWork.delete(settled) })
  }

  /**
   * Whether one agent is a peer: a top-level runtime root without a subagent
   * origin or delegation depth.
   * @param agent - the live agent to classify.
   * @returns whether peer coordination may address that session.
   */
  private isTopLevel(agent: Agent): boolean {
    const header = agent.session.header
    if (header.origin === 'subagent') return false
    if ((header.delegationDepth ?? 0) > 0) return false
    return this.ctx.agents.roots().includes(agent)
  }

  /**
   * Authorize one caller and read its repository key.
   * @param agent - the calling agent.
   * @returns the caller's repository key.
   * @throws {PeerError} `PEER_NOT_TOP_LEVEL` or `PEER_NO_CWD`.
   */
  private async requireCaller(agent: Agent): Promise<PeerCaller> {
    if (!this.isTopLevel(agent)) throw peerNotTopLevel()
    const repoKey = await this.repoKeyOf(agent)
    if (repoKey === undefined) throw peerNoCwd()
    return { repoKey }
  }

  /**
   * Repository key of one agent, from its cached state or recomputed when this
   * service started after the agent did.
   * @param agent - the live agent.
   * @returns the repository key, or `undefined` when the header records no usable directory.
   */
  private async repoKeyOf(agent: Agent): Promise<string | undefined> {
    const state = this.states.get(agent.id)
    if (state !== undefined) return state.location?.repoKey
    return (await computePeerLocation(agent.session.header.cwd))?.repoKey
  }

  /**
   * Display name of one agent: its logged title, else its session id.
   * @param agent - the live agent.
   * @returns a non-empty name.
   */
  private nameOf(agent: Agent): string {
    const title = this.ctx.sessionProjections.stateOf(agent.session, 'title')
    return typeof title === 'string' && title.length > 0 ? title : agent.id
  }

  /**
   * Current peer status of one agent.
   * @param state - that agent's peer state.
   * @returns `idle`, `awaiting-user`, or `running`.
   */
  private statusOf(state: AgentPeerState): PeerStatus {
    if (state.agent.status === 'idle') return 'idle'
    if (state.openAsks > 0 || state.questioning) return 'awaiting-user'
    return 'running'
  }

  /**
   * Host-only delivery fold state of one session.
   *
   * This service registers the unit for its own lifetime, so the state always
   * exists; the assertion names that invariant the way the other host-only
   * readers of a self-registered unit do.
   */
  private deliveryOf(session: Session): PeerDeliveryState {
    return this.ctx.sessionProjections.stateOf(session, 'peerDelivery') as PeerDeliveryState
  }

  /**
   * Whether one envelope id is still pending in an agent's inbox.
   * @param agent - the live target.
   * @param messageId - the envelope identity to look for.
   * @returns whether a queued `UserMessage` carries that envelope id.
   */
  private isPending(agent: Agent, messageId: PeerMessageId): boolean {
    // The agent loop registers this unit for every agent it holds, so a live
    // target always has one; the assertion names that invariant.
    const inbox = this.ctx.sessionProjections.stateOf(agent.session, 'inbox') as InboxState
    return [...inbox['next-turn'], ...inbox['next-step']].some((message) => {
      const source = message.source
      return (source.kind === 'peer-message' || source.kind === 'peer-idle') && source.messageId === messageId
    })
  }

  /**
   * Reject an envelope whose framed body exceeds the configured byte cap.
   * @param envelope - the complete envelope about to be written.
   * @throws {PeerError} `PEER_MESSAGE_TOO_LARGE` when the framed UTF-8 exceeds `maxMessageBytes`.
   */
  private requireFramedSize(envelope: PeerMailEnvelope): void {
    if (Buffer.byteLength(framedBody(envelope), 'utf8') > this.limits.maxMessageBytes) {
      throw peerMessageTooLarge(this.limits.maxMessageBytes)
    }
  }

  /**
   * Publish one agent's presence row and drain its freshly discovered mailbox.
   * @param agent - the just-created agent.
   */
  private async observeCreated(agent: Agent): Promise<void> {
    const location = await computePeerLocation(agent.session.header.cwd)
    const state: AgentPeerState = {
      agent,
      location,
      openAsks: 0,
      questioning: false,
      inFlight: new Set(),
      attempts: new Map(),
    }
    this.states.set(agent.id, state)
    if (this.isTopLevel(agent) && location !== undefined) await this.publish(agent, state, location)
    // Every created agent drains, including one that publishes no row: an
    // envelope planted for a subagent or for a session without a working
    // directory must be dropped instead of steered.
    await this.drainTarget(agent)
  }

  /**
   * React to one lifecycle transition: publish the new status, settle an idle
   * turn's delivery attempts, and notify the watchers of a newly idle peer.
   * @param agent - the agent that changed status.
   * @param status - the new lifecycle state.
   */
  private async observeStatus(agent: Agent, status: AgentStatus): Promise<void> {
    const state = this.states.get(agent.id)
    if (state === undefined) return
    if (status === 'idle') {
      await this.settleIdleTurn(agent, state)
      await this.notifyWatchers(agent)
    }
    if (!this.isTopLevel(agent) || state.location === undefined) return
    await this.publish(agent, state, state.location)
  }

  /**
   * Retire one agent's presence, watches, and in-process state.
   * @param agent - the disposed agent.
   */
  private async observeDisposed(agent: Agent): Promise<void> {
    const state = this.states.get(agent.id)
    if (state === undefined) return
    this.states.delete(agent.id)
    this.drains.delete(agent.id)
    await removePresence(this.home, agent.id)
    if (state.location === undefined) return
    await this.deleteWatchesOf(agent.id)
  }

  /**
   * Rewrite the presence row for the session events that change what peers see.
   * @param session - the session whose log grew.
   * @param event - the committed event.
   */
  private observeSessionEvent(session: Session, event: SessionEvent): void {
    const state = this.states.get(session.id)
    if (state === undefined) return
    if (event.type === 'approval/asked') state.openAsks += 1
    else if (event.type === 'approval/decided') state.openAsks = Math.max(0, state.openAsks - 1)
    else if (event.type !== 'session/title') return
    if (!this.isTopLevel(state.agent) || state.location === undefined) return
    this.track(this.publish(state.agent, state, state.location), 'presence')
  }

  /**
   * Mark a session as waiting for its user while one question is in flight.
   *
   * The listener only observes: it always calls `next()` so the answerer chain
   * still decides, and it restores the presence row in `finally`.
   * @param request - the pending user-question request.
   * @param next - the rest of the answerer chain.
   * @returns the chain's answer.
   */
  private async observeQuestion(
    request: AskUserQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    const state = agent === undefined ? undefined : this.states.get(agent.id)
    if (agent === undefined || state === undefined) return await next()
    state.questioning = true
    await this.publishIfPeer(agent, state)
    try {
      return await next()
    } finally {
      // `publish` reports its own failures, so it can never replace an answer
      // that the answerer chain already decided.
      state.questioning = false
      await this.publishIfPeer(agent, state)
    }
  }

  /**
   * Publish one agent's presence when it is a peer.
   * @param agent - the live agent.
   * @param state - that agent's peer state.
   */
  private async publishIfPeer(agent: Agent, state: AgentPeerState): Promise<void> {
    if (!this.isTopLevel(agent) || state.location === undefined) return
    await this.publish(agent, state, state.location)
  }

  /**
   * Write one agent's presence row for an already-resolved location.
   *
   * The write is queued behind every earlier presence operation for that
   * session: two publishers can otherwise race, and a row computed from an
   * older status must never land after a newer one. The status is read when the
   * queued write runs, so the row always carries the current one.
   * @param agent - the live peer.
   * @param state - that agent's peer state.
   * @param location - the repository location the row publishes.
   * @returns fulfillment once this row is committed.
   */
  private publish(agent: Agent, state: AgentPeerState, location: PeerLocation): Promise<void> {
    return this.queuePresence(agent.id, async () => {
      const provider = agent.options.provider
      const model = agent.options.model
      await writePresence(this.home, {
        version: 1,
        sessionId: agent.id,
        repoKey: location.repoKey,
        cwd: location.cwd,
        name: this.nameOf(agent),
        status: this.statusOf(state),
        pid: process.pid,
        ...provider === undefined ? {} : { provider },
        ...model === undefined ? {} : { model },
      })
    })
  }

  /**
   * Run one presence-file operation after every earlier one for that session.
   * @param sessionId - session whose row the operation touches.
   * @param operation - the queued file operation.
   * @returns fulfillment after this operation, and every queued before it, settled.
   */
  private queuePresence(sessionId: SessionId, operation: () => Promise<void>): Promise<void> {
    const previous = this.presenceWrites.get(sessionId) ?? Promise.resolve()
    const queued = previous
      .then(operation)
      .catch((error: unknown) => {
        this.ctx.logger.warn(`peer-sessions: publishing presence for "${sessionId}" failed: ${describeError(error)}`)
      })
      .finally(() => {
        if (this.presenceWrites.get(sessionId) === queued) this.presenceWrites.delete(sessionId)
      })
    this.presenceWrites.set(sessionId, queued)
    this.track(queued, 'presence')
    return queued
  }

  /**
   * Resolve one address inside the caller's repository.
   * @param agent - the calling agent.
   * @param caller - the caller's authorization facts.
   * @param to - requested session id or unique name.
   * @returns the resolved target.
   * @throws {PeerError} for self-addressing, ambiguity, a non-peer target, another repository, or no match.
   */
  private async resolvePeer(agent: Agent, caller: PeerCaller, to: string): Promise<ResolvedPeer> {
    if (to === agent.id) throw peerSelf()
    const candidates = await this.candidates()
    const byId = candidates.find(candidate => candidate.id === to)
    if (byId !== undefined) return this.admitPeer(byId, caller)
    const inRepo = candidates.filter(candidate => candidate.name === to && candidate.repoKey === caller.repoKey)
    if (inRepo.length > 1) throw peerAmbiguous(to)
    const only = inRepo[0]
    if (only !== undefined) return this.admitPeer(only, caller)
    if (candidates.some(candidate => candidate.name === to)) throw peerOtherRepository()
    throw peerNotFound(to)
  }

  /** Every addressable peer this process can see: its own agents plus every live presence row. */
  private async candidates(): Promise<readonly PeerCandidate[]> {
    const candidates: PeerCandidate[] = []
    const seen = new Set<string>()
    for (const agent of this.ctx.agents.list()) {
      const state = this.states.get(agent.id)
      if (state === undefined) continue
      seen.add(agent.id)
      candidates.push({
        id: agent.id,
        name: this.nameOf(agent),
        repoKey: state.location?.repoKey,
        cwd: agent.session.header.cwd ?? '',
        status: this.statusOf(state),
        live: agent,
        topLevel: this.isTopLevel(agent),
      })
    }
    for (const row of await listPresence(this.home)) {
      if (seen.has(row.sessionId)) continue
      candidates.push({
        id: row.sessionId,
        name: row.name,
        repoKey: row.repoKey,
        cwd: row.cwd,
        status: row.status,
        live: undefined,
        topLevel: true,
      })
    }
    return candidates
  }

  /**
   * Admit one candidate as a target or reject it.
   * @param candidate - the matched candidate.
   * @param caller - the caller's authorization facts.
   * @returns the resolved target.
   * @throws {PeerError} `PEER_NOT_TOP_LEVEL` or `PEER_OTHER_REPOSITORY`.
   */
  private admitPeer(candidate: PeerCandidate, caller: PeerCaller): ResolvedPeer {
    if (candidate.live !== undefined && !candidate.topLevel) throw peerNotTopLevel()
    if (candidate.repoKey !== caller.repoKey) throw peerOtherRepository()
    return {
      id: candidate.id,
      name: candidate.name,
      repoKey: caller.repoKey,
      cwd: candidate.cwd,
      status: candidate.status,
      live: candidate.live,
    }
  }

  /**
   * Drain one live target's mailbox, queued behind any pass already reading it.
   *
   * Joining a pass that has already read the shard would miss an envelope this
   * call just committed, so only a not-yet-started pass is shared.
   * @param agent - the live target this process holds.
   * @returns every envelope the pass this call joined or queued steered.
   */
  private drainTarget(agent: Agent): Promise<ReadonlySet<PeerMessageId>> {
    // Without peer state there is no cached repository key to authorize an
    // envelope against and no in-flight bookkeeping to settle, so a session
    // this service does not track is never drained.
    const state = this.states.get(agent.id)
    if (state === undefined) return Promise.resolve(new Set())
    const running = this.drains.get(agent.id)
    if (running !== undefined && !running.started) return running.result
    const queue: DrainQueue = { result: Promise.resolve(new Set()), started: false }
    const pass = (running?.result ?? Promise.resolve(new Set<PeerMessageId>()))
      .then(() => {
        queue.started = true
        return this.runDrainPass(agent, state)
      })
      .catch((error: unknown): ReadonlySet<PeerMessageId> => {
        this.ctx.logger.warn(`peer-sessions: draining peer "${agent.id}" failed: ${describeError(error)}`)
        return new Set()
      })
      .finally(() => {
        if (this.drains.get(agent.id) === queue) this.drains.delete(agent.id)
      })
    queue.result = pass
    this.drains.set(agent.id, queue)
    this.track(pass.then(() => undefined), 'drain')
    return pass
  }

  /**
   * One drain pass over one live target's mailbox.
   *
   * Invalid files and envelopes that fail the repo or peer check are deleted;
   * an envelope this process already steered is left alone until its delivery
   * or its failure is settled.
   * @param agent - the live target.
   * @param state - that agent's peer state.
   * @returns every envelope this pass steered into the target.
   */
  private async runDrainPass(agent: Agent, state: AgentPeerState): Promise<ReadonlySet<PeerMessageId>> {
    const shard = mailShardDirectory(this.home, agent.id)
    const read = await readMailShard(shard)
    if (read.count === 0) return new Set()
    const delivered = new Set(this.deliveryOf(agent.session).delivered)
    const topLevel = this.isTopLevel(agent)
    const drop: string[] = [...read.invalid]
    const steer: PeerMailEnvelope[] = []
    for (const envelope of read.entries) {
      const filename = join(shard, `${envelope.messageId}.json`)
      if (delivered.has(envelope.messageId)) {
        state.inFlight.delete(envelope.messageId)
        state.attempts.delete(envelope.messageId)
        drop.push(filename)
        continue
      }
      if (!topLevel || envelope.targetId !== agent.id || envelope.fromRepo !== state.location?.repoKey) {
        drop.push(filename)
        continue
      }
      if (state.inFlight.has(envelope.messageId)) continue
      if (this.limits.peerInbound === 'deferred' && envelope.kind === 'peer-message' && agent.status === 'idle') continue
      steer.push(envelope)
    }
    await this.dropFiles(shard, drop)
    const steered = new Set<PeerMessageId>()
    for (const envelope of steer) {
      const keepGoing = await this.steerEnvelope(agent, state, envelope)
      if (keepGoing) steered.add(envelope.messageId)
      if (!keepGoing) break
    }
    await removeEmptyShard(shard)
    return steered
  }

  /**
   * Steer one envelope into a live target and checkpoint its splice.
   * @param agent - the live target.
   * @param state - that agent's peer state.
   * @param envelope - the envelope to deliver.
   * @returns whether the pass may continue with the next envelope.
   */
  private async steerEnvelope(agent: Agent, state: AgentPeerState, envelope: PeerMailEnvelope): Promise<boolean> {
    state.inFlight.add(envelope.messageId)
    try {
      agent.steer(this.deliveryMessage(envelope))
      await this.ctx.sessions.flush(agent.session)
      return true
    } catch (error: unknown) {
      // The envelope stays on disk: the splice may not be durable, and only an
      // applied `user/message` licenses deleting the file.
      this.ctx.logger.warn(`peer-sessions: steering "${envelope.messageId}" to peer "${agent.id}" failed: ${describeError(error)}`)
      return false
    }
  }

  /**
   * Build the model-visible `user/message` one envelope delivers.
   * @param envelope - the envelope to frame.
   * @returns the identified user message carrying the framed body and its source.
   */
  private deliveryMessage(envelope: PeerMailEnvelope): UserMessage {
    if (envelope.kind === 'peer-message') {
      return createUserMessage({
        content: [{ type: 'text', text: framedRelay(envelope) }],
        source: {
          kind: 'peer-message',
          form: 'relay',
          messageId: envelope.messageId,
          senderSessionId: envelope.senderSessionId,
          senderName: envelope.senderName,
          relayDepth: envelope.relayDepth,
        },
      })
    }
    return createUserMessage({
      content: [{ type: 'text', text: framedBody(envelope) }],
      source: {
        kind: 'peer-idle',
        form: 'notice',
        summary: boundContextSummary(noticeSummary(envelope.senderName)),
        messageId: envelope.messageId,
        senderSessionId: envelope.senderSessionId,
        senderName: envelope.senderName,
      },
    })
  }

  /**
   * Delete dropped envelopes under the shard lock, so a concurrent sender's cap
   * check never races a delete of the same shard.
   * @param shard - the target's mailbox shard directory.
   * @param filenames - absolute paths to remove.
   */
  private async dropFiles(shard: string, filenames: readonly string[]): Promise<void> {
    if (filenames.length === 0) return
    await withFileLock(shard, async () => {
      for (const filename of filenames) await deleteMailFile(filename)
    })
  }

  /**
   * Settle the delivery attempts of one agent's in-flight envelopes when it
   * turns idle.
   *
   * An envelope that reached the log is deleted; one that is neither pending
   * nor delivered spent an attempt, and the third attempt drops it.
   * @param agent - the now-idle agent.
   * @param state - that agent's peer state.
   */
  private async settleIdleTurn(agent: Agent, state: AgentPeerState): Promise<void> {
    if (state.inFlight.size === 0) return
    const delivered = new Set(this.deliveryOf(agent.session).delivered)
    const shard = mailShardDirectory(this.home, agent.id)
    const drop: string[] = []
    for (const messageId of [...state.inFlight]) {
      if (delivered.has(messageId)) {
        state.inFlight.delete(messageId)
        state.attempts.delete(messageId)
        drop.push(join(shard, `${messageId}.json`))
        continue
      }
      if (this.isPending(agent, messageId)) continue
      const attempts = (state.attempts.get(messageId) ?? 0) + 1
      state.inFlight.delete(messageId)
      if (attempts < PEER_DELIVERY_ATTEMPTS) {
        state.attempts.set(messageId, attempts)
        continue
      }
      state.attempts.delete(messageId)
      drop.push(join(shard, `${messageId}.json`))
      this.ctx.logger.warn(`peer-sessions: dropped peer message "${messageId}" for peer "${agent.id}" after ${PEER_DELIVERY_ATTEMPTS} attempts`)
    }
    await this.dropFiles(shard, drop)
    if (drop.length > 0) await removeEmptyShard(shard)
  }

  /**
   * Notify every watcher of one agent that it just became idle.
   * @param agent - the agent that became idle.
   */
  private async notifyWatchers(agent: Agent): Promise<void> {
    const directory = watchShardDirectory(this.home, agent.id)
    const shard = await readWatchShard(directory)
    if (shard.count === 0) return
    const name = this.nameOf(agent)
    for (const filename of shard.invalid) await deleteWatch(filename)
    for (const entry of shard.watched) {
      await deleteWatch(entry.filename)
      try {
        await this.enqueueNotice({
          watcherId: entry.record.watcherId,
          watcherRepo: entry.record.watcherRepo,
          watcherName: entry.record.watcherName,
          senderId: agent.id,
          senderName: name,
        })
      } catch (error: unknown) {
        // The watch is already retired; a full watcher mailbox must not break
        // the idle transition of this agent.
        this.ctx.logger.warn(`peer-sessions: idle notice for peer "${entry.record.watcherId}" failed: ${describeError(error)}`)
      }
    }
    await removeEmptyShard(directory)
  }

  /**
   * Delete every watch one target holds, without enqueueing a notice.
   * @param targetId - the disposed target session.
   */
  private async deleteWatchesOf(targetId: SessionId): Promise<void> {
    const directory = watchShardDirectory(this.home, targetId)
    const shard = await readWatchShard(directory)
    for (const filename of shard.invalid) await deleteWatch(filename)
    for (const entry of shard.watched) await deleteWatch(entry.filename)
    await removeEmptyShard(directory)
  }

  /**
   * Enqueue one idle notice into a watcher's mailbox.
   * @param request - the notice's watcher, sender, and display names.
   * @returns the new envelope identity.
   */
  private async enqueueNotice(request: NoticeRequest): Promise<PeerMessageId> {
    const envelope: PeerMailEnvelope = {
      version: PEER_MAIL_VERSION,
      messageId: brandString<PeerMessageId>(`peer-idle-${randomUUID()}`),
      targetId: request.watcherId,
      senderSessionId: request.senderId,
      senderName: request.senderName,
      fromRepo: request.watcherRepo,
      relayDepth: 1,
      kind: 'peer-idle',
      text: '',
    }
    this.requireFramedSize(envelope)
    await enqueueMail(this.home, envelope, this.mailboxLimits(), request.watcherName)
    return envelope.messageId
  }

  /** One poll pass: drain every live mailbox this process owns, then reap and prune. */
  private async pollPass(): Promise<void> {
    for (const agent of this.ctx.agents.list()) {
      if (!this.states.has(agent.id)) continue
      await this.drainTarget(agent)
    }
    await this.reapWatches()
    await this.removeEmptyMailShards()
  }

  /**
   * Delete watches whose watched peer is gone.
   *
   * A watcher is never told about a peer that disappeared: the prompt tells it
   * to stop waiting once `list_peers` drops that peer.
   */
  private async reapWatches(): Promise<void> {
    for (const { directory, shard } of await listWatchShards(this.home)) {
      for (const filename of shard.invalid) await deleteWatch(filename)
      for (const entry of shard.watched) {
        if (await readPresence(this.home, entry.record.targetId) === undefined) await deleteWatch(entry.filename)
      }
      await removeEmptyShard(directory)
    }
  }

  /** Remove every empty mailbox shard under this home. */
  private async removeEmptyMailShards(): Promise<void> {
    const directory = mailDirectory(this.home)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await removeEmptyShard(join(directory, entry.name))
    }
  }
}

/**
 * Resolve one session directory to the repository location peers group by.
 * @param cwd - the session header's working directory, when it has one.
 * @returns the directory and its repository key, or `undefined` when the
 * directory is absent, relative, or gone.
 */
async function computePeerLocation(cwd: string | undefined): Promise<PeerLocation | undefined> {
  if (cwd === undefined) return undefined
  try {
    return { cwd, repoKey: await peerRepoKey(await realpathNormalize(cwd)) }
  } catch {
    // A missing or relative working directory yields no repository, so that
    // session publishes nothing and no envelope can authorize against it.
    return undefined
  }
}
