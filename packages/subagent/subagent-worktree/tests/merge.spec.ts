import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitRunner } from '../src/git.ts'
import type { GitCommandResult, GitRunOptions } from '../src/git.ts'
import { attemptMerge } from '../src/merge.ts'
import { git, initFixtureRepo, removeFixture } from './harness.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function runner(): Promise<GitRunner> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return new GitRunner(ctx.subprocess)
}

const signal = new AbortController().signal

// Each case runs several real git subprocesses; generous under concurrent CI load.
const GIT_TEST_TIMEOUT_MS = 20_000

describe('attemptMerge', () => {
  it('merges a clean branch with --no-ff, producing a real merge commit', async () => {
    const dir = await initFixtureRepo('dsh-merge-ok-')
    cleanups.push(() => removeFixture(dir))
    await writeFile(join(dir, 'base.txt'), 'base\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')
    git(dir, 'checkout', '-q', '-b', 'side')
    await writeFile(join(dir, 'side.txt'), 'side\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'side change')
    const sideCommit = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', 'main')

    const result = await attemptMerge(await runner(), dir, 'wt-00000001', 'do the thing', sideCommit, signal)
    expect(result.kind).toBe('merged')
    if (result.kind !== 'merged') throw new Error('unreachable')
    expect(result.mergeCommit).toBe(git(dir, 'rev-parse', 'HEAD').trim())
    // --no-ff always creates a merge commit, never a fast-forward.
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
    expect(git(dir, 'log', '-1', '--pretty=%s').trim()).toBe('Merge worktree wt-00000001: do the thing')
  }, GIT_TEST_TIMEOUT_MS)

  it('aborts and keeps the branch on a real conflict', async () => {
    const dir = await initFixtureRepo('dsh-merge-conflict-')
    cleanups.push(() => removeFixture(dir))
    await writeFile(join(dir, 'shared.txt'), 'base\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')
    git(dir, 'checkout', '-q', '-b', 'side')
    await writeFile(join(dir, 'shared.txt'), 'side\n')
    git(dir, 'commit', '-q', '-am', 'side change')
    const sideCommit = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', 'main')
    await writeFile(join(dir, 'shared.txt'), 'main\n')
    git(dir, 'commit', '-q', '-am', 'main change')
    const baseHead = git(dir, 'rev-parse', 'HEAD').trim()

    const result = await attemptMerge(await runner(), dir, 'wt-00000002', 'do the thing', sideCommit, signal)
    expect(result).toEqual({ kind: 'conflict', files: ['shared.txt'] })
    // The abort restored a clean tree at the pre-merge HEAD; the side branch's commit is untouched.
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
    expect(git(dir, 'cat-file', '-e', sideCommit).trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('reports blocked, without starting a merge, when an uncommitted local change would be overwritten', async () => {
    const dir = await initFixtureRepo('dsh-merge-blocked-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const baseHead = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', '-b', 'side')
    await writeFile(join(dir, 'shared.txt'), 'from side\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'side adds shared.txt')
    const sideCommit = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', 'main')
    // An untracked file at the same path the merge would create: git refuses before merging.
    await writeFile(join(dir, 'shared.txt'), 'uncommitted local content\n')

    const result = await attemptMerge(await runner(), dir, 'wt-00000003', 'do the thing', sideCommit, signal)
    expect(result.kind).toBe('blocked')
    if (result.kind !== 'blocked') throw new Error('unreachable')
    expect(result.reason.length).toBeGreaterThan(0)
    // Nothing was merged or aborted: HEAD is untouched and the local file survives as written.
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
    expect(await readFile(join(dir, 'shared.txt'), 'utf8')).toBe('uncommitted local content\n')
  }, GIT_TEST_TIMEOUT_MS)
})

/** A repository on `main` with a clean, mergeable `side` branch one commit ahead. */
async function repoWithSideBranch(prefix: string): Promise<{ dir: string; sideCommit: string; baseHead: string }> {
  const dir = await initFixtureRepo(prefix)
  cleanups.push(() => removeFixture(dir))
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
  const baseHead = git(dir, 'rev-parse', 'HEAD').trim()
  git(dir, 'checkout', '-q', '-b', 'side')
  await writeFile(join(dir, 'side.txt'), 'side\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'side change')
  const sideCommit = git(dir, 'rev-parse', 'HEAD').trim()
  git(dir, 'checkout', '-q', 'main')
  return { dir, sideCommit, baseHead }
}

/** Runs real git except `git merge`, which is replaced by `result` after optionally running `alongside` for real. */
class ScriptedMergeGit extends GitRunner {
  readonly commands: string[][] = []

  constructor(
    subprocess: ConstructorParameters<typeof GitRunner>[0],
    private readonly script: { readonly alongside?: readonly string[]; readonly result: GitCommandResult },
  ) {
    super(subprocess)
  }

  override async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    this.commands.push([...args])
    if (args[0] === 'merge' && args[1] !== '--abort') {
      if (this.script.alongside !== undefined) await super.run(this.script.alongside, options)
      return this.script.result
    }
    return super.run(args, options)
  }
}

async function scriptedRunner(script: ConstructorParameters<typeof ScriptedMergeGit>[1]): Promise<ScriptedMergeGit> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return new ScriptedMergeGit(ctx.subprocess, script)
}

const KILLED: GitCommandResult = { exitCode: null, stdout: '', stderr: '', stdoutLossy: false }

describe('attemptMerge: refusing to start', () => {
  it('reports blocked, and leaves a merge the user already has in progress exactly as it was', async () => {
    const dir = await initFixtureRepo('dsh-merge-in-progress-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    git(dir, 'checkout', '-q', '-b', 'side')
    await writeFile(join(dir, 'f.txt'), 'side\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'side')
    const sideCommit = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', 'main')
    await writeFile(join(dir, 'f.txt'), 'main\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'main')
    try {
      git(dir, 'merge', 'side')
    } catch {
      // A conflicting merge exits nonzero by design; the half-finished merge it leaves is what this test needs.
    }
    const mergeHead = git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()
    const conflicted = await readFile(join(dir, 'f.txt'), 'utf8')
    const command = await runner()

    const result = await attemptMerge(command, dir, 'wt-00000004', 'do the thing', sideCommit, signal)

    expect(result).toEqual({ kind: 'blocked', reason: 'the base checkout already has a merge in progress (MERGE_HEAD exists)' })
    expect(git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).toBe(mergeHead)
    expect(await readFile(join(dir, 'f.txt'), 'utf8')).toBe(conflicted)
    expect(git(dir, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('f.txt')
  }, GIT_TEST_TIMEOUT_MS)

  it('reports blocked, and merges nothing, when HEAD is detached', async () => {
    const { dir, sideCommit, baseHead } = await repoWithSideBranch('dsh-merge-detached-')
    git(dir, 'checkout', '-q', '--detach')

    const result = await attemptMerge(await runner(), dir, 'wt-00000005', 'do the thing', sideCommit, signal)

    expect(result).toEqual({ kind: 'blocked', reason: 'the base checkout HEAD is detached; a merge there would update no branch' })
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('0')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('attemptMerge: a merge that dies or fails after starting', () => {
  it('throws for a killed merge that left nothing behind, without aborting anything', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-killed-clean-')
    const command = await scriptedRunner({ result: KILLED })

    await expect(attemptMerge(command, dir, 'wt-00000006', 'do the thing', sideCommit, signal))
      .rejects.toThrow('merge of worktree wt-00000006 was killed before it finished')
    expect(command.commands).not.toContainEqual(['merge', '--abort'])
  }, GIT_TEST_TIMEOUT_MS)

  it('aborts the MERGE_HEAD a killed merge left behind, then throws', async () => {
    const { dir, sideCommit, baseHead } = await repoWithSideBranch('dsh-merge-killed-leftover-')
    const command = await scriptedRunner({ alongside: ['merge', '--no-ff', '--no-commit', sideCommit], result: KILLED })

    await expect(attemptMerge(command, dir, 'wt-00000007', 'do the thing', sideCommit, signal))
      .rejects.toThrow('was killed before it finished')

    expect(command.commands).toContainEqual(['merge', '--abort'])
    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('aborts a merge that failed fatally after starting, then throws with git\'s message', async () => {
    const { dir, sideCommit, baseHead } = await repoWithSideBranch('dsh-merge-fatal-')
    const command = await scriptedRunner({
      alongside: ['merge', '--no-ff', '--no-commit', sideCommit],
      result: { exitCode: 128, stdout: '', stderr: 'fatal: something went wrong mid-merge\n', stdoutLossy: false },
    })

    await expect(attemptMerge(command, dir, 'wt-00000008', 'do the thing', sideCommit, signal))
      .rejects.toThrow('merge of worktree wt-00000008 failed unexpectedly after starting: fatal: something went wrong mid-merge')

    expect(command.commands).toContainEqual(['merge', '--abort'])
    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('reports blocked, not an error, for a refusal that started no merge', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-refused-')
    const command = await scriptedRunner({
      result: { exitCode: 1, stdout: '', stderr: 'error: Your local changes would be overwritten by merge.\n', stdoutLossy: false },
    })

    const result = await attemptMerge(command, dir, 'wt-00000009', 'do the thing', sideCommit, signal)

    expect(result).toEqual({ kind: 'blocked', reason: 'error: Your local changes would be overwritten by merge.' })
    expect(command.commands).not.toContainEqual(['merge', '--abort'])
  }, GIT_TEST_TIMEOUT_MS)
})
