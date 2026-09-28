/**
 * Durable per-worktree JSON records: the on-disk representation (the public
 * `WorktreeRecord` plus in-process accept bookkeeping), schema validation on
 * read, atomic locked writes, id generation, cross-repository lookup by id,
 * and the owner/state assertions shared by `attach`, `accept`, and `discard`.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/records
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { pathExists } from './fs-util.ts'
import { layoutFor, recordPathFor, repoKeyFor } from './paths.ts'
import type { WorktreeLayout } from './paths.ts'
import type { WorktreeId, WorktreeOwner, WorktreeRecord, WorktreeRoute, WorktreeVerdict } from './types.ts'

/**
 * On-disk representation of one worktree: the public record plus the
 * bookkeeping an in-flight `accept` needs to detect and recover from a
 * crashed holder. These two fields never appear on a `WorktreeRecord` a
 * public method returns; see {@link toPublicRecord}.
 */
export interface StoredWorktreeRecord extends WorktreeRecord {
  /** Process id of the accept operation currently in the `reviewing` state; absent outside that state. */
  readonly reviewingPid?: number
  /** Epoch milliseconds when the current `reviewing` state began; absent outside that state. */
  readonly reviewingStartedAt?: number
}

/** Random bytes used to compose a {@link WorktreeId}. */
export const WORKTREE_ID_BYTES = 4

/** Bound on collision retries before {@link pickWorktreeId} fails loud. */
const WORKTREE_ID_MAX_ATTEMPTS = 64

/**
 * Brand a random byte buffer as a {@link WorktreeId}.
 * @param bytes - {@link WORKTREE_ID_BYTES} random bytes.
 * @returns `wt-` followed by the bytes' lowercase hex encoding.
 */
export function formatWorktreeId(bytes: Buffer): WorktreeId {
  return brandString<WorktreeId>(`wt-${bytes.toString('hex')}`)
}

/**
 * Pick a {@link WorktreeId} with no existing record, regenerating on
 * collision. Exposed separately from {@link generateWorktreeId} so the retry
 * and exhaustion behavior is directly unit-testable with injected fakes.
 * @param exists - whether a candidate id already has a record.
 * @param random - source of {@link WORKTREE_ID_BYTES} random bytes; defaults to `crypto.randomBytes`.
 * @returns a collision-free id.
 * @throws when every attempt within {@link WORKTREE_ID_MAX_ATTEMPTS} collides.
 */
export async function pickWorktreeId(
  exists: (id: WorktreeId) => Promise<boolean>,
  random: () => Buffer = () => randomBytes(WORKTREE_ID_BYTES),
): Promise<WorktreeId> {
  for (let attempt = 0; attempt < WORKTREE_ID_MAX_ATTEMPTS; attempt += 1) {
    const id = formatWorktreeId(random())
    if (!await exists(id)) return id
  }
  throw new Error('subagent-worktree: could not generate a unique worktree id')
}

/**
 * Pick a fresh {@link WorktreeId} for a repository, checking collisions
 * against that repository's records directory.
 * @param layout - the repository's directory layout.
 * @returns a collision-free id.
 */
export function generateWorktreeId(layout: WorktreeLayout): Promise<WorktreeId> {
  return pickWorktreeId(async id => pathExists(recordPathFor(layout, id)))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isWorktreeOwner(value: unknown): value is WorktreeOwner {
  if (!isPlainObject(value)) return false
  if (value.kind === 'operator') return true
  return value.kind === 'session' && typeof value.sessionId === 'string'
}

function isWorktreeRoute(value: unknown): value is WorktreeRoute {
  return isPlainObject(value)
    && typeof value.provider === 'string'
    && typeof value.model === 'string'
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
}

function isWorktreeVerdict(value: unknown): value is WorktreeVerdict {
  return isPlainObject(value)
    && (value.verdict === 'pass' || value.verdict === 'fail')
    && typeof value.summary === 'string'
    && isStringArray(value.checks)
    && isStringArray(value.findings)
    && typeof value.commit === 'string'
    && typeof value.reviewerSessionId === 'string'
    && isWorktreeRoute(value.reviewerRoute)
    && typeof value.at === 'number'
}

const WORKTREE_STATES: ReadonlySet<string> = new Set(['open', 'reviewing', 'merged', 'discarded'])

/**
 * Validate a parsed JSON value as a {@link StoredWorktreeRecord}, the durable
 * boundary for one worktree's persisted state.
 * @param value - the parsed JSON value.
 * @param sourcePath - the record file path, named in the thrown message.
 * @throws when `value` does not match the stored record shape.
 */
export function assertStoredWorktreeRecord(value: unknown, sourcePath: string): asserts value is StoredWorktreeRecord {
  if (
    !isPlainObject(value)
    || typeof value.id !== 'string'
    || typeof value.repoRoot !== 'string'
    || typeof value.path !== 'string'
    || typeof value.branch !== 'string'
    || typeof value.baseCommit !== 'string'
    || !isWorktreeOwner(value.owner)
    || typeof value.label !== 'string'
    || typeof value.task !== 'string'
    || typeof value.state !== 'string' || !WORKTREE_STATES.has(value.state)
    || typeof value.createdAt !== 'number'
    || !isStringArray(value.workerSessionIds)
    || (value.workerRoute !== undefined && !isWorktreeRoute(value.workerRoute))
    || (value.lastVerdict !== undefined && !isWorktreeVerdict(value.lastVerdict))
    || (value.mergedCommit !== undefined && typeof value.mergedCommit !== 'string')
    || (value.reviewingPid !== undefined && typeof value.reviewingPid !== 'number')
    || (value.reviewingStartedAt !== undefined && typeof value.reviewingStartedAt !== 'number')
  ) {
    throw new Error(`subagent-worktree: worktree record "${sourcePath}" is corrupt`)
  }
}

function parseStoredWorktreeRecord(raw: string, sourcePath: string): StoredWorktreeRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`subagent-worktree: worktree record "${sourcePath}" is corrupt: ${(error as Error).message}`)
  }
  assertStoredWorktreeRecord(parsed, sourcePath)
  return parsed
}

