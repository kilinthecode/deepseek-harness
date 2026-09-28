/**
 * Peer sessions: independent top-level sessions that share one Harness home and
 * one repository coordinate through durable mailbox files, exposed as
 * `ctx.peers` with `list`, `send`, and `notifyIdle`.
 *
 * Peers group by repository ({@link peerRepoKey}), not by exact directory: two
 * worktrees of one repository see each other, while a session in the same
 * directory of another checkout does not. The capability is off until a profile
 * mounts the peer-sessions bundle.
 *
 * This module declares the public contract. The three service methods reject
 * with `not implemented` until the mailbox provider lands.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: the `MessageSourceMap` the two durable peer sources below merge into.
import type {} from '@deepseek-ai/dsh-llm'
import { peerRepoKey } from './repo.ts'

export { peerRepoKey }

/** Liveness of one peer's agent loop, as the process holding it last published it. */
export type PeerStatus = 'idle' | 'running' | 'awaiting-user'

/** Durable identity of one mailbox envelope, stable from enqueue through the delivered `user/message`. */
export type PeerMessageId = Branded<'PeerMessageId'>

/** One other top-level session in the calling session's repository. */
export interface PeerEntry {
  /** Discriminant reserved for later peer kinds; every current entry is a session. */
  readonly kind: 'session'
  /** Session identity to address in `send` and `notifyIdle`. */
  readonly id: SessionId
  /** Display name the session chose, or its session id while the log records no title. */
  readonly name: string
  /** Liveness of that session's agent loop. */
  readonly status: PeerStatus
  /** Working directory that session was created in, so the model sees which worktree it occupies. */
  readonly cwd: string
  /** Provider route of that session, when its agent options set one. */
  readonly provider?: string
  /** Model id of that session, when its agent options set one. */
  readonly model?: string
}

/** One message to deliver to another top-level session. */
export interface SendPeerMessageRequest {
  /** Target session id, or a name that matches exactly one peer in the caller's repository. */
  readonly to: string
  /** Complete message text; the target sees this and the harness frame around it, never the sender's transcript. */
  readonly message: string
}

/** Outcome of one {@link SendPeerMessageRequest}. */
export interface SendPeerMessageResult {
  /** Envelope identity, matched on the target's log by `source.messageId`. */
  readonly messageId: PeerMessageId
  /**
   * `delivered` when this process steered the message, `queued` while it waits
   * for a process holding a live target, `deferred` while a deferring target is
   * idle.
   */
  readonly status: 'delivered' | 'queued' | 'deferred'
}

/** One subscription to a peer's next idle transition. */
export interface NotifyPeerIdleRequest {
  /** Target session id, or a name that matches exactly one peer in the caller's repository. */
  readonly to: string
}

/** Outcome of one {@link NotifyPeerIdleRequest}. */
export interface NotifyPeerIdleResult {
  /**
   * `watching` when this call added or found a subscription, `delivered` when
   * the target was already idle, `queued` while the notice waits for a process
   * holding the calling session.
   */
  readonly status: 'watching' | 'delivered' | 'queued'
}

/**
 * Source of one peer message this session received.
 *
 * The text is another agent's words, framed by this harness; the frame says so
 * and grants no authority.
 */
export interface PeerMessageSource {
  readonly kind: 'peer-message'
  readonly form: 'relay'
  /** Envelope identity from the sender's mailbox, used to recognize this delivery. */
  readonly messageId: PeerMessageId
  /** Session that sent the message; authorization never reads the display name. */
  readonly senderSessionId: SessionId
  /** Display name the sending session chose for itself. */
  readonly senderName: string
  /** Relay hops this conversation has taken, capped by {@link PEER_RELAY_DEPTH_LIMIT}. */
  readonly relayDepth: number
}

/** Source of one idle notice this session subscribed to. */
export interface PeerIdleSource {
  readonly kind: 'peer-idle'
  readonly form: 'notice'
  /** One-line account shown without expanding the row. */
  readonly summary: string
  /** Envelope identity from the watched peer's mailbox, used to recognize this delivery. */
  readonly messageId: PeerMessageId
  /** Session that became idle. */
  readonly senderSessionId: SessionId
  /** Display name the watched session chose for itself. */
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Another agent's message, relayed through the peer mailbox.
     * Its projection matches a delivery on `messageId`, so a replayed log
     * recognizes a body the sender already counts as delivered.
     * @persistenceAttribution
     */
    'peer-message': PeerMessageSource
    /** A subscribed peer became idle.
     * The session logs the harness's own notice text, not the peer's words.
     * @persistenceAttribution
     */
    'peer-idle': PeerIdleSource
  }
}

