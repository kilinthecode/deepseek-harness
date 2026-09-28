import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { pathExists } from '../src/fs-util.ts'
import { GitRunner } from '../src/git.ts'
import type { GitCommandResult, GitRunOptions } from '../src/git.ts'
import { recoverLandedMerge, sweepWorktree } from '../src/landed.ts'
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

/** Real git with two scripted exceptions: the ancestry check can be cancelled, and reading merges can run a side effect. */
class ScriptedGit extends GitRunner {
  constructor(
    subprocessRuntime: ConstructorParameters<typeof GitRunner>[0],
    private readonly script: { readonly cancelAncestryCheck?: boolean; readonly beforeRevList?: () => void },
  ) {
    super(subprocessRuntime)
  }

  override async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    if (args[0] === 'merge-base' && this.script.cancelAncestryCheck === true) {
      return { exitCode: null, stdout: '', stderr: '', stdoutLossy: false }
    }
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
  makeStale: (commit: string) => Promise<StoredWorktreeRecord>
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
  const makeStale = (verdictCommit: string): Promise<StoredWorktreeRecord> => (
    updateExistingRecordAt(layout, provisioned.record.id, current => ({
      ...current,
      state: 'reviewing',
      reviewingPid: dead,
      lastVerdict: {
        verdict: 'pass', summary: 's', checks: [], findings: [], commit: verdictCommit,
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
    const command = new ScriptedGit(f.ctx.subprocess, { cancelAncestryCheck: true })

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
