import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  vi.unstubAllEnvs()
})

const signal = new AbortController().signal
const OWNER: WorktreeOwner = { kind: 'session', sessionId: SessionId('lead') }
const GIT_TEST_TIMEOUT_MS = 20_000

const KILLED: GitCommandResult = { exitCode: null, stdout: '', stderr: '', stdoutLossy: false }
const FAILED_128: GitCommandResult = { exitCode: 128, stdout: '', stderr: 'fatal: scripted failure\n', stdoutLossy: false }

/** The host-log sink of the recovery calls whose log output a test does not assert on. */
const ignoreLog = (): void => {}

/**
 * Real git with scripted exceptions: the ancestry check, the worktree's `HEAD` read, its status read, and the
 * landing-commit listing can each be replaced by a result, and reading merges can run a side effect.
 */
class ScriptedGit extends GitRunner {
  /** How many `git rev-list` commands ran, which is how a test sees the landing-commit read and its retry. */
  revListCalls = 0

  constructor(
    subprocessRuntime: ConstructorParameters<typeof GitRunner>[0],
    private readonly script: {
      readonly ancestryCheck?: GitCommandResult
      readonly headRead?: GitCommandResult
      readonly statusRead?: GitCommandResult
      readonly revList?: GitCommandResult
      readonly revListAt?: Readonly<Record<number, GitCommandResult>>
      readonly beforeRevList?: () => void
    },
  ) {
    super(subprocessRuntime)
  }

