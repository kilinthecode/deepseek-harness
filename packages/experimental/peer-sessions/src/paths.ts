/**
 * Directory layout and permission modes of one Harness home's peer storage.
 *
 * Every peer artifact is an ordinary file below `$DSH_HOME/peers/`, so two
 * processes that share a home coordinate without a shared parent process. Ids
 * are hashed into file names because a session id or message id is caller text
 * of unbounded length.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions/paths
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Permission bits for every peer directory this package creates. */
export const PEER_DIRECTORY_MODE = 0o700

/** Permission bits for every peer file this package writes. */
export const PEER_FILE_MODE = 0o600

/**
 * Hash one durable identity into a filesystem-safe name component.
 * @param value - session id, message id, or repository key.
 * @returns lowercase hex sha256 of the UTF-8 value.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Root of this home's peer storage.
 * @param home - resolved Harness home directory.
 * @returns the `peers` directory path.
 */
export function peersDirectory(home: string): string {
  return join(home, 'peers')
}

/**
 * Directory holding one presence row per live top-level peer.
 * @param home - resolved Harness home directory.
 * @returns the `peers/presence` directory path.
 */
export function presenceDirectory(home: string): string {
  return join(peersDirectory(home), 'presence')
}

/**
 * Presence file of one session.
 * @param home - resolved Harness home directory.
 * @param sessionId - the session the row describes.
 * @returns the presence file path for that session.
 */
export function presencePath(home: string, sessionId: string): string {
  return join(presenceDirectory(home), `${sha256Hex(sessionId)}.json`)
}

/**
 * Parent of every mailbox shard directory.
 * @param home - resolved Harness home directory.
 * @returns the `peers/mail` directory path.
 */
export function mailDirectory(home: string): string {
  return join(peersDirectory(home), 'mail')
}

/**
 * Mailbox shard directory of one target session.
 * @param home - resolved Harness home directory.
 * @param targetId - the session whose pending envelopes live here.
 * @returns the shard directory path; writers also lock `<shard>.lock`.
 */
export function mailShardDirectory(home: string, targetId: string): string {
  return join(mailDirectory(home), sha256Hex(targetId))
}

/**
 * Parent of every idle-watch shard directory.
 * @param home - resolved Harness home directory.
 * @returns the `peers/watches` directory path.
 */
export function watchesDirectory(home: string): string {
  return join(peersDirectory(home), 'watches')
}

/**
 * Idle-watch shard directory of one watched session.
 * @param home - resolved Harness home directory.
 * @param targetId - the session being watched.
 * @returns the shard directory path.
 */
export function watchShardDirectory(home: string, targetId: string): string {
  return join(watchesDirectory(home), sha256Hex(targetId))
}

/**
 * Watch file recording one watcher's subscription to one target.
 * @param home - resolved Harness home directory.
 * @param targetId - the watched session.
 * @param watcherId - the session that asked for the notice.
 * @returns the watch file path.
 */
export function watchPath(home: string, targetId: string, watcherId: string): string {
  return join(watchShardDirectory(home, targetId), `${sha256Hex(watcherId)}.json`)
}
