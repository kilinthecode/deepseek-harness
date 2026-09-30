/**
 * Durable per-worktree JSON records: the on-disk representation (the public
 * `WorktreeRecord` plus in-process accept bookkeeping), schema validation on
 * read, atomic locked writes, id generation, cross-repository lookup by id,
 * and the owner/state assertions shared by `attach`, `accept`, and `discard`.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/records
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { pathExists } from './fs-util.ts'
import { isPlainObject, isStringArray } from './guards.ts'
import { layoutFor, recordPathFor, repoKeyFor, worktreeDirFor } from './paths.ts'
import type { WorktreeLayout } from './paths.ts'
import type { WorktreeId, WorktreeOwner, WorktreeRecord, WorktreeRoute, WorktreeVerdict } from './types.ts'
import { assertWorktreeId, isWorktreeId } from './worktree-id.ts'

/**
 * On-disk representation of one worktree: the public record plus the
 * bookkeeping an in-flight `accept` needs to detect and recover from a
 * crashed holder. This field never appears on a `WorktreeRecord` a public
 * method returns; see {@link toPublicRecord}.
 */
export interface StoredWorktreeRecord extends WorktreeRecord {
  /** Process id of the accept operation currently in the `reviewing` state; absent outside that state. */
  readonly reviewingPid?: number
}

/**
 * Fields an earlier build stored in a record file that no current build reads.
 * They are dropped when a record is read, so the next write removes them from
 * the file, and they never reach a public record.
 */
interface LegacyStoredFields {
  /** When an earlier build's accept entered `reviewing`; superseded by the process id claim. */
  readonly reviewingStartedAt?: number
}

/**
 * The record without the fields an earlier build stored and no current build reads.
 * @param record - a record as read from a file, or as handed to {@link toPublicRecord}.
 * @returns the record with no {@link LegacyStoredFields}.
 */
function withoutLegacyFields(record: StoredWorktreeRecord & LegacyStoredFields): StoredWorktreeRecord {
  const { reviewingStartedAt: _reviewingStartedAt, ...current } = record
  return current
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
 * @returns an assertion that `value` is a validated stored worktree record.
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
    || !isWorktreeRoute(value.workerRoute)
    || (value.lastVerdict !== undefined && !isWorktreeVerdict(value.lastVerdict))
    || (value.mergedCommit !== undefined && typeof value.mergedCommit !== 'string')
    || (value.reviewingPid !== undefined && typeof value.reviewingPid !== 'number')
  ) {
    throw new Error(`subagent-worktree: worktree record "${sourcePath}" is corrupt`)
  }
}

/**
 * Pattern every full git commit id in a stored record must match: 40 lowercase
 * hexadecimal digits (SHA-1 repositories) or 64 (SHA-256 repositories).
 */
const COMMIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * Verify a shape-valid record is consistent with where it is stored, both when
 * it is loaded and before it is written: its own id names its file, its
 * worktree directory is the one this repository layout assigns that id, its
 * branch names its id, and every commit id is a full lowercase hexadecimal id
 * (40 digits, or 64 in a SHA-256 repository). A record failing any of these
 * was corrupted or edited on
 * disk, and acting on it could aim a `git worktree remove --force` or a merge
 * at a path or commit that was never this worktree's.
 * @param record - the shape-validated record.
 * @param layout - the repository layout the record is stored under.
 * @param id - the worktree id the record is stored by (its file's own basename).
 * @param sourcePath - the record file path, named in the thrown message.
 * @throws when the record's id, worktree path, branch, or any commit id is inconsistent.
 */
function assertRecordIntegrity(record: StoredWorktreeRecord, layout: WorktreeLayout, id: WorktreeId, sourcePath: string): void {
  if (record.id !== id) {
    throw new Error(`subagent-worktree: worktree record "${sourcePath}" holds id "${record.id}", not "${id}"`)
  }
  if (record.path !== worktreeDirFor(layout, id)) {
    throw new Error(`subagent-worktree: worktree record "${sourcePath}" names worktree directory "${record.path}", not the one its id maps to`)
  }
  if (!record.branch.endsWith(id)) {
    throw new Error(`subagent-worktree: worktree record "${sourcePath}" names branch "${record.branch}", which does not end with its id`)
  }
  if (!COMMIT_ID_PATTERN.test(record.baseCommit)) {
    throw new Error(`subagent-worktree: worktree record "${sourcePath}" has baseCommit "${record.baseCommit}", not a full commit id`)
  }
  if (record.mergedCommit !== undefined && !COMMIT_ID_PATTERN.test(record.mergedCommit)) {
    throw new Error(`subagent-worktree: worktree record "${sourcePath}" has mergedCommit "${record.mergedCommit}", not a full commit id`)
  }
  if (record.lastVerdict !== undefined && !COMMIT_ID_PATTERN.test(record.lastVerdict.commit)) {
    throw new Error(`subagent-worktree: worktree record "${sourcePath}" has a verdict commit "${record.lastVerdict.commit}", not a full commit id`)
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
  return withoutLegacyFields(parsed)
}

/**
 * Read and validate one record by id under one repository layout.
 * @param layout - the repository layout to look under.
 * @param id - the worktree id; its file is `<recordsDir>/<id>.json`.
 * @returns the validated record, or undefined when that file does not exist.
 * @throws when the file is corrupt or fails {@link assertRecordIntegrity}.
 */
async function loadRecordOrUndefined(layout: WorktreeLayout, id: WorktreeId): Promise<StoredWorktreeRecord | undefined> {
  const path = recordPathFor(layout, id)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const record = parseStoredWorktreeRecord(raw, path)
  assertRecordIntegrity(record, layout, id, path)
  return record
}

/** Hold one record file's writer lock around a read-modify-write cycle and persist the updater's result. */
async function updateRecord(
  layout: WorktreeLayout,
  id: WorktreeId,
  updater: (current: StoredWorktreeRecord | undefined) => StoredWorktreeRecord,
): Promise<StoredWorktreeRecord> {
  const path = recordPathFor(layout, id)
  // withFileLock creates `<path>.lock` directly with no recursive mkdir of its
  // own (its parent directory must already exist); the very first worktree for
  // a repository has no records/ directory yet, so this call creates it before
  // the lock file write is attempted.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  return withFileLock(path, async () => {
    const current = await loadRecordOrUndefined(layout, id)
    const next = updater(current)
    // A record this check would reject on load must never reach disk: it would
    // make every later operation on the worktree fail as corrupt.
    assertRecordIntegrity(next, layout, id, path)
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
  return updateRecord(layout, record.id, (current) => {
    if (current !== undefined) throw new Error(`subagent-worktree: worktree record "${recordPathFor(layout, record.id)}" already exists`)
    return record
  })
}

/** Receives a warning about something a scan skipped instead of failing on. */
export type ScanWarning = (message: string) => void

/** The default scan warning: none. */
const NO_WARNING: ScanWarning = () => {}

/**
 * Whether a record file can be seen at `path`. A `stat` failure of any kind
 * (`ENOENT` for an absent file, `ENOTDIR` under a stray file, `EACCES` in a
 * directory this process may not enter) means the candidate does not hold the
 * record file being searched for, so it reads as `false`; `pathExists` would
 * throw on the last two.
 */
async function recordFileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
  } catch {
    return false
  }
  return true
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
 * Candidates are searched in name order, so the search and its warnings do not
 * depend on the file system's listing order. A candidate that cannot be read
 * as a repository (a stray file under `root`, a directory this process may not
 * enter) is skipped with a warning, because nothing about it says it holds the
 * record; only a record file that exists at the id's own path and cannot be
 * read or fails validation fails loud.
 * @param root - the service's configured or resolved worktree root.
 * @param id - the worktree id to find.
 * @param warn - receives a warning for each candidate that was skipped.
 * @returns the location, or undefined when no repository under `root` holds that id.
 * @throws when the id's own record file exists and is unreadable, corrupt, or inconsistent.
 */
export async function locateRecord(root: string, id: WorktreeId, warn: ScanWarning = NO_WARNING): Promise<RecordLocation | undefined> {
  assertWorktreeId(id)
  let repoKeys: string[]
  try {
    repoKeys = (await readdir(root)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  for (const repoKey of repoKeys) {
    const layout = layoutFor(root, repoKey)
    try {
      const record = await loadRecordOrUndefined(layout, id)
      if (record !== undefined) return { path: recordPathFor(layout, id), layout, record }
    } catch (error) {
      if (await recordFileExists(recordPathFor(layout, id))) throw error
      warn(`subagent-worktree: skipped "${layout.repoDir}" while looking for worktree ${id}: ${String(error)}`)
    }
  }
  return undefined
}

/**
 * {@link locateRecord}, failing loud when no repository under `root` holds the id.
 * @param root - the service's configured or resolved worktree root.
 * @param id - the worktree id to find.
 * @param warn - receives a warning for each candidate that was skipped.
 * @returns the location.
 * @throws when no record exists for `id`.
 */
export async function requireRecordLocation(root: string, id: WorktreeId, warn: ScanWarning = NO_WARNING): Promise<RecordLocation> {
  const found = await locateRecord(root, id, warn)
  if (found === undefined) throw new Error(`subagent-worktree: no worktree "${id}"`)
  return found
}

/**
 * Read-modify-write an existing record under its writer lock, failing loud if
 * it was removed since it was located. The `updater` runs against the record
 * as read under the lock, so a state precondition checked inside it — not one
 * checked on an earlier read — is what actually serializes concurrent callers.
 * @param layout - the repository layout, from a prior {@link RecordLocation}.
 * @param id - the worktree id.
 * @param updater - transform applied under the writer lock; a throw leaves the record unchanged.
 * @returns the persisted record.
 * @throws when the record no longer exists.
 */
export async function updateExistingRecordAt(
  layout: WorktreeLayout,
  id: WorktreeId,
  updater: (current: StoredWorktreeRecord) => StoredWorktreeRecord,
): Promise<StoredWorktreeRecord> {
  return updateRecord(layout, id, (current) => {
    if (current === undefined) throw new Error(`subagent-worktree: no worktree "${id}"`)
    return updater(current)
  })
}

/**
 * List every worktree record for one repository. A `.json` file whose name is
 * not a worktree id is not a record: it is skipped with a warning rather than
 * failing every listing, count, and `create` for the repository.
 * @param layout - the repository's directory layout.
 * @param warn - receives a warning for each stray file that was skipped.
 * @returns every record under `layout.recordsDir`, or `[]` when no worktree was ever created for this repository.
 * @throws when a record file named for a worktree id is corrupt or fails {@link assertRecordIntegrity}.
 */
export async function listRecords(layout: WorktreeLayout, warn: ScanWarning = NO_WARNING): Promise<StoredWorktreeRecord[]> {
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
    const id = entry.slice(0, -'.json'.length)
    const path = join(layout.recordsDir, entry)
    if (!isWorktreeId(id)) {
      warn(`subagent-worktree: ignoring "${path}": its name is not a worktree id, so it is not a worktree record`)
      continue
    }
    const record = parseStoredWorktreeRecord(await readFile(path, 'utf8'), path)
    assertRecordIntegrity(record, layout, id, path)
    records.push(record)
  }
  return records
}

/**
 * Count records currently occupying a worktree slot for a repository. Counts
 * a stale `reviewing` record (its accepting process is gone) the same as a
 * live one: the worktree directory and branch still exist either way, so the
 * slot is still occupied until an `accept` or `discard` resolves it.
 * @param layout - the repository's directory layout.
 * @param warn - receives a warning for each stray file the listing skipped.
 * @returns the number of `open` or `reviewing` records.
 */
export async function countOpenSlots(layout: WorktreeLayout, warn: ScanWarning = NO_WARNING): Promise<number> {
  const records = await listRecords(layout, warn)
  return records.filter(record => record.state === 'open' || record.state === 'reviewing').length
}

/**
 * Strip the internal accept-bookkeeping field, and any field an earlier build
 * stored, before returning a record through the public service surface.
 * @param stored - the on-disk record.
 * @returns the public `WorktreeRecord` fields only.
 */
export function toPublicRecord(stored: StoredWorktreeRecord): WorktreeRecord {
  const { reviewingPid: _reviewingPid, ...record } = withoutLegacyFields(stored)
  return record
}

/**
 * Compute a repository's directory layout from its shared git common
 * directory. Every linked worktree of one repository resolves the same common
 * directory, so all of them share one records directory, merge lock, and
 * `maxWorktrees` count.
 * @param root - the service's configured or resolved worktree root.
 * @param commonDir - the repository's realpath-resolved git common directory.
 * @returns the repository's directory layout.
 */
export function layoutForRepo(root: string, commonDir: string): WorktreeLayout {
  return layoutFor(root, repoKeyFor(commonDir))
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
 * Enforce the `attach` precondition: only an `open` record gains a worker. A
 * `reviewing` record is held by an in-flight `accept`, and attaching a worker
 * to it would race that accept's commit; `merged` and `discarded` are closed.
 * @param record - the record being acted on.
 * @param id - the worktree id, named in the thrown message.
 * @throws `worktree <id> is <state>` when the record is not `open`.
 */
export function assertOpen(record: Pick<WorktreeRecord, 'state'>, id: WorktreeId): void {
  if (record.state !== 'open') {
    throw new Error(`subagent-worktree: worktree ${id} is ${record.state}`)
  }
}

/**
 * Enforce the precondition shared by `accept` and `discard`: the record must
 * be `open`, or `reviewing` with its accepting process gone (crash recovery).
 * A live `reviewing` record and both terminal states are refused. Liveness is
 * the recorded process id answering a signal-0 probe, so a crashed accept
 * whose process id an unrelated later process reused reads as live and keeps
 * the worktree refused as "already being accepted" until an operator clears
 * the record — the same accepted limit `withFileLock` documents for its own
 * process-id lock takeover.
 * @param record - the record being acted on.
 * @param id - the worktree id, named in the thrown message.
 * @throws `worktree <id> is already being accepted` for a live `reviewing` record, or
 *   `worktree <id> is <state>` for a terminal record.
 */
export function assertOpenOrRecoverable(record: StoredWorktreeRecord, id: WorktreeId): void {
  if (record.state === 'open') return
  if (record.state === 'reviewing') {
    if (!isStaleReviewing(record)) throw new Error(`subagent-worktree: worktree ${id} is already being accepted`)
    return
  }
  throw new Error(`subagent-worktree: worktree ${id} is ${record.state}`)
}

/**
 * Whether a record is `reviewing` on a claim no live process holds: its
 * accepting process is gone, or never recorded a process id. Such a record is
 * what a crashed accept leaves behind.
 * @param record - the record being acted on.
 * @returns whether the record is `reviewing` and its claim is stale.
 */
export function isStaleReviewing(record: StoredWorktreeRecord): boolean {
  return record.state === 'reviewing' && !(record.reviewingPid !== undefined && isProcessAlive(record.reviewingPid))
}

/**
 * The record without its accept claim (`reviewingPid`); the state and every
 * other field are unchanged.
 * @param record - the record to release.
 * @returns the record with no process id claim.
 */
export function withoutReviewingPid(record: StoredWorktreeRecord): StoredWorktreeRecord {
  const { reviewingPid: _reviewingPid, ...released } = record
  return released
}
