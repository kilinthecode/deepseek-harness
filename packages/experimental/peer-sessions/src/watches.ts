/**
 * Idle watches: one durable subscription per watcher per watched peer.
 *
 * The watcher writes the file while the target is busy; the target's own
 * process deletes it and leaves one notice in the watcher's mailbox on the
 * transition to idle, or deletes it silently when the target is disposed.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions/watches
 */

import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { peerWatchesFull } from './errors.ts'
import { PEER_DIRECTORY_MODE, watchPath, watchesDirectory, watchShardDirectory } from './paths.ts'
import { readRecord, removeRecord, writeRecord } from './record.ts'

/** Version stamped on every watch record; a file with another version is deleted. */
export const PEER_WATCH_VERSION = 1

const watchSchema = z.object({
  version: z.literal(PEER_WATCH_VERSION),
  targetId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  watcherId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  watcherRepo: z.string().min(1),
  watcherName: z.string().min(1),
}).strict()

/** One durable idle subscription. */
export type PeerWatchRecord = z.infer<typeof watchSchema>

/** One watched subscriber, with the file the target deletes. */
export interface PeerWatchEntry {
  /** Absolute path of the watch file. */
  readonly filename: string
  /** The parsed subscription. */
  readonly record: PeerWatchRecord
}

/** One reading of a target's watch shard. */
export interface PeerWatchShard {
  /** Valid subscriptions in directory order. */
  readonly watched: readonly PeerWatchEntry[]
  /** Absolute paths of files that are not valid subscriptions; the target deletes them. */
  readonly invalid: readonly string[]
  /** Number of directory entries, valid or not; every one counts toward the target cap. */
  readonly count: number
}

/**
 * Read one target's watch shard without holding its lock.
 * @param directory - the watch shard directory.
 * @returns valid subscriptions, invalid file paths, and the raw entry count.
 */
export async function readWatchShard(directory: string): Promise<PeerWatchShard> {
  const watched: PeerWatchEntry[] = []
  const invalid: string[] = []
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { watched, invalid, count: 0 }
    throw error
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const filename = join(directory, name)
    const read = await readRecord(watchSchema, filename)
    if (read.kind === 'ok') watched.push({ filename, record: read.record })
    else if (read.kind === 'invalid') invalid.push(filename)
  }
  return { watched, invalid, count: names.length }
}

/**
 * Subscribe one watcher to one target's next idle transition.
 *
 * Refreshing an existing subscription always succeeds; a new one fails once the
 * target holds `maxIdleWatches`. The parent `peers/watches` directory exists
 * before the lock because the lock is a sibling of the shard directory.
 * @param home - resolved Harness home directory.
 * @param record - the complete subscription to commit.
 * @param maxIdleWatches - configured cap for the target.
 * @param targetName - the target's display name, used in the failure text.
 * @returns fulfillment after the subscription is durable.
 * @throws PeerError `PEER_WATCHES_FULL` when a new watch exceeds the cap.
 */
export async function writeWatch(
  home: string,
  record: PeerWatchRecord,
  maxIdleWatches: number,
  targetName: string,
): Promise<void> {
  const shard = watchShardDirectory(home, record.targetId)
  const filename = watchPath(home, record.targetId, record.watcherId)
  await mkdir(watchesDirectory(home), { recursive: true, mode: PEER_DIRECTORY_MODE })
  await withFileLock(shard, async () => {
    if ((await readRecord(watchSchema, filename)).kind === 'ok') {
      await writeRecord(filename, record)
      return
    }
    const shardState = await readWatchShard(shard)
    if (shardState.count >= maxIdleWatches) throw peerWatchesFull(targetName, maxIdleWatches)
    await writeRecord(filename, record)
  })
}

/**
 * Read every watch shard this home holds.
 * @param home - resolved Harness home directory.
 * @returns each target's shard directory beside its reading.
 */
export async function listWatchShards(
  home: string,
): Promise<readonly { readonly directory: string; readonly shard: PeerWatchShard }[]> {
  const directory = watchesDirectory(home)
  let names: string[]
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
  const shards: { directory: string; shard: PeerWatchShard }[] = []
  for (const name of names) {
    const shardDirectory = join(directory, name)
    shards.push({ directory: shardDirectory, shard: await readWatchShard(shardDirectory) })
  }
  return shards
}

/**
 * Delete one watch file.
 * @param filename - absolute path of the watch file.
 * @returns fulfillment after the file no longer exists.
 */
export async function deleteWatch(filename: string): Promise<void> {
  await removeRecord(filename)
}