async function loadRecordOrUndefined(path: string): Promise<StoredWorktreeRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parseStoredWorktreeRecord(raw, path)
}

/** Hold `path`'s writer lock around a read-modify-write cycle and persist the updater's result. */
async function updateRecord(
  path: string,
  updater: (current: StoredWorktreeRecord | undefined) => StoredWorktreeRecord,
): Promise<StoredWorktreeRecord> {
  // withFileLock creates `<path>.lock` directly with no recursive mkdir of its
  // own (its parent directory must already exist); the very first worktree for
  // a repository has no records/ directory yet, so this call creates it before
  // the lock file write is attempted.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  return withFileLock(path, async () => {
    const current = await loadRecordOrUndefined(path)
    const next = updater(current)
    await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    return next
  })
}

/**
 * Create a brand-new record file. The id must not already have a record —
 * {@link generateWorktreeId} guarantees this in production; a direct second
 * call with the same id (for example in a test) fails loud instead of
 * silently overwriting a worktree's history.
 * @param layout - the repository's directory layout.
 * @param record - the complete fresh `open` record.
 * @returns the persisted record.
 * @throws when a record already exists for `record.id`.
 */
export async function createRecord(layout: WorktreeLayout, record: StoredWorktreeRecord): Promise<StoredWorktreeRecord> {
  const path = recordPathFor(layout, record.id)
  return updateRecord(path, (current) => {
    if (current !== undefined) throw new Error(`subagent-worktree: worktree record "${path}" already exists`)
    return record
  })
}

/** One worktree record located by id, with the file path and repository layout it was found under. */
export interface RecordLocation {
  /** The record file's absolute path. */
  readonly path: string
  /** The owning repository's directory layout. */
  readonly layout: WorktreeLayout
  /** The record as read. */
  readonly record: StoredWorktreeRecord
}

/**
 * Find one worktree's record by id, searching every repository directory
 * under `root`. `attach`, `accept`, and `discard` requests carry only an id —
 * not the repository — so this is the only way to locate the record they
 * name; the record's own `repoRoot` then supplies the repository for every
 * later git command.
 * @param root - the service's configured or resolved worktree root.
 * @param id - the worktree id to find.
 * @returns the location, or undefined when no repository under `root` holds that id.
 */
export async function locateRecord(root: string, id: WorktreeId): Promise<RecordLocation | undefined> {
  let repoKeys: string[]
  try {
    repoKeys = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  for (const repoKey of repoKeys) {
    const layout = layoutFor(root, repoKey)
    const path = recordPathFor(layout, id)
    const record = await loadRecordOrUndefined(path)
    if (record !== undefined) return { path, layout, record }
  }
  return undefined
}

/**
 * {@link locateRecord}, failing loud when no repository under `root` holds the id.
 * @param root - the service's configured or resolved worktree root.
 * @param id - the worktree id to find.
 * @returns the location.
 * @throws when no record exists for `id`.
 */
export async function requireRecordLocation(root: string, id: WorktreeId): Promise<RecordLocation> {
  const found = await locateRecord(root, id)
  if (found === undefined) throw new Error(`subagent-worktree: no worktree "${id}"`)
  return found
}

/**
 * Read-modify-write an existing record at a known path, failing loud if it
 * was removed since it was located.
 * @param path - the record file's absolute path, from a prior {@link RecordLocation}.
 * @param id - the worktree id, named in the not-found message.
 * @param updater - transform applied under the writer lock.
 * @returns the persisted record.
 * @throws when `path` no longer has a record.
 */
export async function updateExistingRecordAt(
  path: string,
  id: WorktreeId,
  updater: (current: StoredWorktreeRecord) => StoredWorktreeRecord,
): Promise<StoredWorktreeRecord> {
  return updateRecord(path, (current) => {
    if (current === undefined) throw new Error(`subagent-worktree: no worktree "${id}"`)
    return updater(current)
  })
}

/**
 * List every worktree record for one repository.
 * @param layout - the repository's directory layout.
 * @returns every record under `layout.recordsDir`, or `[]` when no worktree was ever created for this repository.
 */
export async function listRecords(layout: WorktreeLayout): Promise<StoredWorktreeRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(layout.recordsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: StoredWorktreeRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const path = join(layout.recordsDir, entry)
    records.push(parseStoredWorktreeRecord(await readFile(path, 'utf8'), path))
  }
  return records
}

