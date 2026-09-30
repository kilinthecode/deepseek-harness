import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitRunner } from '../src/git.ts'
import type { WorktreeId } from '../src/types.ts'
import { worktreeGitDirFor, worktreeGitDirOf } from '../src/worktree-gitdir.ts'
import { git, initFixtureRepo, plantHooks, removeFixture, replaceGitEntryWithFsmonitorRepo } from './harness.ts'

const GIT_TEST_TIMEOUT_MS = 20_000
const HOOKS = ['post-commit', 'post-index-change', 'reference-transaction'] as const
const signal = new AbortController().signal

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

interface Linked {
  /** The base checkout. */
  readonly base: string
  /** A scratch directory holding the worktrees and the markers a planted command creates. */
  readonly scratch: string
  /** The worktree directory and administrative directory of each requested name. */
  readonly worktrees: ReadonlyMap<string, { readonly path: string; readonly gitDir: string }>
}

/** A repository with one commit and one linked worktree per name, the way the service creates them. */
async function linkedWorktrees(...names: string[]): Promise<Linked> {
  const base = await initFixtureRepo('dsh-confine-base-')
  cleanups.push(() => removeFixture(base))
  git(base, 'commit', '--allow-empty', '-q', '-m', 'base')
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-confine-scratch-'))
  cleanups.push(() => removeFixture(scratch))
  const worktrees = new Map<string, { path: string; gitDir: string }>()
  for (const name of names) {
    const path = join(scratch, name)
    git(base, 'worktree', 'add', '-q', '-b', `branch-${name}`, path)
    worktrees.set(name, { path, gitDir: git(path, 'rev-parse', '--absolute-git-dir').trim() })
  }
  return { base, scratch, worktrees }
}

/** The named worktree of a fixture. */
function worktreeOf(linked: Linked, name: string): { path: string; gitDir: string } {
  const worktree = linked.worktrees.get(name)
  if (worktree === undefined) throw new Error(`fixture has no worktree ${name}`)
  return worktree
}

/** Which planted hooks ran, read from the markers they left in the scratch directory. */
function hooksRun(scratch: string, name: string): string[] {
  return readdirSync(scratch).filter(entry => entry.startsWith(`ran-${name}-`)).map(entry => entry.slice(`ran-${name}-`.length)).sort()
}

