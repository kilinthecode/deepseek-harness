import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { layoutFor, recordPathFor, worktreeDirFor } from '../src/paths.ts'
import type { WorktreeLayout } from '../src/paths.ts'
import {
  assertOpen, assertOpenOrRecoverable, assertOwnerAuthority, assertStoredWorktreeRecord, countOpenSlots,
  createRecord, formatWorktreeId, generateWorktreeId, listRecords, locateRecord, pickWorktreeId, requireRecordLocation,
  toPublicRecord, updateExistingRecordAt, WORKTREE_ID_BYTES,
} from '../src/records.ts'
import type { StoredWorktreeRecord } from '../src/records.ts'
import type { WorktreeId, WorktreeOwner } from '../src/types.ts'
import { assertWorktreeId } from '../src/worktree-id.ts'

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

/** A shape-valid record with placeholder location fields, for tests that never touch the filesystem. */
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
    workerRoute: { provider: 'worker-provider', model: 'worker-model' },
    ...overrides,
  }
}

/** A record whose id, worktree path, and branch are consistent with `layout`, so it can be stored and loaded. */
function recordIn(layout: WorktreeLayout, id: string, overrides: Partial<StoredWorktreeRecord> = {}): StoredWorktreeRecord {
  assertWorktreeId(id)
  return baseRecord({ id, path: worktreeDirFor(layout, id), branch: `dsh/worktree/${id}`, ...overrides })
}

