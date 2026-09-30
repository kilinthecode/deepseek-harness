/**
 * Stable peer failure class and the exact model-visible text of every failure.
 *
 * The text lives here, apart from the service, so one spelling feeds both the
 * thrown error and the mutation checks that pin it.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions/errors
 */

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

/**
 * No live peer in the caller's repository matches `to`.
 * @param to - the name or id the caller addressed.
 * @returns the rejection to throw.
 */
export function peerNotFound(to: string): PeerError {
  return new PeerError('PEER_NOT_FOUND', `No peer session named "${to}" is live in this repository.`)
}

/**
 * More than one peer in the caller's repository carries this name.
 * @param to - the ambiguous name.
 * @returns the rejection to throw.
 */
export function peerAmbiguous(to: string): PeerError {
  return new PeerError('PEER_AMBIGUOUS', `More than one peer is named "${to}". Pass the session id.`)
}

/**
 * The caller addressed its own session.
 * @returns the rejection to throw.
 */
export function peerSelf(): PeerError {
  return new PeerError('PEER_SELF', 'You cannot message your own session.')
}

/**
 * The caller or the resolved target is not a top-level session.
 * @returns the rejection to throw.
 */
export function peerNotTopLevel(): PeerError {
  return new PeerError('PEER_NOT_TOP_LEVEL', 'Only top-level sessions in this repository can message each other.')
}

/**
 * The caller's session records no usable working directory.
 * @returns the rejection to throw.
 */
export function peerNoCwd(): PeerError {
  return new PeerError('PEER_NO_CWD', 'This session has no working directory, so it cannot use peer messaging.')
}

/**
 * The resolved peer lives in another repository.
 * @returns the rejection to throw.
 */
export function peerOtherRepository(): PeerError {
  return new PeerError('PEER_OTHER_REPOSITORY', 'That peer is in a different repository.')
}

/**
 * The target's mailbox is at its configured cap.
 * @param name - display name of the target.
 * @param cap - configured `maxPendingPerTarget`.
 * @returns the rejection to throw.
 */
export function peerMailboxFull(name: string, cap: number): PeerError {
  return new PeerError('PEER_MAILBOX_FULL', `Peer "${name}" already has ${cap} pending messages.`)
}

/**
 * This sender already holds its per-target allowance.
 * @param name - display name of the target.
 * @param cap - configured `maxPendingPerSenderPerTarget`.
 * @returns the rejection to throw.
 */
export function peerSenderQuota(name: string, cap: number): PeerError {
  return new PeerError('PEER_SENDER_QUOTA', `This session already has ${cap} pending messages for peer "${name}".`)
}

/**
 * The framed delivery exceeds the configured byte cap.
 * @param cap - configured `maxMessageBytes`.
 * @returns the rejection to throw.
 */
export function peerMessageTooLarge(cap: number): PeerError {
  return new PeerError('PEER_MESSAGE_TOO_LARGE', `Peer message exceeds ${cap} bytes.`)
}

/**
 * The conversation reached the relay depth limit.
 * @param limit - the fixed relay depth limit.
 * @returns the rejection to throw.
 */
export function peerRelayLimit(limit: number): PeerError {
  return new PeerError('PEER_RELAY_LIMIT', `This peer conversation already relayed ${limit} times. Stop and wait for the user.`)
}

/**
 * The calling turn was opened by an idle notice the caller subscribed to.
 * @returns the rejection to throw.
 */
export function peerIdleTurn(): PeerError {
  return new PeerError('PEER_IDLE_TURN', 'This turn was opened by an idle notice. Do not subscribe to another idle notice.')
}

/**
 * The target already holds its configured number of idle watches.
 * @param name - display name of the target.
 * @param cap - configured `maxIdleWatches`.
 * @returns the rejection to throw.
 */
export function peerWatchesFull(name: string, cap: number): PeerError {
  return new PeerError('PEER_WATCHES_FULL', `Peer "${name}" already has ${cap} idle watches.`)
}
