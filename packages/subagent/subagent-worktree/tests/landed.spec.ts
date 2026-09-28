import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { pathExists } from '../src/fs-util.ts'
import { GitRunner } from '../src/git.ts'
import type { GitCommandResult, GitRunOptions } from '../src/git.ts'
import { recoverLandedMerge, sweepWorktree } from '../src/landed.ts'
import type { WorktreeLayout } from '../src/paths.ts'
import { requireRecordLocation, updateExistingRecordAt } from '../src/records.ts'
import type { StoredWorktreeRecord } from '../src/records.ts'
import type { WorktreeOwner } from '../src/types.ts'
import { createWorktree, git, initFixtureRepo, removeFixture, setup } from './harness.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const signal = new AbortController().signal
const OWNER: WorktreeOwner = { kind: 'session', sessionId: SessionId('lead') }
const GIT_TEST_TIMEOUT_MS = 20_000

const KILLED: GitCommandResult = { exitCode: null, stdout: '', stderr: '', stdoutLossy: false }
const FAILED_128: GitCommandResult = { exitCode: 128, stdout: '', stderr: 'fatal: scripted failure\n', stdoutLossy: false }

/**
 * Real git with scripted exceptions: the ancestry check, the worktree's `HEAD` read, and its status read can each
 * be replaced by a result, and reading merges can run a side effect.
 */
class ScriptedGit extends GitRunner {
  constructor(
    subprocessRuntime: ConstructorParameters<typeof GitRunner>[0],
    private readonly script: {
      readonly ancestryCheck?: GitCommandResult
      readonly headRead?: GitCommandResult
      readonly statusRead?: GitCommandResult
      readonly beforeRevList?: () => void
    },
  ) {
    super(subprocessRuntime)
  }

  override async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    if (args[0] === 'merge-base' && this.script.ancestryCheck !== undefined) return this.script.ancestryCheck
    if (args[0] === 'rev-parse' && args[1] === 'HEAD' && this.script.headRead !== undefined) return this.script.headRead
    if (args[0] === 'status' && this.script.statusRead !== undefined) return this.script.statusRead
    if (args[0] === 'rev-list') this.script.beforeRevList?.()
    return super.run(args, options)
  }
}

/** A worktree whose branch has one commit of its own, on a service with a real subprocess. */
async function fixture(): Promise<{
  ctx: Context
  dir: string
  root: string
  record: StoredWorktreeRecord
  commit: string
  runner: GitRunner
  makeStale: (commit: string, verdict?: 'pass' | 'fail') => Promise<StoredWorktreeRecord>
}> {
  const dir = await initFixtureRepo('dsh-landed-')
  cleanups.push(() => removeFixture(dir))
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
  const root = await mkdtemp(join(tmpdir(), 'dsh-landed-root-'))
  cleanups.push(() => removeFixture(root))
  const { ctx, dispose } = await setup({ root })
  cleanups.push(dispose)
  const provisioned = await createWorktree(ctx, OWNER, dir, 'x')
  await writeFile(join(provisioned.workDir, 'a.txt'), 'a')
  git(provisioned.record.path, 'add', '-A')
  git(provisioned.record.path, 'commit', '-q', '-m', 'work')
  const commit = git(provisioned.record.path, 'rev-parse', 'HEAD').trim()
  const dead = spawnSync(process.execPath, ['-e', '0']).pid
  if (dead === undefined) throw new Error('expected a spawned pid')
  const { layout } = await requireRecordLocation(root, provisioned.record.id)
  const makeStale = (verdictCommit: string, verdict: 'pass' | 'fail' = 'pass'): Promise<StoredWorktreeRecord> => (
    updateExistingRecordAt(layout, provisioned.record.id, current => ({
      ...current,
      state: 'reviewing',
      reviewingPid: dead,
      lastVerdict: {
        verdict, summary: 's', checks: [], findings: [], commit: verdictCommit,
        reviewerSessionId: SessionId('reviewer'), reviewerRoute: { provider: 'p', model: 'm' }, at: 1,
      },
    }))
  )
  return { ctx, dir, root, record: provisioned.record, commit, runner: new GitRunner(ctx.subprocess), makeStale }
}

