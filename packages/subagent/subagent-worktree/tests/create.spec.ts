import { chmod, mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BASE_DIRTY_MAX_ENTRIES } from '../src/bounds.ts'
import { createWorktree } from '../src/create.ts'
import { GitRunner } from '../src/git.ts'
import type * as Git from '../src/git.ts'
import type { GitCommandResult, GitRunOptions } from '../src/git.ts'
import { layoutForRepo } from '../src/records.ts'
import { expireSignal, KILLED_RESULT } from './cleanup-signals.ts'
import { addFixtureSubmodule, git, initFixtureRepo, removeFixture } from './harness.ts'
import type { CreateWorktreeRequest } from '../src/types.ts'

// Cleanup signals never run out on their own here, so a test can make one run out at a chosen moment.
vi.mock('../src/git.ts', async importOriginal => (
  (await import('./cleanup-signals.ts')).withExpirableCleanupSignals(await importOriginal<typeof Git>())
))

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

const WORKER_ROUTE = { provider: 'worker-provider', model: 'worker-model' }

function request(baseDir: string, overrides: Partial<CreateWorktreeRequest> = {}): CreateWorktreeRequest {
  return {
    owner: { kind: 'session', sessionId: SessionId('s1') },
    baseDir,
    label: 'do the thing',
    task: 'do the thing',
    workerRoute: WORKER_ROUTE,
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

  it('reports baseDirty when the config hides the base checkout\'s untracked files from git status', async () => {
    const dir = await initFixtureRepo('dsh-create-dirty-hidden-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    git(dir, 'config', 'status.showUntrackedFiles', 'no')
    await writeFile(join(dir, 'untracked.txt'), 'x')
    const root = await scratchRoot()

    // The status read asks for untracked files explicitly, so a config that hides them cannot make the base
    // checkout look clean: the worktree would not contain that file, so the worker's checks would run without it.
    const provisioned = await createWorktree(await runner(), root, 'dsh/worktree/', 16, request(dir))

    expect(provisioned.baseDirty?.entries).toEqual(['?? untracked.txt'])
  }, GIT_TEST_TIMEOUT_MS)

  it('reports an untracked directory as one entry even when the config hides untracked files', async () => {
    const dir = await initFixtureRepo('dsh-create-untracked-dir-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    git(dir, 'config', 'status.showUntrackedFiles', 'no')
    await mkdir(join(dir, 'build'))
    for (const name of ['a.js', 'b.js', 'c.js']) await writeFile(join(dir, 'build', name), 'x')
    const root = await scratchRoot()

    // The status read asks for untracked files explicitly, so the config cannot hide the directory, and it asks for
    // one entry per directory rather than one per file: a checkout whose build output or virtualenv holds tens of
    // thousands of files then still summarizes inside the capture cap instead of failing `create` outright.
    const provisioned = await createWorktree(await runner(), root, 'dsh/worktree/', 16, request(dir))

    expect(provisioned.baseDirty?.entries).toEqual(['?? build/'])
    expect(provisioned.baseDirty?.total).toBe(1)
  }, GIT_TEST_TIMEOUT_MS)

  it('reports a base submodule whose checkout moved, even when the config hides submodule changes', async () => {
    const dir = await initFixtureRepo('dsh-create-submodule-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const { subdir, older } = await addFixtureSubmodule(dir, 'dsh-create-submodule-src-')
    // The submodule is checked out at a commit its own gitlink does not name, which is a base change the worktree
    // would not contain.
    git(subdir, 'checkout', '-q', '--detach', older)
    git(dir, 'config', 'submodule.sub.ignore', 'all')
    const root = await scratchRoot()

    const provisioned = await createWorktree(await runner(), root, 'dsh/worktree/', 16, request(dir))

    expect(provisioned.baseDirty?.entries).toEqual([' M sub'])
  }, GIT_TEST_TIMEOUT_MS)

  it('scopes workDir inside the worktree when baseDir is reached through a symlinked directory prefix', async () => {
    const dir = await initFixtureRepo('dsh-create-symlinked-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const sub = join(dir, 'packages', 'foo')
    await mkdir(sub, { recursive: true })
    const link = join(await scratchRoot(), 'linked-repo')
    await symlink(await realpath(dir), link, 'dir')
    const root = await scratchRoot()

    // `git` reports the canonical repository root, so the symlinked base dir has to be canonicalized too: without
    // that, `workDir` resolves through the symlink to somewhere outside the worktree it was derived from.
    const provisioned = await createWorktree(await runner(), root, 'dsh/worktree/', 16, request(join(link, 'packages', 'foo')))

    expect(provisioned.workDir).toBe(join(provisioned.record.path, 'packages', 'foo'))
  }, GIT_TEST_TIMEOUT_MS)
})

/**
 * Runs real git, except `git status` reports a lossy capture and, optionally, cancels the request as it does
 * so; `worktree remove` can be made to blow up, to fail with a nonzero exit, or to complete and then run out of
 * time. Like the subprocess runtime, it never runs a command started on an aborted signal. Records every command.
 */
class BrokenStatusGit extends GitRunner {
  readonly commands: string[][] = []

  constructor(
    subprocessRuntime: ConstructorParameters<typeof GitRunner>[0],
    private readonly options: {
      readonly removeBlowsUp?: boolean
      readonly removeFails?: boolean
      readonly removeTimesOut?: boolean
      readonly cancel?: AbortController
    } = {},
  ) {
    super(subprocessRuntime)
  }

  override async run(args: readonly string[], runOptions: GitRunOptions): Promise<GitCommandResult> {
    this.commands.push([...args])
    if (runOptions.signal?.aborted === true) return KILLED_RESULT
    if (args[0] === 'worktree' && args[1] === 'remove') {
      if (this.options.removeBlowsUp === true) throw new Error('cleanup blew up')
      if (this.options.removeFails === true) return { exitCode: 128, stdout: '', stderr: 'fatal: scripted removal failure\n', stdoutLossy: false }
      if (this.options.removeTimesOut === true) {
        // The removal completes, and its own bound runs out before the runner can report it, so it reads as killed.
        await super.run(args, runOptions)
        expireSignal(runOptions.signal)
        return KILLED_RESULT
      }
    }
    if (args[0] === 'status') {
      this.options.cancel?.abort()
      return { exitCode: 0, stdout: '', stderr: '', stdoutLossy: true }
    }
    return super.run(args, runOptions)
  }
}

describe('createWorktree: failure after `git worktree add`', () => {
  it('fails loud, and removes the worktree and branch it just made, when git status output was cut short', async () => {
    const dir = await initFixtureRepo('dsh-create-lossy-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    // More than the 1 MiB default capture: 6000 untracked files with ~200 character names.
    const names = Array.from({ length: 6_000 }, (_, i) => `${'x'.repeat(190)}-${i}.txt`)
    for (let i = 0; i < names.length; i += 200) {
      await Promise.all(names.slice(i, i + 200).map(name => writeFile(join(dir, name), '')))
    }
    const root = await scratchRoot()

    await expect(createWorktree(await runner(), root, 'dsh/worktree/', 16, request(dir)))
      .rejects.toThrow('git status output exceeded its capture limit; refusing to parse a partial result')

    expect(git(dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
    expect(git(dir, 'branch', '--list', 'dsh/worktree/*').trim()).toBe('')
    expect(await readdir(join(root, ...(await readdir(root))))).toEqual([])
  }, 60_000)

  it('removes the worktree and branch it just made when persisting the record fails', async () => {
    const dir = await initFixtureRepo('dsh-create-persist-fails-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const layout = layoutForRepo(root, await realpath(join(dir, '.git')))
    // A read-only records directory makes the record lock file, and so the write, fail.
    await mkdir(layout.recordsDir, { recursive: true })
    await chmod(layout.recordsDir, 0o555)
    cleanups.push(() => chmod(layout.recordsDir, 0o755))

    await expect(createWorktree(await runner(), root, 'dsh/worktree/', 16, request(dir))).rejects.toThrow(/EACCES|permission denied/i)

    expect(git(dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
    expect(git(dir, 'branch', '--list', 'dsh/worktree/*').trim()).toBe('')
    expect(await readdir(layout.repoDir)).toEqual(['records'])
  }, GIT_TEST_TIMEOUT_MS)

  it('surfaces the original failure when the cleanup itself fails too', async () => {
    const dir = await initFixtureRepo('dsh-create-cleanup-fails-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)

    const command = new BrokenStatusGit(ctx.subprocess, { removeBlowsUp: true })

    await expect(createWorktree(command, root, 'dsh/worktree/', 16, request(dir)))
      .rejects.toThrow('git status output exceeded its capture limit')
    // The worktree removal blew up, but the branch deletion was still attempted.
    expect(command.commands.some(args => args[0] === 'branch' && args[1] === '-D')).toBe(true)
  }, GIT_TEST_TIMEOUT_MS)

  it('still attempts to delete the branch when removing the worktree fails, and reports the original failure', async () => {
    const dir = await initFixtureRepo('dsh-create-remove-fails-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    const command = new BrokenStatusGit(ctx.subprocess, { removeFails: true })

    await expect(createWorktree(command, root, 'dsh/worktree/', 16, request(dir)))
      .rejects.toThrow('git status output exceeded its capture limit')
    expect(command.commands.filter(args => args[0] === 'branch' && args[1] === '-D')).toHaveLength(1)
  }, GIT_TEST_TIMEOUT_MS)

  it('deletes the branch on its own fresh signal, so a worktree removal that timed out does not stop it', async () => {
    const dir = await initFixtureRepo('dsh-create-remove-times-out-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    const command = new BrokenStatusGit(ctx.subprocess, { removeTimesOut: true })

    await expect(createWorktree(command, root, 'dsh/worktree/', 16, request(dir)))
      .rejects.toThrow('git status output exceeded its capture limit')

    // The removal completed and then ran out of time; the branch deletion after it still ran, for real.
    expect(git(dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
    expect(git(dir, 'branch', '--list', 'dsh/worktree/*').trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)

  it('cleans up on a fresh signal when the request was cancelled: the worktree and branch are still removed', async () => {
    const dir = await initFixtureRepo('dsh-create-cancelled-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await scratchRoot()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    const controller = new AbortController()
    const command = new BrokenStatusGit(ctx.subprocess, { cancel: controller })

    await expect(createWorktree(command, root, 'dsh/worktree/', 16, request(dir, { signal: controller.signal })))
      .rejects.toThrow('git status output exceeded its capture limit')

    expect(controller.signal.aborted).toBe(true)
    expect(git(dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1)
    expect(git(dir, 'branch', '--list', 'dsh/worktree/*').trim()).toBe('')
  }, GIT_TEST_TIMEOUT_MS)
})