/** Write a record file directly, bypassing `createRecord`'s own checks, to simulate a corrupted or edited file. */
async function writeRecordFile(layout: WorktreeLayout, id: string, content: unknown): Promise<string> {
  await mkdir(layout.recordsDir, { recursive: true })
  const path = join(layout.recordsDir, `${id}.json`)
  await writeFile(path, JSON.stringify(content))
  return path
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
    const record = recordIn(layout, id)
    const persisted = await createRecord(layout, record)
    expect(persisted).toEqual(record)
    await expect(createRecord(layout, record)).rejects.toThrow('already exists')
  })

  it('refuses to persist a record that could not be loaded back, leaving no file behind', async () => {
    const root = await scratchRoot('dsh-wt-records-inconsistent-')
    const layout = layoutFor(root, 'repo-key')
    const misplaced = baseRecord({ id: 'wt-aaaaaaaa' as WorktreeId })
    await expect(createRecord(layout, misplaced)).rejects.toThrow('names worktree directory')
    expect(await listRecords(layout)).toEqual([])
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
    })
    expect(() => { assertStoredWorktreeRecord(record, path) }).not.toThrow()
  })

  it('accepts an operator-owned record', () => {
    const record = baseRecord({ owner: operatorOwner })
    expect(() => { assertStoredWorktreeRecord(record, path) }).not.toThrow()
  })

  it('accepts a workerRoute that carries a reasoningEffort', () => {
    const record = baseRecord({ workerRoute: { provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') } })
    expect(() => { assertStoredWorktreeRecord(record, path) }).not.toThrow()
  })

  it('ignores the reviewingStartedAt field an older build wrote', () => {
    expect(() => { assertStoredWorktreeRecord({ ...baseRecord(), reviewingStartedAt: 456 }, path) }).not.toThrow()
  })

  it.each([
    ['not an object', 'nope'],
    ['missing id', { ...baseRecord(), id: undefined }],
    ['owner is not an object', { ...baseRecord(), owner: 'nope' }],
    ['bad owner kind', { ...baseRecord(), owner: { kind: 'nobody' } }],
    ['session owner missing sessionId', { ...baseRecord(), owner: { kind: 'session' } }],
    ['bad state', { ...baseRecord(), state: 'exploding' }],
    ['non-array workerSessionIds', { ...baseRecord(), workerSessionIds: 'nope' }],
    ['workerSessionIds with a non-string entry', { ...baseRecord(), workerSessionIds: [1] }],
    ['workerRoute is not an object', { ...baseRecord(), workerRoute: 'nope' }],
    ['workerRoute missing provider', { ...baseRecord(), workerRoute: { model: 'm' } }],
    ['malformed workerRoute', { ...baseRecord(), workerRoute: { provider: 'p' } }],
    ['missing workerRoute', { ...baseRecord(), workerRoute: undefined }],
    ['malformed lastVerdict', { ...baseRecord(), lastVerdict: { verdict: 'pass' } }],
    ['non-string mergedCommit', { ...baseRecord(), mergedCommit: 1 }],
    ['non-number reviewingPid', { ...baseRecord(), reviewingPid: 'p' }],
  ])('rejects %s', (_label, value) => {
    expect(() => { assertStoredWorktreeRecord(value, path) }).toThrow(`subagent-worktree: worktree record "${path}" is corrupt`)
  })
})

describe('load, update, and list records', () => {
  it('loads a record by searching every repository directory under root', async () => {
    const root = await scratchRoot('dsh-wt-locate-')
    // repo-a exists (another worktree lives there) but does not hold the id being searched for.
    const layoutA = layoutFor(root, 'repo-a')
    await createRecord(layoutA, recordIn(layoutA, 'wt-99999999'))
    const layoutB = layoutFor(root, 'repo-b')
    const record = recordIn(layoutB, 'wt-11111111')
    await createRecord(layoutB, record)
    expect(await locateRecord(root, 'wt-00000000' as WorktreeId)).toBeUndefined()
    const found = await requireRecordLocation(root, 'wt-11111111' as WorktreeId)
    expect(found.layout).toEqual(layoutB)
    expect(found.path).toBe(recordPathFor(layoutB, 'wt-11111111'))
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
    const record = recordIn(layout, 'wt-00000000')
    await createRecord(layout, record)
    const updated = await updateExistingRecordAt(layout, record.id, current => ({ ...current, state: 'discarded' }))
    expect(updated.state).toBe('discarded')
    await rm(recordPathFor(layout, record.id))
    await expect(updateExistingRecordAt(layout, record.id, current => current))
      .rejects.toThrow(`no worktree "${record.id}"`)
  })

  it('does not write when the updater throws, so a rejected precondition leaves the record unchanged', async () => {
    const root = await scratchRoot('dsh-wt-update-throws-')
    const layout = layoutFor(root, 'repo-key')
    const record = recordIn(layout, 'wt-00000000')
    await createRecord(layout, record)
    await expect(updateExistingRecordAt(layout, record.id, () => { throw new Error('precondition failed') }))
      .rejects.toThrow('precondition failed')
    const found = await requireRecordLocation(root, record.id)
    expect(found.record).toEqual(record)
  })

  it('lists records for one repository and reports [] with no records directory yet', async () => {
    const root = await scratchRoot('dsh-wt-list-')
    const layout = layoutFor(root, 'repo-key')
    expect(await listRecords(layout)).toEqual([])
    const a = recordIn(layout, 'wt-aaaaaaaa', { state: 'open' })
    const b = recordIn(layout, 'wt-bbbbbbbb', { state: 'merged' })
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
    await createRecord(layout, recordIn(layout, 'wt-11111111', { state: 'open' }))
    await createRecord(layout, recordIn(layout, 'wt-22222222', { state: 'reviewing' }))
    await createRecord(layout, recordIn(layout, 'wt-33333333', { state: 'merged' }))
    await createRecord(layout, recordIn(layout, 'wt-44444444', { state: 'discarded' }))
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

  it('fails loud naming the record path when its JSON is malformed', async () => {
    const root = await scratchRoot('dsh-wt-corrupt-json-')
    const layout = layoutFor(root, 'repo-key')
    await mkdir(layout.recordsDir, { recursive: true })
    const path = recordPathFor(layout, 'wt-00000000')
    await writeFile(path, '{not valid json')
    await expect(requireRecordLocation(root, 'wt-00000000' as WorktreeId)).rejects.toThrow(`worktree record "${path}" is corrupt`)
  })

  it('propagates a non-ENOENT readdir failure when the root itself is not a directory', async () => {
    const parent = await scratchRoot('dsh-wt-locate-root-bad-')
    const notADir = join(parent, 'not-a-directory')
    await writeFile(notADir, '')
    await expect(locateRecord(notADir, 'wt-00000000' as WorktreeId)).rejects.toThrow()
  })
})

describe('id validation at the record boundary', () => {
  it('refuses to search for an id that is not a worktree id before touching the filesystem', async () => {
    const root = await scratchRoot('dsh-wt-locate-traversal-')
    await expect(locateRecord(root, '../x' as WorktreeId)).rejects.toThrow('"../x" is not a worktree id')
    await expect(locateRecord(root, 'wt-ABCDEF12' as WorktreeId)).rejects.toThrow('is not a worktree id')
  })

})

describe('scans skip what is not a record', () => {
  /** Collects scan warnings for one test. */
  function collectWarnings(): { warnings: string[]; warn: (message: string) => void } {
    const warnings: string[] = []
    return { warnings, warn: (message) => { warnings.push(message) } }
  }

  it('finds a record in a later repository directory past a stray file, warning once', async () => {
    const root = await scratchRoot('dsh-wt-locate-past-stray-')
    // Candidates are searched in name order, and ".DS_Store" sorts before "repo-b".
    await writeFile(join(root, '.DS_Store'), '')
    const layout = layoutFor(root, 'repo-b')
    const record = recordIn(layout, 'wt-11111111')
    await createRecord(layout, record)
    const { warnings, warn } = collectWarnings()

    const found = await requireRecordLocation(root, record.id, warn)

    expect(found.record).toEqual(record)
    expect(warnings).toEqual([expect.stringContaining(`"${join(root, '.DS_Store')}" while looking for worktree wt-11111111`)])
  })

  it('finds nothing, without failing, when the only candidate is a stray file', async () => {
    const root = await scratchRoot('dsh-wt-locate-only-stray-')
    // A "repoKey" that is a file: readdir(root) lists it, but reading through it as a directory to
    // reach records/<id>.json fails with ENOTDIR, not the absence ENOENT expects.
    await writeFile(join(root, 'not-a-directory'), '')
    const { warnings, warn } = collectWarnings()

    expect(await locateRecord(root, 'wt-00000000' as WorktreeId, warn)).toBeUndefined()

    expect(warnings).toEqual([expect.stringContaining(`"${join(root, 'not-a-directory')}"`)])
  })

  it('fails loud when the requested id has a record file that cannot be read, instead of skipping its repository', async () => {
    const root = await scratchRoot('dsh-wt-locate-own-file-')
    const layout = layoutFor(root, 'repo-key')
    // A directory where the record file belongs: the id's own file exists, so reading it fails with EISDIR, not ENOENT.
    await mkdir(recordPathFor(layout, 'wt-00000000'), { recursive: true })
    const { warnings, warn } = collectWarnings()

    await expect(locateRecord(root, 'wt-00000000' as WorktreeId, warn)).rejects.toThrow(/EISDIR/)

    expect(warnings).toEqual([])
  })

  it('lists the records past a .json file whose name is not a worktree id, warning for each such file', async () => {
    const root = await scratchRoot('dsh-wt-list-bad-name-')
    const layout = layoutFor(root, 'repo-key')
    await createRecord(layout, recordIn(layout, 'wt-aaaaaaaa'))
    const stray = await writeRecordFile(layout, 'not-an-id', recordIn(layout, 'wt-bbbbbbbb'))
    const uppercase = await writeRecordFile(layout, 'wt-ABCDEF12', recordIn(layout, 'wt-cccccccc'))
    const { warnings, warn } = collectWarnings()

    const records = await listRecords(layout, warn)

    expect(records.map(r => r.id)).toEqual(['wt-aaaaaaaa'])
    expect(warnings).toHaveLength(2)
    expect(warnings).toContainEqual(expect.stringContaining(`"${stray}"`))
    expect(warnings).toContainEqual(expect.stringContaining(`"${uppercase}"`))
  })

  it('counts slots past a stray file, passing the warning through', async () => {
    const root = await scratchRoot('dsh-wt-count-stray-')
    const layout = layoutFor(root, 'repo-key')
    await createRecord(layout, recordIn(layout, 'wt-aaaaaaaa', { state: 'open' }))
    const stray = await writeRecordFile(layout, 'notes', {})
    const { warnings, warn } = collectWarnings()

    expect(await countOpenSlots(layout, warn)).toBe(1)

    expect(warnings).toEqual([expect.stringContaining(`"${stray}"`)])
  })

  it('still fails loud on a corrupt record file named for a worktree id', async () => {
    const root = await scratchRoot('dsh-wt-list-corrupt-')
    const layout = layoutFor(root, 'repo-key')
    const path = await writeRecordFile(layout, 'wt-aaaaaaaa', 'not a record')

    await expect(listRecords(layout)).rejects.toThrow(`worktree record "${path}" is corrupt`)
  })
})

describe('loaded-record integrity', () => {
  const id = 'wt-aaaaaaaa'

  it.each([
    ['an id that names a different file', (layout: WorktreeLayout) => recordIn(layout, id, { id: 'wt-bbbbbbbb' as WorktreeId }), 'holds id "wt-bbbbbbbb", not "wt-aaaaaaaa"'],
    ['a worktree path outside the one its id maps to', (layout: WorktreeLayout) => recordIn(layout, id, { path: '/elsewhere/wt-aaaaaaaa' }), 'names worktree directory "/elsewhere/wt-aaaaaaaa"'],
    ['a worktree path in another worktree directory', (layout: WorktreeLayout) => recordIn(layout, id, { path: worktreeDirFor(layout, 'wt-bbbbbbbb') }), 'names worktree directory'],
    ['a branch that does not end with its id', (layout: WorktreeLayout) => recordIn(layout, id, { branch: 'main' }), 'names branch "main"'],
    ['an abbreviated baseCommit', (layout: WorktreeLayout) => recordIn(layout, id, { baseCommit: 'abc123' }), 'has baseCommit "abc123"'],
    ['an uppercase baseCommit', (layout: WorktreeLayout) => recordIn(layout, id, { baseCommit: 'A'.repeat(40) }), 'has baseCommit'],
    ['a baseCommit that is a ref name', (layout: WorktreeLayout) => recordIn(layout, id, { baseCommit: '--upload-pack=x' }), 'has baseCommit "--upload-pack=x"'],
    ['a baseCommit between the two hash lengths', (layout: WorktreeLayout) => recordIn(layout, id, { baseCommit: 'a'.repeat(50) }), 'has baseCommit'],
    ['a baseCommit one digit short of a SHA-256 id', (layout: WorktreeLayout) => recordIn(layout, id, { baseCommit: 'a'.repeat(63) }), 'has baseCommit'],
    ['a baseCommit one digit past a SHA-256 id', (layout: WorktreeLayout) => recordIn(layout, id, { baseCommit: 'a'.repeat(65) }), 'has baseCommit'],
    ['an uppercase 64-digit mergedCommit', (layout: WorktreeLayout) => recordIn(layout, id, { mergedCommit: 'A'.repeat(64) }), 'has mergedCommit'],
    ['an abbreviated mergedCommit', (layout: WorktreeLayout) => recordIn(layout, id, { mergedCommit: 'abc123' }), 'has mergedCommit "abc123"'],
    ['a verdict commit that is not a full commit id', (layout: WorktreeLayout) => recordIn(layout, id, {
      lastVerdict: {
        verdict: 'pass', summary: 's', checks: [], findings: [], commit: 'HEAD', reviewerSessionId: SessionId('r'), reviewerRoute: { provider: 'p', model: 'm' }, at: 1,
      },
    }), 'has a verdict commit "HEAD"'],
  ])('rejects a record with %s', async (_label, build, message) => {
    const root = await scratchRoot('dsh-wt-integrity-')
    const layout = layoutFor(root, 'repo-key')
    const path = await writeRecordFile(layout, id, build(layout))
    const before = await readFile(path, 'utf8')
    await expect(requireRecordLocation(root, id as WorktreeId)).rejects.toThrow(message)
    await expect(listRecords(layout)).rejects.toThrow(message)
    await expect(updateExistingRecordAt(layout, id as WorktreeId, current => current)).rejects.toThrow(message)
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('accepts a record whose base, merged, and verdict commits are 64-digit SHA-256 commit ids', async () => {
    const root = await scratchRoot('dsh-wt-integrity-sha256-')
    const layout = layoutFor(root, 'repo-key')
    const record = recordIn(layout, id, {
      baseCommit: 'd'.repeat(64),
      state: 'merged',
      mergedCommit: 'e'.repeat(64),
      lastVerdict: {
        verdict: 'pass', summary: 's', checks: [], findings: [], commit: 'f'.repeat(64), reviewerSessionId: SessionId('r'), reviewerRoute: { provider: 'p', model: 'm' }, at: 1,
      },
    })
    await createRecord(layout, record)
    expect((await requireRecordLocation(root, id as WorktreeId)).record).toEqual(record)
  })

  it('accepts a record whose merged and verdict commits are full lowercase commit ids', async () => {
    const root = await scratchRoot('dsh-wt-integrity-ok-')
    const layout = layoutFor(root, 'repo-key')
    const record = recordIn(layout, id, {
      state: 'merged',
      mergedCommit: 'c'.repeat(40),
      lastVerdict: {
        verdict: 'pass', summary: 's', checks: [], findings: [], commit: 'b'.repeat(40), reviewerSessionId: SessionId('r'), reviewerRoute: { provider: 'p', model: 'm' }, at: 1,
      },
    })
    await createRecord(layout, record)
    expect((await requireRecordLocation(root, id as WorktreeId)).record).toEqual(record)
  })
})

describe('toPublicRecord', () => {
  it('strips the internal accept-bookkeeping field', () => {
    const stored = baseRecord({ state: 'reviewing', reviewingPid: 123 })
    const publicRecord = toPublicRecord(stored)
    expect(publicRecord).not.toHaveProperty('reviewingPid')
    expect(publicRecord.id).toBe(stored.id)
  })

  it('strips the reviewingStartedAt field an older build stored', () => {
    const stored = { ...baseRecord({ state: 'reviewing', reviewingPid: 123 }), reviewingStartedAt: 456 }
    const publicRecord = toPublicRecord(stored)
    expect(publicRecord).not.toHaveProperty('reviewingStartedAt')
    expect(publicRecord).not.toHaveProperty('reviewingPid')
    expect(publicRecord.id).toBe(stored.id)
  })
})

describe('records an older build wrote', () => {
  const id = 'wt-aaaaaaaa'

  it('drops the reviewingStartedAt field when a record is read, and the next update removes it from the file', async () => {
    const root = await scratchRoot('dsh-wt-legacy-field-')
    const layout = layoutFor(root, 'repo-key')
    const path = await writeRecordFile(layout, id, { ...recordIn(layout, id, { state: 'reviewing', reviewingPid: 123 }), reviewingStartedAt: 456 })

    expect((await requireRecordLocation(root, id as WorktreeId)).record).not.toHaveProperty('reviewingStartedAt')
    expect((await listRecords(layout))[0]).not.toHaveProperty('reviewingStartedAt')
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('reviewingStartedAt', 456)

    const updated = await updateExistingRecordAt(layout, id as WorktreeId, current => ({ ...current, label: 'renamed' }))

    expect(updated).not.toHaveProperty('reviewingStartedAt')
    const persisted: unknown = JSON.parse(await readFile(path, 'utf8'))
    expect(persisted).not.toHaveProperty('reviewingStartedAt')
    expect(persisted).toMatchObject({ label: 'renamed', reviewingPid: 123 })
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

describe('assertOpen', () => {
  const id = 'wt-00000000' as WorktreeId

  it('allows only an open record', () => {
    expect(() => { assertOpen({ state: 'open' }, id) }).not.toThrow()
  })

  it.each(['reviewing', 'merged', 'discarded'] as const)('rejects %s', (state) => {
    expect(() => { assertOpen({ state }, id) }).toThrow(`subagent-worktree: worktree wt-00000000 is ${state}`)
  })
})

describe('assertOpenOrRecoverable', () => {
  const id = 'wt-00000000' as WorktreeId

  it('allows an open record', () => {
    expect(() => { assertOpenOrRecoverable(baseRecord({ state: 'open' }), id) }).not.toThrow()
  })

  it('allows a reviewing record whose accepting process has exited (stale recovery)', () => {
    const record = baseRecord({ state: 'reviewing', reviewingPid: deadPid() })
    expect(() => { assertOpenOrRecoverable(record, id) }).not.toThrow()
  })

  it('allows a reviewing record with no recorded pid (cannot confirm a live holder)', () => {
    const record = baseRecord({ state: 'reviewing' })
    expect(() => { assertOpenOrRecoverable(record, id) }).not.toThrow()
  })

  it('rejects a reviewing record whose accepting process is this live process', () => {
    const record = baseRecord({ state: 'reviewing', reviewingPid: process.pid })
    expect(() => { assertOpenOrRecoverable(record, id) }).toThrow('subagent-worktree: worktree wt-00000000 is already being accepted')
  })

  it.each(['merged', 'discarded'] as const)('rejects a terminal %s record', (state) => {
    expect(() => { assertOpenOrRecoverable(baseRecord({ state }), id) }).toThrow(`subagent-worktree: worktree wt-00000000 is ${state}`)
  })
})
