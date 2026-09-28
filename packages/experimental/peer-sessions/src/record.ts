/**
 * Shared read and write of one durable JSON record file.
 *
 * Every durable peer artifact is one JSON document validated on read, so a
 * truncated, hand-edited, or older-versioned file never reaches typed logic.
 * Readers distinguish "absent" from "unreadable" because the owner deletes an
 * unreadable record and ignores an absent one.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions/record
 */

import { mkdir, readFile, rm, rmdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ZodType } from 'zod'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { PEER_DIRECTORY_MODE, PEER_FILE_MODE } from './paths.ts'

/** Result of reading one record file. */
export type RecordRead<T> =
  /** The file parsed and satisfied its schema. */
  | { readonly kind: 'ok'; readonly record: T }
  /** No file exists at that path. */
  | { readonly kind: 'missing' }
  /** A file exists but is unreadable JSON or fails its schema. */
  | { readonly kind: 'invalid' }

/**
 * Read and validate one durable record.
 * @param schema - the record's boundary schema.
 * @param filename - absolute path of the record file.
 * @returns the parsed record, `missing`, or `invalid`; no failure is thrown for
 * a bad file, and any other filesystem failure propagates.
 */
export async function readRecord<T>(schema: ZodType<T>, filename: string): Promise<RecordRead<T>> {
  let raw: string
  try {
    raw = await readFile(filename, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // A truncated or hand-edited file is not a record; the caller drops it.
    return { kind: 'invalid' }
  }
  const parsed = schema.safeParse(value)
  return parsed.success ? { kind: 'ok', record: parsed.data } : { kind: 'invalid' }
}

/**
 * Replace one durable record in a single atomic step.
 * @param filename - absolute path of the record file.
 * @param record - the complete record to serialize.
 * @returns fulfillment after the content is committed.
 */
export async function writeRecord(filename: string, record: unknown): Promise<void> {
  await writeFileAtomic(filename, `${JSON.stringify(record)}\n`, {
    mode: PEER_FILE_MODE,
    dirMode: PEER_DIRECTORY_MODE,
  })
}

/**
 * Remove one record file if it exists.
 * @param filename - absolute path of the record file.
 * @returns fulfillment after the path no longer exists.
 */
export async function removeRecord(filename: string): Promise<void> {
  await rm(filename, { force: true })
}

/**
 * Remove a shard directory that holds no entries.
 *
 * `ENOTEMPTY` leaves the directory: another writer committed an entry between
 * the reader's listing and this call, and `ENOENT` is already the desired end
 * state. Every other failure propagates.
 * @param directory - absolute shard directory path.
 * @returns fulfillment once the directory is gone or proven non-empty.
 */
export async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') return
    throw error
  }
}

/**
 * Remove a shard directory that holds no entries while holding that shard's
 * writer lock.
 *
 * Enqueueing is a lock plus a read plus a write, so removing an empty shard
 * between two of those steps would delete the directory a committed entry is
 * about to land in. Both sides take `<shard>.lock`, a sibling of the shard
 * directory, so the parent must exist before the lock — exactly what a writer
 * creates first.
 * @param directory - absolute shard directory path.
 * @returns fulfillment once the directory is gone or proven non-empty.
 */
export async function removeEmptyShard(directory: string): Promise<void> {
  await mkdir(dirname(directory), { recursive: true, mode: PEER_DIRECTORY_MODE })
  await withFileLock(directory, async () => { await removeEmptyDirectory(directory) })
}
