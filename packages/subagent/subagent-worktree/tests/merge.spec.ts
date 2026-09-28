import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitRunner } from '../src/git.ts'
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