/**
 * Count records currently occupying a worktree slot for a repository. Counts
 * a stale `reviewing` record (its accepting process is gone) the same as a
 * live one: the worktree directory and branch still exist either way, so the
 * slot is still occupied until an `accept` or `discard` resolves it.
 * @param layout - the repository's directory layout.
 * @returns the number of `open` or `reviewing` records.
 */
export async function countOpenSlots(layout: WorktreeLayout): Promise<number> {
  const records = await listRecords(layout)
  return records.filter(record => record.state === 'open' || record.state === 'reviewing').length
}

/**
 * Strip the internal accept-bookkeeping fields before returning a record
 * through the public service surface.
 * @param stored - the on-disk record.
 * @returns the public `WorktreeRecord` fields only.
 */
export function toPublicRecord(stored: StoredWorktreeRecord): WorktreeRecord {
  const { reviewingPid: _reviewingPid, reviewingStartedAt: _reviewingStartedAt, ...record } = stored
  return record
}

/**
 * Compute a repository's directory layout from a base directory's resolved
 * top-level path.
 * @param root - the service's configured or resolved worktree root.
 * @param repoRoot - the repository's realpath-resolved top-level directory.
 * @returns the repository's directory layout.
 */
export function layoutForRepo(root: string, repoRoot: string): WorktreeLayout {
  return layoutFor(root, repoKeyFor(repoRoot))
}

/** Whether a process id names a process the current host can still observe. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists under another user; only ESRCH proves it is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Enforce owner authority for `attach`, `accept`, and `discard`: an
 * `operator` request acts on every record; a `session` request must name the
 * exact session that owns the record.
 * @param record - the record being acted on.
 * @param requestOwner - the authority making the request.
 * @param id - the worktree id, named in the thrown message.
 * @throws when `requestOwner` does not own `record`.
 */
export function assertOwnerAuthority(record: Pick<WorktreeRecord, 'owner'>, requestOwner: WorktreeOwner, id: WorktreeId): void {
  if (requestOwner.kind === 'operator') return
  if (record.owner.kind === 'session' && record.owner.sessionId === requestOwner.sessionId) return
  throw new Error(`subagent-worktree: worktree ${id} belongs to another session`)
}

/**
 * Refuse `attach` on a terminal record. `open` and `reviewing` — including a
 * `reviewing` record whose accepting process has exited — both remain
 * attachable: the state machine forbids only a *closed* worktree from
 * gaining a new worker.
 * @param record - the record being acted on.
 * @param id - the worktree id, named in the thrown message.
 * @throws when the record is `merged` or `discarded`.
 */
export function assertNotTerminal(record: Pick<WorktreeRecord, 'state'>, id: WorktreeId): void {
  if (record.state === 'merged' || record.state === 'discarded') {
    throw new Error(`subagent-worktree: worktree ${id} is ${record.state}`)
  }
}

/**
 * Enforce the precondition shared by `accept` and `discard`: the record must
 * be `open`, or `reviewing` with its accepting process gone (crash recovery).
 * A live `reviewing` record and both terminal states are refused.
 * @param record - the record being acted on.
 * @param id - the worktree id, named in the thrown message.
 * @throws `worktree <id> is already being accepted` for a live `reviewing` record, or
 *   `worktree <id> is <state>` for a terminal record.
 */
export function assertOpenOrRecoverable(record: StoredWorktreeRecord, id: WorktreeId): void {
  if (record.state === 'open') return
  if (record.state === 'reviewing') {
    if (record.reviewingPid !== undefined && isProcessAlive(record.reviewingPid)) {
      throw new Error(`subagent-worktree: worktree ${id} is already being accepted`)
    }
    return
  }
  throw new Error(`subagent-worktree: worktree ${id} is ${record.state}`)
}
