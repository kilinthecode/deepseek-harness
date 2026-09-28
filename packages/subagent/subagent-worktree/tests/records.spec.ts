import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { layoutFor } from '../src/paths.ts'
import {
  assertNotTerminal, assertOpenOrRecoverable, assertOwnerAuthority, assertStoredWorktreeRecord, countOpenSlots,
  createRecord, formatWorktreeId, generateWorktreeId, listRecords, locateRecord, pickWorktreeId, requireRecordLocation,
  toPublicRecord, updateExistingRecordAt, WORKTREE_ID_BYTES,
} from '../src/records.ts'
import type { StoredWorktreeRecord } from '../src/records.ts'
import type { WorktreeId, WorktreeOwner } from '../src/types.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function scratchRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A pid guaranteed to no longer exist: `spawnSync` blocks until the child exits. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '0'])
  if (result.pid === undefined) throw new Error('expected a spawned pid')
  return result.pid
}

const sessionOwner = (id: string): WorktreeOwner => ({ kind: 'session', sessionId: SessionId(id) })
const operatorOwner: WorktreeOwner = { kind: 'operator' }

function baseRecord(overrides: Partial<StoredWorktreeRecord> = {}): StoredWorktreeRecord {
  return {
    id: 'wt-00000000' as WorktreeId,
    repoRoot: '/repo',
    path: '/root/repo-key/wt-00000000',
    branch: 'dsh/worktree/wt-00000000',
    baseCommit: 'a'.repeat(40),
    owner: sessionOwner('s1'),
    label: 'do the thing',
    task: 'do the thing',
    state: 'open',
    createdAt: 1_000,
    workerSessionIds: [],
    ...overrides,
  }
}

describe('pickWorktreeId', () => {
  it('accepts the first candidate with no collision', async () => {
    const id = await pickWorktreeId(async () => false, () => Buffer.from('aabbccdd', 'hex'))
    expect(id).toBe('wt-aabbccdd')
  })

  it('regenerates on collision until a free id is found', async () => {
    const seen: string[] = []
    const candidates = [Buffer.from('11111111', 'hex'), Buffer.from('22222222', 'hex')]
    let call = 0
    const id = await pickWorktreeId(async (candidate) => {
      seen.push(candidate)
      return candidate === 'wt-11111111'
    }, () => candidates[call++] ?? candidates[candidates.length - 1]!)
    expect(id).toBe('wt-22222222')
    expect(seen).toEqual(['wt-11111111', 'wt-22222222'])
  })

  it('fails loud when every attempt collides', async () => {
    await expect(pickWorktreeId(async () => true, () => Buffer.alloc(WORKTREE_ID_BYTES)))
      .rejects.toThrow('subagent-worktree: could not generate a unique worktree id')
  })
})

describe('formatWorktreeId', () => {
  it('brands wt- plus lowercase hex', () => {
    expect(formatWorktreeId(Buffer.from('deadbeef', 'hex'))).toBe('wt-deadbeef')
  })
})

describe('generateWorktreeId + createRecord', () => {
  it('creates a fresh record and rejects a second create for the same id', async () => {
    const root = await scratchRoot('dsh-wt-records-')
    const layout = layoutFor(root, 'repo-key')
    const id = await generateWorktreeId(layout)
    const record = baseRecord({ id })
    const persisted = await createRecord(layout, record)
    expect(persisted).toEqual(record)
    await expect(createRecord(layout, record)).rejects.toThrow('already exists')
  })
})