describe('GitRunner with a confined worktree', () => {
  it('runs against the given administrative directory instead of the worktree\'s own git entry', async () => {
    const linked = await linkedWorktrees('wt')
    const { path, gitDir } = worktreeOf(linked, 'wt')
    const marker = join(linked.scratch, 'fsmonitor-ran')
    await replaceGitEntryWithFsmonitorRepo(path, marker)
    await writeFile(join(path, 'file.txt'), 'x')
    const command = await runner()

    // The control: git trusts the rewritten entry and runs the command its repository configures.
    await command.expect(['add', '-A'], 'git add', { cwd: path, signal })
    expect(existsSync(marker)).toBe(true)
    await rm(marker)

    const confined = await command.expect(['add', '-A'], 'git add', { cwd: path, signal, worktreeGitDir: gitDir })
    expect(confined.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(false)
    // The confined command changed the worktree's real index, the one the service later commits from.
    expect(git(linked.base, '--git-dir', gitDir, 'ls-files', '--cached').trim()).toBe('file.txt')
  }, GIT_TEST_TIMEOUT_MS)

  it('runs no hook that a relative core.hooksPath resolves inside the worktree, though the commit skips verification', async () => {
    const linked = await linkedWorktrees('trusting', 'confined')
    git(linked.base, 'config', 'core.hooksPath', '.githooks')
    const command = await runner()
    const commit = async (name: string, worktreeGitDir?: string): Promise<void> => {
      const { path } = worktreeOf(linked, name)
      await plantHooks(join(path, '.githooks'), HOOKS, join(linked.scratch, `ran-${name}`))
      await writeFile(join(path, 'file.txt'), name)
      const options = { cwd: path, signal, worktreeGitDir }
      await command.expect(['add', '-A'], 'git add', options)
      await command.expect(['commit', '--no-verify', '-q', '-m', 'work'], 'git commit', options)
    }

    // The control: `--no-verify` skips only pre-commit and commit-msg, so the planted hooks all run.
    await commit('trusting')
    expect(hooksRun(linked.scratch, 'trusting')).toEqual([...HOOKS].sort())

    await commit('confined', worktreeOf(linked, 'confined').gitDir)
    expect(hooksRun(linked.scratch, 'confined')).toEqual([])
    expect(git(linked.base, 'log', '--format=%s', 'branch-confined').trim().split('\n')[0]).toBe('work')
  }, GIT_TEST_TIMEOUT_MS)

  it('runs no file-system monitor that a relative core.fsmonitor resolves inside the worktree', async () => {
    const linked = await linkedWorktrees('trusting', 'confined')
    git(linked.base, 'config', 'core.fsmonitor', '.githooks/monitor')
    const command = await runner()
    const status = async (name: string, worktreeGitDir?: string): Promise<void> => {
      const { path } = worktreeOf(linked, name)
      await plantHooks(join(path, '.githooks'), ['monitor'], join(linked.scratch, `ran-${name}`))
      await command.expect(['status', '--porcelain'], 'git status', { cwd: path, signal, worktreeGitDir })
    }

    await status('trusting')
    expect(hooksRun(linked.scratch, 'trusting')).toEqual(['monitor'])

    await status('confined', worktreeOf(linked, 'confined').gitDir)
    expect(hooksRun(linked.scratch, 'confined')).toEqual([])
  }, GIT_TEST_TIMEOUT_MS)
})

describe('worktreeGitDirFor', () => {
  async function commonDirOf(linked: Linked): Promise<string> {
    return realpath(join(linked.base, '.git'))
  }

  it('finds the administrative directory git created for each worktree', async () => {
    const linked = await linkedWorktrees('one', 'two')
    const commonDir = await commonDirOf(linked)
    for (const name of ['one', 'two']) {
      const { path, gitDir } = worktreeOf(linked, name)
      expect(await worktreeGitDirFor(commonDir, path, `wt-${name}`)).toBe(gitDir)
    }
  }, GIT_TEST_TIMEOUT_MS)

  it('refuses a directory git has not registered as a worktree', async () => {
    const linked = await linkedWorktrees('one')
    const plain = join(linked.scratch, 'plain')
    await mkdir(plain)
    await expect(worktreeGitDirFor(await commonDirOf(linked), plain, 'wt-plain'))
      .rejects.toThrow('subagent-worktree: git has no linked worktree registered for worktree wt-plain')
  }, GIT_TEST_TIMEOUT_MS)

  it('refuses a repository that has no linked worktrees at all', async () => {
    const linked = await linkedWorktrees()
    const plain = join(linked.scratch, 'plain')
    await mkdir(plain)
    await expect(worktreeGitDirFor(await commonDirOf(linked), plain, 'wt-none'))
      .rejects.toThrow('git has no linked worktree registered for worktree wt-none')
  }, GIT_TEST_TIMEOUT_MS)

  it('names the worktree, not a path, when its directory is gone', async () => {
    const linked = await linkedWorktrees('one')
    const { path } = worktreeOf(linked, 'one')
    await rm(path, { recursive: true })
    const failure = await worktreeGitDirFor(await commonDirOf(linked), path, 'wt-one').then(() => undefined, (error: unknown) => error)
    expect(failure).toEqual(new Error('subagent-worktree: worktree wt-one has no directory to run git in'))
  }, GIT_TEST_TIMEOUT_MS)

  it('rethrows a failure to resolve the worktree directory that is not a missing directory', async () => {
    const linked = await linkedWorktrees()
    await expect(worktreeGitDirFor(await commonDirOf(linked), 'not\0valid', 'wt-bad')).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
  }, GIT_TEST_TIMEOUT_MS)

  it('rethrows a failure to read the registry that is not a missing directory', async () => {
    const linked = await linkedWorktrees()
    const notADirectory = join(linked.scratch, 'file')
    await writeFile(notADirectory, 'x')
    await expect(worktreeGitDirFor(notADirectory, linked.scratch, 'wt-file')).rejects.toMatchObject({ code: 'ENOTDIR' })
  }, GIT_TEST_TIMEOUT_MS)

  it('skips an entry that has no pointer file and rethrows one it cannot read', async () => {
    const linked = await linkedWorktrees('one')
    const commonDir = await commonDirOf(linked)
    const { path, gitDir } = worktreeOf(linked, 'one')
    await mkdir(join(commonDir, 'worktrees', 'still-being-created'))
    expect(await worktreeGitDirFor(commonDir, path, 'wt-one')).toBe(gitDir)

    // No registered worktree matches, so every entry is read, and the unreadable pointer surfaces.
    await mkdir(join(commonDir, 'worktrees', 'unreadable', 'gitdir'), { recursive: true })
    const plain = join(linked.scratch, 'plain')
    await mkdir(plain)
    await expect(worktreeGitDirFor(commonDir, plain, 'wt-plain')).rejects.toMatchObject({ code: 'EISDIR' })
  }, GIT_TEST_TIMEOUT_MS)
})

describe('worktreeGitDirOf', () => {
  it('finds the administrative directory through the base checkout the record names', async () => {
    const linked = await linkedWorktrees('one')
    const { path, gitDir } = worktreeOf(linked, 'one')
    const repoRoot = await realpath(linked.base)
    expect(await worktreeGitDirOf(await runner(), { id: 'wt-00000001' as WorktreeId, repoRoot, path }, signal)).toBe(gitDir)
  }, GIT_TEST_TIMEOUT_MS)

  it('refuses a base checkout that is no longer a git work tree', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-confine-plain-'))
    cleanups.push(() => removeFixture(scratch))
    await expect(worktreeGitDirOf(await runner(), { id: 'wt-00000002' as WorktreeId, repoRoot: scratch, path: scratch }, signal))
      .rejects.toThrow('subagent-worktree: the base checkout of worktree wt-00000002 is no longer inside a git work tree')
  }, GIT_TEST_TIMEOUT_MS)
})
