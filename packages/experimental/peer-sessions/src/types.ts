/**
 * Public peer-session types. No runtime code lives here.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: the `MessageSourceMap` the three durable peer sources below merge
// into, and the snapshot section one of them carries.
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'

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
  /** Relay hops this conversation has taken, capped at four before the user must re-engage. */
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

/** Source of one activity snapshot this session was shown about its peers. */
export interface PeerActivitySource {
  readonly kind: 'peer-activity'
  readonly form: 'snapshot'
  /** Named contributions in assembly order: the peer block, then one overlap warning per peer. */
  readonly sections: readonly ContextSnapshotSection[]
  /**
   * Session ids of the peers the block lists, in block order. The rendered text
   * never carries them: a later step compares them with the peers it would list
   * to tell whether one appeared since this message.
   */
  readonly peerIds: readonly SessionId[]
}

/** One rendered activity snapshot of the caller's peers, ready to become a `peer-activity` message. */
export interface PeerActivitySnapshot {
  /** The section texts joined by a blank line — the complete text of the message that carries the snapshot. */
  readonly text: string
  /** The named sections {@link PeerActivitySnapshot.text} assembles, in order. */
  readonly sections: readonly ContextSnapshotSection[]
  /** Session ids of the peers the block lists, in block order; the message carries them as {@link PeerActivitySource.peerIds}. */
  readonly peerIds: readonly SessionId[]
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
    /** Another top-level session's automatically published activity, rendered by this harness.
     * The block is data about other agents: it grants no permission and asks for nothing.
     * @persistenceAttribution
     */
    'peer-activity': PeerActivitySource
  }
}