describe('recoverLandedMerge', () => {
  it('leaves a stale record alone when its reviewed commit no longer exists (it cannot have landed)', async () => {
    const f = await fixture()
    const stale = await f.makeStale('f'.repeat(40))
    const { layout } = await requireRecordLocation(f.root, f.record.id)

    expect(await recoverLandedMerge(f.runner, layout, stale, signal)).toBeUndefined()
    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
  }, GIT_TEST_TIMEOUT_MS)

  it('throws when the ancestry check was cancelled, because it has no answer', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    const command = new ScriptedGit(f.ctx.subprocess, { ancestryCheck: KILLED })

    await expect(recoverLandedMerge(command, layout, stale, signal))
      .rejects.toThrow(`could not check whether worktree ${f.record.id} already merged (git merge-base was cancelled)`)
  }, GIT_TEST_TIMEOUT_MS)

  it('records merged without a merge commit when the reviewed commit landed by fast-forward', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    // A user fast-forwards the base branch onto the worker's commit: an ancestor, but no merge commit.
    git(f.dir, 'merge', '--ff-only', f.record.branch)

    const recovery = await recoverLandedMerge(f.runner, layout, stale, signal)

    expect(recovery?.record.state).toBe('merged')
    expect(recovery?.record.mergedCommit).toBeUndefined()
    expect(recovery?.record).not.toHaveProperty('reviewingPid')
    expect(recovery?.verdict.commit).toBe(f.commit)
  }, GIT_TEST_TIMEOUT_MS)

  it('finds the merge commit that brought the reviewed commit in', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    git(f.dir, 'merge', '--no-ff', '--no-edit', f.record.branch)
    const mergeCommit = git(f.dir, 'rev-parse', 'HEAD').trim()

    const recovery = await recoverLandedMerge(f.runner, layout, stale, signal)

    expect(recovery?.record).toMatchObject({ state: 'merged', mergedCommit: mergeCommit })
  }, GIT_TEST_TIMEOUT_MS)

  /** The worktree's branch has landed by fast-forward, as after an accept whose merge landed and whose record write did not. */
  async function landedFixture(): Promise<Awaited<ReturnType<typeof fixture>> & { layout: WorktreeLayout }> {
    const f = await fixture()
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    git(f.dir, 'merge', '--ff-only', f.record.branch)
    return { ...f, layout }
  }

  it('does not recover when the worktree holds a newer commit than the one that landed, and deletes nothing', async () => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)
    // The worker went on after the crashed accept and committed more, which nobody reviewed.
    await writeFile(join(f.record.path, 'newer.txt'), 'newer')
    git(f.record.path, 'add', '-A')
    git(f.record.path, 'commit', '-q', '-m', 'newer work')

    expect(await recoverLandedMerge(f.runner, f.layout, stale, signal)).toBeUndefined()

    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
    expect(await pathExists(f.record.path)).toBe(true)
    expect(git(f.dir, 'branch', '--list', f.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it.each([
    ['a modified tracked file', async (path: string) => { await writeFile(join(path, 'a.txt'), 'changed') }],
    ['an untracked file', async (path: string) => { await writeFile(join(path, 'untracked.txt'), 'new') }],
    ['a staged new file', async (path: string) => {
      await writeFile(join(path, 'staged.txt'), 'new')
      git(path, 'add', 'staged.txt')
    }],
  ])('does not recover when the worktree holds %s that nobody reviewed, and deletes nothing', async (_label, dirty) => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)
    await dirty(f.record.path)

    expect(await recoverLandedMerge(f.runner, f.layout, stale, signal)).toBeUndefined()

    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
    expect(await pathExists(f.record.path)).toBe(true)
    expect(git(f.dir, 'branch', '--list', f.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('does not recover a failing verdict, even when its commit has landed', async () => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit, 'fail')

    expect(await recoverLandedMerge(f.runner, f.layout, stale, signal)).toBeUndefined()
    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
  }, GIT_TEST_TIMEOUT_MS)

  it('does not recover when the worktree directory is gone', async () => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)
    await rm(f.record.path, { recursive: true, force: true })

    expect(await recoverLandedMerge(f.runner, f.layout, stale, signal)).toBeUndefined()
    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
  }, GIT_TEST_TIMEOUT_MS)

  it.each([
    ['its HEAD cannot be read', { headRead: FAILED_128 }],
    ['its status cannot be read', { statusRead: FAILED_128 }],
  ])('does not recover when the worktree\'s state is unknown because %s', async (_label, script) => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)

    expect(await recoverLandedMerge(new ScriptedGit(f.ctx.subprocess, script), f.layout, stale, signal)).toBeUndefined()
    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
  }, GIT_TEST_TIMEOUT_MS)

  it.each([
    ['HEAD read', 'rev-parse', { headRead: KILLED }],
    ['status read', 'status', { statusRead: KILLED }],
  ])('throws when the worktree %s was cancelled, because it has no answer', async (_label, subcommand, script) => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)

    await expect(recoverLandedMerge(new ScriptedGit(f.ctx.subprocess, script), f.layout, stale, signal))
      .rejects.toThrow(`could not check whether worktree ${f.record.id} already merged (git ${subcommand} was cancelled)`)
  }, GIT_TEST_TIMEOUT_MS)

  it('does not record merged when the record stopped being stale while the merge commit was looked up', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout, path } = await requireRecordLocation(f.root, f.record.id)
    git(f.dir, 'merge', '--no-ff', '--no-edit', f.record.branch)
    // Between the ancestry check and the write, another operation reopens the record.
    const command = new ScriptedGit(f.ctx.subprocess, {
      beforeRevList: () => {
        const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        writeFileSync(path, JSON.stringify({ ...stored, state: 'open', reviewingPid: undefined }))
      },
    })

    expect(await recoverLandedMerge(command, layout, stale, signal)).toBeUndefined()
    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('open')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('sweepWorktree', () => {
  it('removes the worktree directory and its branch, and can run again when nothing is left', async () => {
    const f = await fixture()
    const { record } = await requireRecordLocation(f.root, f.record.id)

    await sweepWorktree(f.runner, record, () => signal)
    expect(await pathExists(record.path)).toBe(false)
    expect(git(f.dir, 'branch', '--list', record.branch).trim()).toBe('')

    await sweepWorktree(f.runner, record, () => signal)
    expect(await pathExists(record.path)).toBe(false)
  }, GIT_TEST_TIMEOUT_MS)

  it('asks for a separate signal for each git command it runs, in the order the commands run', async () => {
    const f = await fixture()
    const { record } = await requireRecordLocation(f.root, f.record.id)
    const started: Array<{ args: readonly string[]; signal: AbortSignal | undefined }> = []
    class RecordingGit extends GitRunner {
      override run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
        started.push({ args, signal: options.signal })
        return super.run(args, options)
      }
    }
    const issued: AbortSignal[] = []
    const signalFor = (): AbortSignal => {
      const issuedSignal = new AbortController().signal
      issued.push(issuedSignal)
      return issuedSignal
    }

    await sweepWorktree(new RecordingGit(f.ctx.subprocess), record, signalFor)

    expect(started.map(command => command.args[0])).toEqual(['worktree', 'worktree', 'rev-parse', 'branch'])
    expect(issued).toHaveLength(4)
    started.forEach((command, index) => { expect(command.signal).toBe(issued[index]) })
  }, GIT_TEST_TIMEOUT_MS)
})