/** Stable failure class of one peer operation. */
export type PeerErrorCode =
  /** No live peer in the caller's repository matches the requested name or id. */
  | 'PEER_NOT_FOUND'
  /** More than one live peer matches the requested name. */
  | 'PEER_AMBIGUOUS'
  /** The caller addressed its own session. */
  | 'PEER_SELF'
  /** The caller or the target is not a top-level session. */
  | 'PEER_NOT_TOP_LEVEL'
  /** The caller's session records no working directory. */
  | 'PEER_NO_CWD'
  /** The named peer is live in a different repository. */
  | 'PEER_OTHER_REPOSITORY'
  /** The target already holds the maximum queued messages. */
  | 'PEER_MAILBOX_FULL'
  /** The sender already holds the maximum queued messages for this target. */
  | 'PEER_SENDER_QUOTA'
  /** The framed message exceeds the configured byte cap. */
  | 'PEER_MESSAGE_TOO_LARGE'
  /** This conversation already relayed the maximum number of hops, so the user must re-engage. */
  | 'PEER_RELAY_LIMIT'
  /** The calling turn was opened by an idle notice and may not subscribe to another. */
  | 'PEER_IDLE_TURN'
  /** The target already holds the maximum idle subscriptions. */
  | 'PEER_WATCHES_FULL'

/**
 * Peer operation failure whose `message` is the exact model-visible text.
 *
 * Consumers present the message unchanged; the code exists for callers that
 * route on failure class, never for parsing the text.
 */
export class PeerError extends Error {
  /** Machine-routable failure class; route on this, never on `message`. */
  readonly code: PeerErrorCode

  /**
   * @param code - stable failure class of this rejection.
   * @param message - exact model-visible failure text.
   */
  constructor(code: PeerErrorCode, message: string) {
    super(message)
    this.name = 'PeerError'
    this.code = code
  }
}

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
export const Config: z<Config> = z.object({
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
 * Validate one peer-session configuration at load.
 * @param config - stated limits; omitted fields take the shipped values, so this checks only what a caller set.
 * @throws when a limit is not a positive safe integer, the inbound mode is unknown, or the sender cap exceeds the target cap.
 */
function validateConfig(config: Config): void {
  requirePositiveLimit('pollMs', config.pollMs)
  requirePositiveLimit('maxPendingPerTarget', config.maxPendingPerTarget)
  requirePositiveLimit('maxPendingPerSenderPerTarget', config.maxPendingPerSenderPerTarget)
  requirePositiveLimit('maxMessageBytes', config.maxMessageBytes)
  requirePositiveLimit('maxIdleWatches', config.maxIdleWatches)
  requirePeerInbound(config.peerInbound)
  const perTarget = config.maxPendingPerTarget ?? DEFAULT_MAX_PENDING_PER_TARGET
  const perSender = config.maxPendingPerSenderPerTarget ?? DEFAULT_MAX_PENDING_PER_SENDER_PER_TARGET
  if (perSender > perTarget) {
    throw new Error('peer-sessions: maxPendingPerSenderPerTarget must not exceed maxPendingPerTarget')
  }
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
  static Config = Config

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'peers')
    validateConfig(config)
  }

  /**
   * List the caller's peers: other top-level sessions in its repository with
   * peer coordination enabled.
   * @param _agent - calling agent, whose cached repository key selects the listed peers.
   * @returns one entry per listed peer, excluding the caller.
   * @throws {Error} always in this change; the mailbox provider implements this later.
   */
  list(_agent: Agent): Promise<readonly PeerEntry[]> {
    return Promise.reject(new Error('not implemented'))
  }

  /**
   * Send one message to a peer, queueing it durably when no process holds a
   * live target.
   * @param _agent - calling agent; the message is attributed to its session.
   * @param _request - target and complete message text.
   * @returns the envelope identity and how far delivery got.
   * @throws {PeerError} for an unresolved, ambiguous, unauthorized, oversized, or relay-limited send.
   * @throws {Error} always in this change; the mailbox provider implements this later.
   */
  send(_agent: Agent, _request: SendPeerMessageRequest): Promise<SendPeerMessageResult> {
    return Promise.reject(new Error('not implemented'))
  }

  /**
   * Subscribe once to a peer's next idle transition.
   * @param _agent - calling agent, which receives the notice in its own mailbox.
   * @param _request - target to watch.
   * @returns whether this call added a subscription, or a notice was already due.
   * @throws {PeerError} for an unresolved, unauthorized, full, or idle-turn-limited watch.
   * @throws {Error} always in this change; the mailbox provider implements this later.
   */
  notifyIdle(_agent: Agent, _request: NotifyPeerIdleRequest): Promise<NotifyPeerIdleResult> {
    return Promise.reject(new Error('not implemented'))
  }
}
