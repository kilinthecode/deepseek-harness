/**
 * Activity rows: what one live top-level peer is working on and which files it
 * wrote.
 *
 * One row per qualifying top-level agent, rewritten whenever this process
 * observes a lifecycle, title, todo, or file change, so a reader can see two
 * peers heading for the same path before they clobber each other. The pid
 * decides staleness exactly as it does for presence: a row whose process is gone
 * unlists itself when a reader probes it. A row written by another version is
 * skipped rather than deleted, because that build's session may still be live.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions/activity
 */

import { readdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { activityDirectory, activityPath } from './paths.ts'
import { peerProcessExited } from './presence.ts'
import { readRecord, writeRecord } from './record.ts'
import type { PeerStatus } from './types.ts'

/** Version stamped on every activity row; a row with another version is skipped. */
export const PEER_ACTIVITY_VERSION = 1

/** Every status a published row may carry; the schema and {@link PeerStatus} agree through this list. */
const PEER_STATUSES = ['idle', 'running', 'awaiting-user'] as const satisfies readonly PeerStatus[]

const activityFileSchema = z.object({
  p: z.string().min(1),
  at: z.number().int().nonnegative(),
}).strict()

const activitySchema = z.object({
  version: z.literal(PEER_ACTIVITY_VERSION),
  sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  repoKey: z.string().min(1),
  root: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(PEER_STATUSES),
  pid: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
  doing: z.string().optional(),
  files: z.array(activityFileSchema),
}).strict()

/** One published activity row. */
export type PeerActivityRecord = z.infer<typeof activitySchema>

/** One file write an activity row records. */
export interface PeerActivityFile {
  /** Path key: `rel:` plus the path relative to the checkout, or `abs:` plus the resolved path. */
  readonly p: string
  /** Unix epoch milliseconds when the tool reported the write succeeded. */
  readonly at: number
}

/**
 * Publish one session's activity row.
 * @param home - resolved Harness home directory.
 * @param record - the complete row to publish.
 * @returns fulfillment after the row is committed.
 */
export async function writeActivity(home: string, record: PeerActivityRecord): Promise<void> {
  await writeRecord(activityPath(home, record.sessionId), record)
}

/**
 * Remove one session's activity row.
 * @param home - resolved Harness home directory.
 * @param sessionId - the session whose row is retired.
 * @returns fulfillment after the row no longer exists.
 */
export async function removeActivity(home: string, sessionId: string): Promise<void> {
  await rm(activityPath(home, sessionId), { force: true })
}

/**
 * Read one session's activity row, retiring it when its process is gone.
 * @param home - resolved Harness home directory.
 * @param sessionId - the session whose row is read.
 * @returns the live row, or `undefined` when the row is absent, unreadable, or
 * published by a process that has exited.
 */
export async function readActivity(home: string, sessionId: string): Promise<PeerActivityRecord | undefined> {
  const filename = activityPath(home, sessionId)
  const read = await readRecord(activitySchema, filename)
  if (read.kind !== 'ok') return undefined
  if (!peerProcessExited(read.record.pid)) return read.record
  await rm(filename, { force: true })
  return undefined
}

/**
 * Read every activity row a reader sees, retiring the rows of gone processes.
 *
 * An unreadable or differently versioned row is skipped rather than deleted:
 * another build owns it, and its session may still be live.
 * @param home - resolved Harness home directory.
 * @returns the live rows, in directory order.
 */
export async function listActivity(home: string): Promise<readonly PeerActivityRecord[]> {
  const directory = activityDirectory(home)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
  const rows: PeerActivityRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const filename = join(directory, name)
    const read = await readRecord(activitySchema, filename)
    if (read.kind !== 'ok') continue
    if (peerProcessExited(read.record.pid)) {
      await rm(filename, { force: true })
      continue
    }
    rows.push(read.record)
  }
  return rows
}

/**
 * Key one tool call's path for an activity row.
 *
 * A path inside the checkout is recorded relative to its root, so the two
 * worktrees of one repository compare the same file; every other path is
 * recorded absolute, because it names no file of this checkout.
 *
 * @param root - checkout root the writing session sits in.
 * @param cwd - canonical working directory the tool path is resolved against.
 * @param toolPath - the model-facing path the tool is about to mutate.
 * @returns `rel:` plus the root-relative path with `/` separators, or `abs:` plus the resolved path.
 */
export function activityFileKey(root: string, cwd: string, toolPath: string): string {
  const resolved = resolve(cwd, toolPath)
  const inside = relative(root, resolved)
  if (inside !== '' && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)) {
    return `rel:${inside.split(sep).join('/')}`
  }
  return `abs:${resolved}`
}