describe('assertStoredWorktreeRecord', () => {
  const path = '/tmp/example.json'

  it('accepts a well-formed record, including nested owner, route, and verdict', () => {
    const record = baseRecord({
      workerRoute: { provider: 'p', model: 'm' },
      lastVerdict: {
        verdict: 'pass', summary: 's', checks: ['a'], findings: [],
        commit: 'b'.repeat(40), reviewerSessionId: SessionId('r'), reviewerRoute: { provider: 'p', model: 'm' }, at: 1,
      },
      mergedCommit: 'c'.repeat(40),
      reviewingPid: 123,
      reviewingStartedAt: 456,
    })
    expect(() => { assertStoredWorktreeRecord(record, path) }).not.toThrow()
  })

  it.each([
    ['not an object', 'nope'],
    ['missing id', { ...baseRecord(), id: undefined }],
    ['bad owner kind', { ...baseRecord(), owner: { kind: 'nobody' } }],
    ['session owner missing sessionId', { ...baseRecord(), owner: { kind: 'session' } }],
    ['bad state', { ...baseRecord(), state: 'exploding' }],
    ['non-array workerSessionIds', { ...baseRecord(), workerSessionIds: 'nope' }],
    ['workerSessionIds with a non-string entry', { ...baseRecord(), workerSessionIds: [1] }],
    ['malformed workerRoute', { ...baseRecord(), workerRoute: { provider: 'p' } }],
    ['malformed lastVerdict', { ...baseRecord(), lastVerdict: { verdict: 'pass' } }],
    ['non-string mergedCommit', { ...baseRecord(), mergedCommit: 1 }],
    ['non-number reviewingPid', { ...baseRecord(), reviewingPid: 'p' }],
    ['non-number reviewingStartedAt', { ...baseRecord(), reviewingStartedAt: 'p' }],
  ])('rejects %s', (_label, value) => {
    expect(() => { assertStoredWorktreeRecord(value, path) }).toThrow(`subagent-worktree: worktree record "${path}" is corrupt`)
  })
})

describe('load, update, and list records', () => {
  it('loads a record by searching every repository directory under root', async () => {
    const root = await scratchRoot('dsh-wt-locate-')
    // repo-a exists (another worktree lives there) but does not hold the id being searched for.
    await createRecord(layoutFor(root, 'repo-a'), baseRecord({ id: 'wt-99999999' as WorktreeId }))
    const layoutB = layoutFor(root, 'repo-b')
    const record = baseRecord({ id: 'wt-11111111' as WorktreeId })
    await createRecord(layoutB, record)
    expect(await locateRecord(root, 'wt-00000000' as WorktreeId)).toBeUndefined()
    const found = await requireRecordLocation(root, 'wt-11111111' as WorktreeId)
    expect(found.layout).toEqual(layoutB)
    expect(found.record).toEqual(record)
  })

  it('reports no record under a root that was never created', async () => {
    const root = join(await scratchRoot('dsh-wt-empty-'), 'never-created')
    expect(await locateRecord(root, 'wt-00000000' as WorktreeId)).toBeUndefined()
  })

  it('fails loud when requiring a location that does not exist', async () => {
    const root = await scratchRoot('dsh-wt-missing-')
    await expect(requireRecordLocation(root, 'wt-00000000' as WorktreeId)).rejects.toThrow('no worktree "wt-00000000"')
  })

  it('updates an existing record under its writer lock and fails loud once removed', async () => {
    const root = await scratchRoot('dsh-wt-update-')
    const layout = layoutFor(root, 'repo-key')
    const record = baseRecord()
    await createRecord(layout, record)
    const { path } = await requireRecordLocation(root, record.id)
    const updated = await updateExistingRecordAt(path, record.id, current => ({ ...current, state: 'discarded' }))
    expect(updated.state).toBe('discarded')
    await rm(path)
    await expect(updateExistingRecordAt(path, record.id, current => current))
      .rejects.toThrow(`no worktree "${record.id}"`)
  })

  it('lists records for one repository and reports [] with no records directory yet', async () => {
    const root = await scratchRoot('dsh-wt-list-')
    const layout = layoutFor(root, 'repo-key')
    expect(await listRecords(layout)).toEqual([])
    const a = baseRecord({ id: 'wt-aaaaaaaa' as WorktreeId, state: 'open' })
    const b = baseRecord({ id: 'wt-bbbbbbbb' as WorktreeId, state: 'merged' })
    await createRecord(layout, a)
    await createRecord(layout, b)
    // A non-record file beside the JSON records must not be read as one.
    await writeFile(join(layout.recordsDir, 'notes.txt'), 'ignore me')
    const records = await listRecords(layout)
    expect(records.map(r => r.id).sort()).toEqual(['wt-aaaaaaaa', 'wt-bbbbbbbb'])
  })

  it('counts open and reviewing slots but not merged or discarded ones', async () => {
    const root = await scratchRoot('dsh-wt-count-')
    const layout = layoutFor(root, 'repo-key')
    await createRecord(layout, baseRecord({ id: 'wt-11111111' as WorktreeId, state: 'open' }))
    await createRecord(layout, baseRecord({ id: 'wt-22222222' as WorktreeId, state: 'reviewing' }))
    await createRecord(layout, baseRecord({ id: 'wt-33333333' as WorktreeId, state: 'merged' }))
    await createRecord(layout, baseRecord({ id: 'wt-44444444' as WorktreeId, state: 'discarded' }))
    expect(await countOpenSlots(layout)).toBe(2)
  })

  it('propagates a non-ENOENT readdir failure instead of reporting an empty repository', async () => {
    const root = await scratchRoot('dsh-wt-eaccess-')
    const layout = layoutFor(root, 'repo-key')
    await mkdir(layout.recordsDir, { recursive: true })
    await writeFile(join(layout.recordsDir, 'not-a-directory'), '')
    const blockedLayout = layoutFor(join(layout.recordsDir, 'not-a-directory'), 'repo-key')
    await expect(listRecords(blockedLayout)).rejects.toThrow()
  })
})

