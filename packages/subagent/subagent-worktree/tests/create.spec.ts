import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BASE_DIRTY_MAX_ENTRIES } from '../src/bounds.ts'
import { createWorktree } from '../src/create.ts'
import { GitRunner } from '../src/git.ts'
import { git, initFixtureRepo, removeFixture } from './harness.ts'
import type { CreateWorktreeRequest } from '../src/types.ts'

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

async function scratchRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-create-root-'))
  cleanups.push(() => removeFixture(dir))
  return dir
}

const signal = new AbortController().signal

// Each case runs a real `git worktree add`; generous under concurrent CI load.
const GIT_TEST_TIMEOUT_MS = 20_000

function request(baseDir: string, overrides: Partial<CreateWorktreeRequest> = {}): CreateWorktreeRequest {
  return {
    owner: { kind: 'session', sessionId: SessionId('s1') },
    baseDir,
    label: 'do the thing',
    task: 'do the thing',
    signal,
    ...overrides,
  }
}

describe('createWorktree', () => {
  it('creates a branch, worktree, and open record from HEAD', async () => {
    const dir = await initFixtureRepo('dsh-create-ok-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const head = git(dir, 'rev-parse', 'HEAD').trim()
    const root = await scratchRoot()

    const provisioned = await createWorktree(await runner(), root, 'dsh/worktree/', 16, request(dir))

    expect(provisioned.record.state).toBe('open')
    expect(provisioned.record.baseCommit).toBe(head)
    expect(provisioned.record.branch).toBe(`dsh/worktree/${provisioned.record.id}`)
    expect(provisioned.workDir).toBe(provisioned.record.path)
    expect(provisioned.baseDirty).toBeUndefined()
    expect(git(provisioned.record.path, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(dir, 'branch', '--list', provisioned.record.branch).trim()).not.toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('scopes workDir to baseDir\'s path inside the repository', async () => {
    const dir = await initFixtureRepo('dsh-create-workdir-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const sub = join(dir, 'packages', 'foo')
    await mkdir(sub, { recursive: true })
    const root = await scratchRoot()

    const provisioned = await createWorktree(await runner(), root, 'dsh/worktree/', 16, request(sub))
    expect(provisioned.workDir).toBe(join(provisioned.record.path, 'packages', 'foo'))
  }, GIT_TEST_TIMEOUT_MS)

  it('rejects a base directory outside any git work tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-create-nongit-'))
    cleanups.push(() => removeFixture(dir))
    const root = await scratchRoot()
    await expect(createWorktree(await runner(), root, 'dsh/worktree/', 16, request(dir)))
      .rejects.toThrow(`subagent-worktree: "${dir}" is not inside a git work tree, so no isolated worktree can be created`)
  }, GIT_TEST_TIMEOUT_MS)

  it('rejects a new worktree once the repository already has maxWorktrees open', async () => {
    const dir = await initFixtureRepo('dsh-create-max-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const git1 = await runner()
    await createWorktree(git1, root, 'dsh/worktree/', 1, request(dir))
    const canonicalDir = await realpath(dir)
    await expect(createWorktree(await runner(), root, 'dsh/worktree/', 1, request(dir)))
      .rejects.toThrow(`subagent-worktree: 1 worktrees are already open for ${canonicalDir}; accept or discard one first`)
  }, GIT_TEST_TIMEOUT_MS)

  it('omits baseDirty when the base checkout is clean', async () => {
    const dir = await initFixtureRepo('dsh-create-clean-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const provisioned = await createWorktree(await runner(), root, 'dsh/worktree/', 16, request(dir))
    expect(provisioned.baseDirty).toBeUndefined()
  }, GIT_TEST_TIMEOUT_MS)

  it('bounds baseDirty to the first 20 entries but reports the exact total at 21', async () => {
    const dir = await initFixtureRepo('dsh-create-dirty-21-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    for (let i = 0; i < 21; i += 1) await writeFile(join(dir, `dirty-${i}.txt`), 'x')
    const root = await scratchRoot()
    const provisioned = await createWorktree(await runner(), root, 'dsh/worktree/', 16, request(dir))
    expect(provisioned.baseDirty?.total).toBe(21)
    expect(provisioned.baseDirty?.entries).toHaveLength(BASE_DIRTY_MAX_ENTRIES)
  }, GIT_TEST_TIMEOUT_MS)

  it('reports every entry when baseDirty has exactly 20', async () => {
    const dir = await initFixtureRepo('dsh-create-dirty-20-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    for (let i = 0; i < BASE_DIRTY_MAX_ENTRIES; i += 1) await writeFile(join(dir, `dirty-${i}.txt`), 'x')
    const root = await scratchRoot()
    const provisioned = await createWorktree(await runner(), root, 'dsh/worktree/', 16, request(dir))
    expect(provisioned.baseDirty?.total).toBe(BASE_DIRTY_MAX_ENTRIES)
    expect(provisioned.baseDirty?.entries).toHaveLength(BASE_DIRTY_MAX_ENTRIES)
  }, GIT_TEST_TIMEOUT_MS)
})