  override async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    if (args[0] === 'merge-base' && this.script.ancestryCheck !== undefined) return this.script.ancestryCheck
    if (args[0] === 'rev-parse' && args[1] === 'HEAD' && this.script.headRead !== undefined) return this.script.headRead
    if (args[0] === 'status' && this.script.statusRead !== undefined) return this.script.statusRead
    if (args[0] === 'rev-list') {
      this.revListCalls += 1
      const replaced = this.script.revListAt?.[this.revListCalls]
      if (replaced !== undefined) return replaced
      if (this.script.revList !== undefined) return this.script.revList
      this.script.beforeRevList?.()
    }
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
  it('throws when the ancestry check was cancelled, because it has no answer', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    const command = new ScriptedGit(f.ctx.subprocess, { ancestryCheck: KILLED })

    await expect(recoverLandedMerge(command, layout, stale, signal, ignoreLog))
      .rejects.toThrow(`could not check whether worktree ${f.record.id} already merged (git merge-base was cancelled)`)
  }, GIT_TEST_TIMEOUT_MS)

  it('throws when the ancestry check exited 128, which is not one of its answers, and leaves the record untouched', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    const command = new ScriptedGit(f.ctx.subprocess, { ancestryCheck: FAILED_128 })

    await expect(recoverLandedMerge(command, layout, stale, signal, ignoreLog))
      .rejects.toThrow(`could not check whether worktree ${f.record.id} already merged (git merge-base exited 128)`)

    // The record is exactly as it was: nothing was recorded, and no claim was taken on it, so a later accept or
    // discard sees the same unknown state and fails the same way instead of reading it as "not merged".
    expect((await requireRecordLocation(f.root, f.record.id)).record).toEqual(stale)
  }, GIT_TEST_TIMEOUT_MS)

  it('does not recover when the worktree is clean and the reviewed commit never landed', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)

    // The worktree's own `HEAD` is the reviewed commit, so an ancestry check run in the worktree directory would
    // always answer yes; only the base checkout's history can say whether the commit landed.
    expect(await recoverLandedMerge(f.runner, layout, stale, signal, ignoreLog)).toBeUndefined()

    const { record } = await requireRecordLocation(f.root, f.record.id)
    expect(record.state).toBe('reviewing')
    expect(await pathExists(f.record.path)).toBe(true)
    expect(git(f.dir, 'branch', '--list', f.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('throws, instead of reading "not merged" as an answer, when its reviewed commit no longer exists', async () => {
    const f = await fixture()
    const stale = await f.makeStale('f'.repeat(40))
    const { layout } = await requireRecordLocation(f.root, f.record.id)

    // git exits 128 for an unresolvable commit, which is neither "yes" nor "no": the state is unknown, so both a
    // later accept and a later discard fail loud rather than risk treating the worktree as never merged.
    await expect(recoverLandedMerge(f.runner, layout, stale, signal, ignoreLog))
      .rejects.toThrow(`could not check whether worktree ${f.record.id} already merged (git merge-base exited 128)`)
    expect((await requireRecordLocation(f.root, f.record.id)).record).toEqual(stale)
  }, GIT_TEST_TIMEOUT_MS)

  it('records the reviewed commit itself as the merge commit when it landed by fast-forward, so no merge commit lists it', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    // A user fast-forwards the base branch onto the worker's commit and goes on: an ancestor, but no merge commit.
    git(f.dir, 'merge', '--ff-only', f.record.branch)
    git(f.dir, 'commit', '--allow-empty', '-q', '-m', 'later work')

    const recovery = await recoverLandedMerge(f.runner, layout, stale, signal, ignoreLog)

    expect(recovery?.record).toMatchObject({ state: 'merged', mergedCommit: f.commit })
    expect(recovery?.mergeCommit).toBe(f.commit)
    expect(recovery?.record).not.toHaveProperty('reviewingPid')
    expect(recovery?.verdict.commit).toBe(f.commit)
    expect(git(f.dir, 'rev-parse', 'HEAD').trim()).not.toBe(f.commit)
  }, GIT_TEST_TIMEOUT_MS)

  it('finds the merge commit that brought the reviewed commit in', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    git(f.dir, 'merge', '--no-ff', '--no-edit', f.record.branch)
    const mergeCommit = git(f.dir, 'rev-parse', 'HEAD').trim()

    const recovery = await recoverLandedMerge(f.runner, layout, stale, signal, ignoreLog)

    expect(recovery?.record).toMatchObject({ state: 'merged', mergedCommit: mergeCommit })
    expect(recovery?.mergeCommit).toBe(mergeCommit)
  }, GIT_TEST_TIMEOUT_MS)

  it('names the earliest merge commit that lists the reviewed commit as a parent, not a later merge', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    git(f.dir, 'merge', '--no-ff', '--no-edit', f.record.branch)
    const mergeCommit = git(f.dir, 'rev-parse', 'HEAD').trim()
    // Unrelated work merges afterwards, so HEAD is a later merge commit that does not list the reviewed commit.
    git(f.dir, 'checkout', '-q', '-b', 'unrelated')
    await writeFile(join(f.dir, 'unrelated.txt'), 'x')
    git(f.dir, 'add', '-A')
    git(f.dir, 'commit', '-q', '-m', 'unrelated work')
    git(f.dir, 'checkout', '-q', 'main')
    git(f.dir, 'merge', '--no-ff', '--no-edit', 'unrelated')
    expect(git(f.dir, 'rev-parse', 'HEAD').trim()).not.toBe(mergeCommit)

    const recovery = await recoverLandedMerge(f.runner, layout, stale, signal, ignoreLog)

    expect(recovery?.record).toMatchObject({ state: 'merged', mergedCommit: mergeCommit })
  }, GIT_TEST_TIMEOUT_MS)

  it('names the earliest of several merge commits that list the reviewed commit as a parent', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    const base = git(f.dir, 'rev-parse', 'HEAD').trim()
    // The merge commits are dated apart, so "earliest" does not depend on how git orders commits with equal dates.
    vi.stubEnv('GIT_COMMITTER_DATE', '2020-01-01T00:00:00Z')
    git(f.dir, 'merge', '--no-ff', '--no-edit', f.record.branch)
    const earliest = git(f.dir, 'rev-parse', 'HEAD').trim()
    // The reviewed commit is merged a second time, into a branch that main then merges: a later merge that lists it too.
    git(f.dir, 'checkout', '-q', '-b', 'other', base)
    vi.stubEnv('GIT_COMMITTER_DATE', '2021-01-01T00:00:00Z')
    git(f.dir, 'merge', '--no-ff', '--no-edit', f.commit)
    git(f.dir, 'checkout', '-q', 'main')
    vi.stubEnv('GIT_COMMITTER_DATE', '2022-01-01T00:00:00Z')
    git(f.dir, 'merge', '--no-ff', '--no-edit', 'other')

    const recovery = await recoverLandedMerge(f.runner, layout, stale, signal, ignoreLog)

    expect(recovery?.record).toMatchObject({ state: 'merged', mergedCommit: earliest })
  }, GIT_TEST_TIMEOUT_MS)

  it('skips a merge that lists another commit built on the reviewed one, and records the reviewed commit', async () => {
    const f = await fixture()
    const stale = await f.makeStale(f.commit)
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    // The reviewed commit reached main through a branch built on top of it: the merge commit lists that branch's tip.
    git(f.dir, 'checkout', '-q', '-b', 'mid', f.commit)
    await writeFile(join(f.dir, 'mid.txt'), 'mid')
    git(f.dir, 'add', '-A')
    git(f.dir, 'commit', '-q', '-m', 'mid work')
    git(f.dir, 'checkout', '-q', 'main')
    git(f.dir, 'merge', '--no-ff', '--no-edit', 'mid')

    const recovery = await recoverLandedMerge(f.runner, layout, stale, signal, ignoreLog)

    expect(recovery?.record).toMatchObject({ state: 'merged', mergedCommit: f.commit })
  }, GIT_TEST_TIMEOUT_MS)

  it('records merged without a merge commit, and logs the read failure, when a truncated listing cannot name it', async () => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)
    const log = vi.fn<(message: string) => void>()
    // The listing came back truncated with no line that lists the reviewed commit: the cut may have dropped the merge
    // that landed it. The record is still closed as `merged`, because leaving it `reviewing` would fail every later
    // accept on a read that may never succeed, and the merge already happened.
    const command = new ScriptedGit(f.ctx.subprocess, {
      revList: {
        exitCode: 0,
        stdout: `${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)}\n${'d'.repeat(40)} ${'e'.repeat(40)} ${'f'.repeat(40)}\n`,
        stdoutLossy: true,
        stderr: '',
      },
    })

    const recovery = await recoverLandedMerge(command, f.layout, stale, signal, log)

    expect(recovery?.record).toMatchObject({ state: 'merged' })
    expect(recovery?.record).not.toHaveProperty('mergedCommit')
    expect(recovery?.mergeCommit).toBeUndefined()
    expect(recovery?.verdict.commit).toBe(f.commit)
    // The record is closed, so no later accept fails the same way, and the worktree's leftovers are still there for
    // discard to sweep.
    const { record } = await requireRecordLocation(f.root, f.record.id)
    expect(record).toMatchObject({ state: 'merged' })
    expect(record).not.toHaveProperty('reviewingPid')
    expect(await pathExists(f.record.path)).toBe(true)
    // The failure names the absolute path and the commit in the host log, where an operator can act on them.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`worktree ${f.record.id} already landed in "${f.record.repoRoot}" (commit ${f.commit})`),
    )
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('the commit that landed it could not be read'),
    )
  }, GIT_TEST_TIMEOUT_MS)

  /** The worktree's branch has landed by fast-forward, as after an accept whose merge landed and whose record write did not. */
  async function landedFixture(): Promise<Awaited<ReturnType<typeof fixture>> & { layout: WorktreeLayout }> {
    const f = await fixture()
    const { layout } = await requireRecordLocation(f.root, f.record.id)
    git(f.dir, 'merge', '--ff-only', f.record.branch)
    return { ...f, layout }
  }

  it('reads the landing commit again on a fresh signal when the first read failed, and records it', async () => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)
    const log = vi.fn<(message: string) => void>()
    // The caller's signal was cancelled during that one read, which says nothing about the merge that landed: the
    // commit id must not be lost for good, exactly as the live merge path reads it again.
    const command = new ScriptedGit(f.ctx.subprocess, { revListAt: { 1: KILLED } })

    const recovery = await recoverLandedMerge(command, f.layout, stale, signal, log)

    expect(command.revListCalls).toBe(2)
    expect(recovery?.mergeCommit).toBe(f.commit)
    expect(recovery?.record).toMatchObject({ state: 'merged', mergedCommit: f.commit })
    expect(log).not.toHaveBeenCalled()
  }, GIT_TEST_TIMEOUT_MS)

  it('records merged without a merge commit when the retried read fails too', async () => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)
    const log = vi.fn<(message: string) => void>()
    const command = new ScriptedGit(f.ctx.subprocess, { revList: FAILED_128 })

    const recovery = await recoverLandedMerge(command, f.layout, stale, signal, log)

    expect(command.revListCalls).toBe(2)
    expect(recovery?.record).toMatchObject({ state: 'merged' })
    expect(recovery?.record).not.toHaveProperty('mergedCommit')
    expect(recovery?.mergeCommit).toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(git(f.dir, 'branch', '--list', f.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('does not recover when the worktree holds a newer commit than the one that landed, and deletes nothing', async () => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)
    // The worker went on after the crashed accept and committed more, which nobody reviewed.
    await writeFile(join(f.record.path, 'newer.txt'), 'newer')
    git(f.record.path, 'add', '-A')
    git(f.record.path, 'commit', '-q', '-m', 'newer work')

    expect(await recoverLandedMerge(f.runner, f.layout, stale, signal, ignoreLog)).toBeUndefined()

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

    expect(await recoverLandedMerge(f.runner, f.layout, stale, signal, ignoreLog)).toBeUndefined()

    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
    expect(await pathExists(f.record.path)).toBe(true)
    expect(git(f.dir, 'branch', '--list', f.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('does not recover a failing verdict, even when its commit has landed', async () => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit, 'fail')

    expect(await recoverLandedMerge(f.runner, f.layout, stale, signal, ignoreLog)).toBeUndefined()
    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
  }, GIT_TEST_TIMEOUT_MS)

  it('does not recover when the worktree directory is gone', async () => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)
    await rm(f.record.path, { recursive: true, force: true })

    expect(await recoverLandedMerge(f.runner, f.layout, stale, signal, ignoreLog)).toBeUndefined()
    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
  }, GIT_TEST_TIMEOUT_MS)

  it.each([
    ['HEAD read', 'rev-parse', { headRead: FAILED_128 }],
    ['status read', 'status', { statusRead: FAILED_128 }],
  ])('throws when the worktree %s failed with an exit code outside its answers, so its state is unknown', async (_label, subcommand, script) => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)

    await expect(recoverLandedMerge(new ScriptedGit(f.ctx.subprocess, script), f.layout, stale, signal, ignoreLog))
      .rejects.toThrow(`could not check whether worktree ${f.record.id} already merged (git ${subcommand} exited 128)`)
    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
  }, GIT_TEST_TIMEOUT_MS)

  it('does not recover when the config would hide the worktree\'s untracked file from its status read', async () => {
    const f = await landedFixture()
    git(f.dir, 'config', 'status.showUntrackedFiles', 'no')
    const stale = await f.makeStale(f.commit)
    await writeFile(join(f.record.path, 'untracked.txt'), 'new')

    // The status read asks for untracked files explicitly, so the config cannot make unreviewed work look clean.
    expect(await recoverLandedMerge(f.runner, f.layout, stale, signal, ignoreLog)).toBeUndefined()
    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
    expect(await pathExists(f.record.path)).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('does not recover when the config would hide a submodule move in the worktree from its status read', async () => {
    const f = await fixture()
    const sub = join(f.record.path, 'sub')
    await mkdir(sub)
    git(sub, 'init', '-q', '-b', 'main')
    git(sub, 'config', 'user.name', 'Worktree Test')
    git(sub, 'config', 'user.email', 'worktree-test@example.com')
    git(sub, 'commit', '--allow-empty', '-q', '-m', 'one')
    await writeFile(join(f.record.path, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n')
    git(f.record.path, 'add', 'sub', '.gitmodules')
    git(f.record.path, 'commit', '-q', '-m', 'add the submodule')
    const reviewed = git(f.record.path, 'rev-parse', 'HEAD').trim()
    // The submodule's own HEAD moves past the commit the gitlink records, which is a base change the worktree does not
    // contain. The URL in the config makes the submodule active, so git reports that move at all, and the ignore
    // setting is what the status read has to overrule.
    git(sub, 'commit', '--allow-empty', '-q', '-m', 'two')
    git(f.dir, 'config', 'submodule.sub.url', './sub')
    git(f.dir, 'config', 'submodule.sub.ignore', 'all')
    git(f.dir, 'merge', '--ff-only', f.record.branch)
    const stale = await f.makeStale(reviewed)
    const { layout } = await requireRecordLocation(f.root, f.record.id)

    expect(await recoverLandedMerge(f.runner, layout, stale, signal, ignoreLog)).toBeUndefined()

    expect((await requireRecordLocation(f.root, f.record.id)).record.state).toBe('reviewing')
    expect(await pathExists(f.record.path)).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it.each([
    ['HEAD read', 'rev-parse', { headRead: KILLED }],
    ['status read', 'status', { statusRead: KILLED }],
  ])('throws when the worktree %s was cancelled, because it has no answer', async (_label, subcommand, script) => {
    const f = await landedFixture()
    const stale = await f.makeStale(f.commit)

    await expect(recoverLandedMerge(new ScriptedGit(f.ctx.subprocess, script), f.layout, stale, signal, ignoreLog))
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

    expect(await recoverLandedMerge(command, layout, stale, signal, ignoreLog)).toBeUndefined()
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

  it.each([
    ['exited 128', FAILED_128, 'exited 128'],
    ['was cancelled', KILLED, 'was cancelled'],
  ])('throws, and keeps the branch, when the branch probe %s instead of answering', async (_label, probe, described) => {
    const f = await fixture()
    const { record } = await requireRecordLocation(f.root, f.record.id)
    /** Real git, except the branch probe, whose only answers are 0 (the branch exists) and 1 (it is gone). */
    class UnansweredBranchProbeGit extends GitRunner {
      override async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
        if (args[0] === 'rev-parse' && args.includes('--verify')) return probe
        return super.run(args, options)
      }
    }

    // Reading a probe that never answered as "the branch is gone" would report a discard whose branch is still there
    // as a success, so the only safe outcome is to fail and let a second discard finish the sweep.
    await expect(sweepWorktree(new UnansweredBranchProbeGit(f.ctx.subprocess), record, () => signal))
      .rejects.toThrow(`could not check whether worktree ${record.id}'s branch still exists (git rev-parse ${described})`)

    expect(await pathExists(record.path)).toBe(false)
    expect(git(f.dir, 'branch', '--list', record.branch).trim()).not.toBe('')

    await sweepWorktree(f.runner, record, () => signal)
    expect(git(f.dir, 'branch', '--list', record.branch).trim()).toBe('')
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