describe('toPublicRecord', () => {
  it('strips the internal accept-bookkeeping fields', () => {
    const stored = baseRecord({ state: 'reviewing', reviewingPid: 123, reviewingStartedAt: 456 })
    const publicRecord = toPublicRecord(stored)
    expect(publicRecord).not.toHaveProperty('reviewingPid')
    expect(publicRecord).not.toHaveProperty('reviewingStartedAt')
    expect(publicRecord.id).toBe(stored.id)
  })
})

describe('assertOwnerAuthority', () => {
  const id = 'wt-00000000' as WorktreeId

  it('lets an operator request act on a session-owned record', () => {
    expect(() => { assertOwnerAuthority({ owner: sessionOwner('s1') }, operatorOwner, id) }).not.toThrow()
  })

  it('lets a session request act on its own record', () => {
    expect(() => { assertOwnerAuthority({ owner: sessionOwner('s1') }, sessionOwner('s1'), id) }).not.toThrow()
  })

  it('rejects a session request naming a different session', () => {
    expect(() => { assertOwnerAuthority({ owner: sessionOwner('s1') }, sessionOwner('s2'), id) })
      .toThrow('subagent-worktree: worktree wt-00000000 belongs to another session')
  })

  it('rejects a session request against an operator-owned record', () => {
    expect(() => { assertOwnerAuthority({ owner: operatorOwner }, sessionOwner('s1'), id) }).toThrow('belongs to another session')
  })
})

describe('assertNotTerminal', () => {
  const id = 'wt-00000000' as WorktreeId

  it.each(['open', 'reviewing'] as const)('allows %s', (state) => {
    expect(() => { assertNotTerminal({ state }, id) }).not.toThrow()
  })

  it.each(['merged', 'discarded'] as const)('rejects %s', (state) => {
    expect(() => { assertNotTerminal({ state }, id) }).toThrow(`subagent-worktree: worktree wt-00000000 is ${state}`)
  })
})

describe('assertOpenOrRecoverable', () => {
  const id = 'wt-00000000' as WorktreeId

  it('allows an open record', () => {
    expect(() => { assertOpenOrRecoverable(baseRecord({ state: 'open' }), id) }).not.toThrow()
  })

  it('allows a reviewing record whose accepting process has exited (stale recovery)', () => {
    const record = baseRecord({ state: 'reviewing', reviewingPid: deadPid(), reviewingStartedAt: 1 })
    expect(() => { assertOpenOrRecoverable(record, id) }).not.toThrow()
  })

  it('allows a reviewing record with no recorded pid (cannot confirm a live holder)', () => {
    const record = baseRecord({ state: 'reviewing' })
    expect(() => { assertOpenOrRecoverable(record, id) }).not.toThrow()
  })

  it('rejects a reviewing record whose accepting process is this live process', () => {
    const record = baseRecord({ state: 'reviewing', reviewingPid: process.pid, reviewingStartedAt: 1 })
    expect(() => { assertOpenOrRecoverable(record, id) }).toThrow('subagent-worktree: worktree wt-00000000 is already being accepted')
  })

  it.each(['merged', 'discarded'] as const)('rejects a terminal %s record', (state) => {
    expect(() => { assertOpenOrRecoverable(baseRecord({ state }), id) }).toThrow(`subagent-worktree: worktree wt-00000000 is ${state}`)
  })
})
