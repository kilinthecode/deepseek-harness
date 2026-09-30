/**
 * Presence rows: who is live, where, and in which repository.
 *
 * One row per qualifying top-level agent, rewritten on every lifecycle or
 * approval change this process observes. The pid decides staleness: a row whose
 * process is gone unlists itself when a reader probes it, and no heartbeat or
 * age threshold can unlist a live one.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions/presence
 */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { presenceDirectory, presencePath } from './paths.ts'
import { readRecord, writeRecord } from './record.ts'
import type { PeerStatus } from './types.ts'

/** Version stamped on every presence row; a row with another version is skipped. */
export const PEER_PRESENCE_VERSION = 1

/** Every status a published row may carry; the schema and {@link PeerStatus} agree through this list. */
const PEER_STATUSES = ['idle', 'running', 'awaiting-user'] as const satisfies readonly PeerStatus[]

const presenceSchema = z.object({
  version: z.literal(PEER_PRESENCE_VERSION),
  sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  repoKey: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(PEER_STATUSES),
  pid: z.number().int().positive(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
}).strict()

/** One published presence row. */
export type PeerPresenceRecord = z.infer<typeof presenceSchema>

/**
 * Probe one recorded pid with the same `process.kill(pid, 0)` signal the writer
 * lock uses.
 *
 * `ESRCH` proves no such process exists, so the row is stale. `EPERM` proves
 * some process holds that pid under another user, so the row stays. Every other
 * failure, including a platform that cannot probe, keeps the row: peer
 * presence errs toward listing a dead session.
 * @param pid - recorded process id of the publishing process.
 * @returns whether the process is provably gone.
 */
export function peerProcessExited(pid: number): boolean {
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH'
  }
}

/**
 * Publish one session's presence row.
 * @param home - resolved Harness home directory.
 * @param record - the complete row to publish.
 * @returns fulfillment after the row is committed.
 */
export async function writePresence(home: string, record: PeerPresenceRecord): Promise<void> {
  await writeRecord(presencePath(home, record.sessionId), record)
}

/**
 * Remove one session's presence row.
 * @param home - resolved Harness home directory.
 * @param sessionId - the session whose row is retired.
 * @returns fulfillment after the row no longer exists.
 */
export async function removePresence(home: string, sessionId: string): Promise<void> {
  await rm(presencePath(home, sessionId), { force: true })
}

/**
 * Read one session's presence row, retiring it when its process is gone.
 * @param home - resolved Harness home directory.
 * @param sessionId - the session whose row is read.
 * @returns the live row, or `undefined` when the row is absent, unreadable, or
 * published by a process that has exited.
 */
export async function readPresence(home: string, sessionId: string): Promise<PeerPresenceRecord | undefined> {
  const filename = presencePath(home, sessionId)
  const read = await readRecord(presenceSchema, filename)
  if (read.kind !== 'ok') return undefined
  if (!peerProcessExited(read.record.pid)) return read.record
  await rm(filename, { force: true })
  return undefined
}

/**
 * Read every presence row a reader sees, retiring the rows of gone processes.
 *
 * An unreadable or differently versioned row is skipped rather than deleted:
 * another build owns it, and it may still be live.
 * @param home - resolved Harness home directory.
 * @returns the live rows, in directory order.
 */
export async function listPresence(home: string): Promise<readonly PeerPresenceRecord[]> {
  const directory = presenceDirectory(home)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
  const rows: PeerPresenceRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const filename = join(directory, name)
    const read = await readRecord(presenceSchema, filename)
    if (read.kind !== 'ok') continue
    if (peerProcessExited(read.record.pid)) {
      await rm(filename, { force: true })
      continue
    }
    rows.push(read.record)
  }
  return rows
}
