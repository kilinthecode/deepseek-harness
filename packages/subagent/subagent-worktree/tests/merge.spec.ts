import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitRunner } from '../src/git.ts'
import type { GitCommandResult, GitRunOptions } from '../src/git.ts'
import { attemptMerge } from '../src/merge.ts'
import type { MergeAttemptHooks } from '../src/merge.ts'
import { git, initFixtureRepo, removeFixture } from './harness.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function subprocess() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx.subprocess
}

async function runner(): Promise<GitRunner> {
  return new GitRunner(await subprocess())
}

const signal = new AbortController().signal

// Each case runs several real git subprocesses; generous under concurrent CI load.
const GIT_TEST_TIMEOUT_MS = 20_000

/** Hooks that record what the caller was told, in order. */
function recordingHooks(
  events: string[] = [], beforeMerge: () => void = () => {},
): MergeAttemptHooks & { readonly events: string[]; readonly reports: string[] } {
  const reports: string[] = []
  return {
    events,
    reports,
    beforeMerge,
    onLanded: () => { events.push('landed') },
    report: (message) => { reports.push(message) },
  }
}

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
    const hooks = recordingHooks()

    const result = await attemptMerge(await runner(), dir, 'wt-00000001', 'do the thing', sideCommit, signal, hooks)
    expect(result.kind).toBe('merged')
    if (result.kind !== 'merged') throw new Error('unreachable')
    expect(result.mergeCommit).toBe(git(dir, 'rev-parse', 'HEAD').trim())
    // --no-ff always creates a merge commit, never a fast-forward.
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
    expect(git(dir, 'log', '-1', '--pretty=%s').trim()).toBe('Merge worktree wt-00000001: do the thing')
    expect(hooks.events).toEqual(['landed'])
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
    const hooks = recordingHooks()

    const result = await attemptMerge(await runner(), dir, 'wt-00000002', 'do the thing', sideCommit, signal, hooks)
    expect(result).toEqual({ kind: 'conflict', files: ['shared.txt'] })
    // The abort restored a clean tree at the pre-merge HEAD; the side branch's commit is untouched.
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
    expect(git(dir, 'cat-file', '-e', sideCommit).trim()).toBe('')
    expect(hooks.events).toEqual([])
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

    const result = await attemptMerge(await runner(), dir, 'wt-00000003', 'do the thing', sideCommit, signal, recordingHooks())
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

/** A repository whose `side` branch conflicts with `main` on `f.txt`, left on `main`. */
async function repoWithConflictingSideBranch(prefix: string): Promise<{ dir: string; sideCommit: string; baseHead: string }> {
  const dir = await initFixtureRepo(prefix)
  cleanups.push(() => removeFixture(dir))
  await writeFile(join(dir, 'f.txt'), 'base\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'checkout', '-q', '-b', 'side')
  await writeFile(join(dir, 'f.txt'), 'side\n')
  git(dir, 'commit', '-q', '-am', 'side')
  const sideCommit = git(dir, 'rev-parse', 'HEAD').trim()
  git(dir, 'checkout', '-q', 'main')
  await writeFile(join(dir, 'f.txt'), 'main\n')
  git(dir, 'commit', '-q', '-am', 'main')
  return { dir, sideCommit, baseHead: git(dir, 'rev-parse', 'HEAD').trim() }
}

/** What a scripted runner replaces or observes; every command it does not mention runs as real git. */
interface Script {
  /** Replaces `git merge`: runs `alongside` for real first (leaving whatever merge state it leaves), then returns `result`. */
  readonly merge?: { readonly alongside?: readonly string[]; readonly result: GitCommandResult; readonly beforeResult?: () => void }
  /** Replaces `git symbolic-ref`. */
  readonly symbolicRef?: GitCommandResult
  /** Replaces `git rev-parse -q --verify MERGE_HEAD`. */
  readonly mergeHeadProbe?: GitCommandResult
  /** Replaces `git merge --abort` (the real command then does not run). */
  readonly mergeAbort?: GitCommandResult
  /** Fails the first this many `git rev-parse HEAD` calls with a nonzero exit. */
  readonly failRevParseHead?: number
}

/** Real git with scripted exceptions, recording every command it is asked to run. */
class ScriptedGit extends GitRunner {
  readonly commands: string[][] = []
  private revParseHeadFailures = 0

  constructor(subprocessRuntime: ConstructorParameters<typeof GitRunner>[0], private readonly script: Script) {
    super(subprocessRuntime)
  }

  override async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    this.commands.push([...args])
    const { script } = this
    if (args[0] === 'merge' && args[1] === '--abort' && script.mergeAbort !== undefined) return script.mergeAbort
    if (args[0] === 'merge' && args[1] !== '--abort' && script.merge !== undefined) {
      if (script.merge.alongside !== undefined) await super.run(script.merge.alongside, options)
      script.merge.beforeResult?.()
      return script.merge.result
    }
    if (args[0] === 'symbolic-ref' && script.symbolicRef !== undefined) return script.symbolicRef
    if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD') && script.mergeHeadProbe !== undefined) return script.mergeHeadProbe
    if (args[0] === 'rev-parse' && args[1] === 'HEAD' && this.revParseHeadFailures < (script.failRevParseHead ?? 0)) {
      this.revParseHeadFailures += 1
      return { exitCode: 128, stdout: '', stderr: 'fatal: scripted rev-parse failure\n', stdoutLossy: false }
    }
    return super.run(args, options)
  }
}

async function scripted(script: Script): Promise<ScriptedGit> {
  return new ScriptedGit(await subprocess(), script)
}

const KILLED: GitCommandResult = { exitCode: null, stdout: '', stderr: '', stdoutLossy: false }
const FAILED_128: GitCommandResult = { exitCode: 128, stdout: '', stderr: 'fatal: scripted failure\n', stdoutLossy: false }

describe('attemptMerge: the last check before merging', () => {
  it('runs beforeMerge after the pre-merge probes and immediately before git merge starts', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-before-')
    const command = await scripted({})
    let commandsWhenChecked = -1
    const hooks = recordingHooks([], () => { commandsWhenChecked = command.commands.length })

    await attemptMerge(command, dir, 'wt-00000022', 'do the thing', sideCommit, signal, hooks)

    // Two probes (MERGE_HEAD, then HEAD attachment) ran first; the very next command is the merge itself.
    expect(commandsWhenChecked).toBe(2)
    expect(command.commands[commandsWhenChecked]?.[0]).toBe('merge')
  }, GIT_TEST_TIMEOUT_MS)

  it('stops before any merge state exists when beforeMerge throws', async () => {
    const { dir, sideCommit, baseHead } = await repoWithSideBranch('dsh-merge-before-throws-')
    const command = await scripted({})
    const hooks = recordingHooks([], () => { throw new Error('a worker is running again') })

    await expect(attemptMerge(command, dir, 'wt-00000023', 'do the thing', sideCommit, signal, hooks))
      .rejects.toThrow('a worker is running again')

    expect(command.commands.some(args => args[0] === 'merge')).toBe(false)
    expect(hooks.events).toEqual([])
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)
})

describe('attemptMerge: refusing to start', () => {
  it('reports blocked, and leaves a merge the user already has in progress exactly as it was', async () => {
    const { dir, sideCommit } = await repoWithConflictingSideBranch('dsh-merge-in-progress-')
    try {
      git(dir, 'merge', 'side')
    } catch {
      // A conflicting merge exits nonzero by design; the half-finished merge it leaves is what this test needs.
    }
    const mergeHead = git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()
    const conflicted = await readFile(join(dir, 'f.txt'), 'utf8')
    const command = await runner()

    const result = await attemptMerge(command, dir, 'wt-00000004', 'do the thing', sideCommit, signal, recordingHooks())

    expect(result).toEqual({ kind: 'blocked', reason: 'the base checkout already has a merge in progress (MERGE_HEAD exists)' })
    expect(git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).toBe(mergeHead)
    expect(await readFile(join(dir, 'f.txt'), 'utf8')).toBe(conflicted)
    expect(git(dir, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('f.txt')
  }, GIT_TEST_TIMEOUT_MS)

  it('reports blocked, and merges nothing, when HEAD is detached', async () => {
    const { dir, sideCommit, baseHead } = await repoWithSideBranch('dsh-merge-detached-')
    git(dir, 'checkout', '-q', '--detach')

    const result = await attemptMerge(await runner(), dir, 'wt-00000005', 'do the thing', sideCommit, signal, recordingHooks())

    expect(result).toEqual({ kind: 'blocked', reason: 'the base checkout HEAD is detached; a merge there would update no branch' })
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('0')
  }, GIT_TEST_TIMEOUT_MS)

  it.each([
    ['cancelled', KILLED],
    ['failed with a fatal exit', FAILED_128],
  ])('throws when the detached-HEAD probe is %s, instead of reading the missing answer as attached or detached', async (_label, probe) => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-probe-head-')
    const command = await scripted({ symbolicRef: probe })

    await expect(attemptMerge(command, dir, 'wt-00000010', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('could not read HEAD of the base checkout (git symbolic-ref exited')
    expect(command.commands.some(args => args[0] === 'merge')).toBe(false)
  }, GIT_TEST_TIMEOUT_MS)

  it.each([
    ['cancelled', KILLED],
    ['failed with a fatal exit', FAILED_128],
  ])('throws when the MERGE_HEAD probe is %s, instead of reading the missing answer as no merge in progress', async (_label, probe) => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-probe-mergehead-')
    const command = await scripted({ mergeHeadProbe: probe })

    await expect(attemptMerge(command, dir, 'wt-00000011', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('could not check the base checkout for a merge in progress (git rev-parse exited')
    expect(command.commands.some(args => args[0] === 'merge')).toBe(false)
  }, GIT_TEST_TIMEOUT_MS)
})

describe('attemptMerge: a merge that dies or fails after starting', () => {
  it('throws for a killed merge that left nothing behind, without aborting anything', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-killed-clean-')
    const command = await scripted({ merge: { result: KILLED } })

    await expect(attemptMerge(command, dir, 'wt-00000006', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('merge of worktree wt-00000006 was killed before it finished')
    expect(command.commands).not.toContainEqual(['merge', '--abort'])
  }, GIT_TEST_TIMEOUT_MS)

  it('aborts the MERGE_HEAD a killed merge left behind, then throws', async () => {
    const { dir, sideCommit, baseHead } = await repoWithSideBranch('dsh-merge-killed-leftover-')
    const command = await scripted({ merge: { alongside: ['merge', '--no-ff', '--no-commit', sideCommit], result: KILLED } })

    await expect(attemptMerge(command, dir, 'wt-00000007', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('was killed before it finished')

    expect(command.commands).toContainEqual(['merge', '--abort'])
    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('throws, and leaves no MERGE_HEAD, for a killed merge that had already stopped on conflicts', async () => {
    const { dir, sideCommit, baseHead } = await repoWithConflictingSideBranch('dsh-merge-killed-conflicts-')
    const command = await scripted({ merge: { alongside: ['merge', '--no-ff', '--no-edit', sideCommit], result: KILLED } })

    await expect(attemptMerge(command, dir, 'wt-00000012', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('was killed before it finished')

    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('aborts a merge that failed fatally after starting, then throws with git\'s message', async () => {
    const { dir, sideCommit, baseHead } = await repoWithSideBranch('dsh-merge-fatal-')
    const command = await scripted({
      merge: {
        alongside: ['merge', '--no-ff', '--no-commit', sideCommit],
        result: { exitCode: 128, stdout: '', stderr: 'fatal: something went wrong mid-merge\n', stdoutLossy: false },
      },
    })

    await expect(attemptMerge(command, dir, 'wt-00000008', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('merge of worktree wt-00000008 failed unexpectedly after starting: fatal: something went wrong mid-merge')

    expect(command.commands).toContainEqual(['merge', '--abort'])
    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('does not call a merge that failed with a fatal exit a conflict, even when it left unmerged paths: it aborts and throws', async () => {
    const { dir, sideCommit, baseHead } = await repoWithConflictingSideBranch('dsh-merge-fatal-with-conflicts-')
    const command = await scripted({
      merge: { alongside: ['merge', '--no-ff', '--no-edit', sideCommit], result: FAILED_128 },
    })

    await expect(attemptMerge(command, dir, 'wt-00000021', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('merge of worktree wt-00000021 failed unexpectedly after starting: fatal: scripted failure')

    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('reports blocked, not an error, for a refusal that started no merge', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-refused-')
    const command = await scripted({
      merge: { result: { exitCode: 1, stdout: '', stderr: 'error: Your local changes would be overwritten by merge.\n', stdoutLossy: false } },
    })

    const result = await attemptMerge(command, dir, 'wt-00000009', 'do the thing', sideCommit, signal, recordingHooks())

    expect(result).toEqual({ kind: 'blocked', reason: 'error: Your local changes would be overwritten by merge.' })
    expect(command.commands).not.toContainEqual(['merge', '--abort'])
  }, GIT_TEST_TIMEOUT_MS)

  it('runs its cleanup on a fresh signal when the caller cancelled the merge: the half-started merge is still aborted', async () => {
    const { dir, sideCommit, baseHead } = await repoWithConflictingSideBranch('dsh-merge-cancelled-')
    const controller = new AbortController()
    // The merge really starts and stops on conflicts, then the caller cancels and the merge process is reported killed.
    const command = await scripted({
      merge: {
        alongside: ['merge', '--no-ff', '--no-edit', sideCommit],
        beforeResult: () => { controller.abort() },
        result: KILLED,
      },
    })

    await expect(attemptMerge(command, dir, 'wt-00000013', 'do the thing', sideCommit, controller.signal, recordingHooks()))
      .rejects.toThrow('was killed before it finished')

    expect(controller.signal.aborted).toBe(true)
    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('reports loudly, and still throws, when it cannot clear a MERGE_HEAD it left behind', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-stuck-')
    const hooks = recordingHooks()
    const command = await scripted({
      merge: { alongside: ['merge', '--no-ff', '--no-commit', sideCommit], result: KILLED },
      mergeAbort: FAILED_128,
    })

    await expect(attemptMerge(command, dir, 'wt-00000014', 'do the thing', sideCommit, signal, hooks))
      .rejects.toThrow('was killed before it finished')

    expect(hooks.reports).toHaveLength(1)
    expect(hooks.reports[0]).toContain(`the merge of ${sideCommit} in "${dir}" could not be aborted and is still in progress`)
    expect(hooks.reports[0]).toContain('git merge --abort')
    expect(git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).toBe(sideCommit)
  }, GIT_TEST_TIMEOUT_MS)
})

describe('attemptMerge: a merge state this call did not create', () => {
  /** A second clean branch, so a foreign merge in progress names a commit other than the one being merged. */
  async function withForeignCommit(prefix: string): Promise<{ dir: string; sideCommit: string; foreignCommit: string; baseHead: string }> {
    const { dir, sideCommit, baseHead } = await repoWithSideBranch(prefix)
    git(dir, 'checkout', '-q', '-b', 'foreign')
    await writeFile(join(dir, 'foreign.txt'), 'foreign\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'foreign change')
    const foreignCommit = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', 'main')
    return { dir, sideCommit, foreignCommit, baseHead }
  }

  it('never aborts a MERGE_HEAD that names another commit, and reports the checkout blocked', async () => {
    const { dir, sideCommit, foreignCommit } = await withForeignCommit('dsh-merge-foreign-')
    // Another tool starts its own merge between the pre-merge probes and this call's `git merge`, which then fails.
    const command = await scripted({
      merge: {
        alongside: ['merge', '--no-ff', '--no-commit', foreignCommit],
        result: { exitCode: 1, stdout: '', stderr: 'Automatic merge failed\n', stdoutLossy: false },
      },
    })

    const result = await attemptMerge(command, dir, 'wt-00000015', 'do the thing', sideCommit, signal, recordingHooks())

    expect(result).toEqual({ kind: 'blocked', reason: 'the base checkout has conflicts this accept did not create' })
    expect(command.commands).not.toContainEqual(['merge', '--abort'])
    expect(git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).toBe(foreignCommit)
  }, GIT_TEST_TIMEOUT_MS)

  it('leaves a foreign MERGE_HEAD alone even when this call\'s merge was killed, and still throws', async () => {
    const { dir, sideCommit, foreignCommit } = await withForeignCommit('dsh-merge-foreign-killed-')
    const command = await scripted({ merge: { alongside: ['merge', '--no-ff', '--no-commit', foreignCommit], result: KILLED } })

    await expect(attemptMerge(command, dir, 'wt-00000016', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('was killed before it finished')

    expect(command.commands).not.toContainEqual(['merge', '--abort'])
    expect(git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).toBe(foreignCommit)
  }, GIT_TEST_TIMEOUT_MS)

  it('reports blocked, and touches nothing, for unmerged paths left by another operation with no MERGE_HEAD', async () => {
    const dir = await initFixtureRepo('dsh-merge-cherry-pick-')
    cleanups.push(() => removeFixture(dir))
    await writeFile(join(dir, 'f.txt'), 'base\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')
    git(dir, 'checkout', '-q', '-b', 'other')
    await writeFile(join(dir, 'f.txt'), 'other\n')
    git(dir, 'commit', '-q', '-am', 'other')
    const otherCommit = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', 'main')
    await writeFile(join(dir, 'f.txt'), 'main\n')
    git(dir, 'commit', '-q', '-am', 'main')
    try {
      // A cherry-pick that conflicts leaves unmerged paths and CHERRY_PICK_HEAD, but no MERGE_HEAD.
      git(dir, 'cherry-pick', otherCommit)
    } catch {
      // The conflicting cherry-pick exits nonzero by design; the state it leaves is what this test needs.
    }
    const before = git(dir, 'status', '--porcelain')
    const command = await runner()

    const result = await attemptMerge(command, dir, 'wt-00000017', 'do the thing', otherCommit, signal, recordingHooks())

    expect(result).toEqual({ kind: 'blocked', reason: 'the base checkout has conflicts this accept did not create' })
    expect(git(dir, 'status', '--porcelain')).toBe(before)
    expect(git(dir, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD').trim()).toBe(otherCommit)
  }, GIT_TEST_TIMEOUT_MS)
})

describe('attemptMerge: a merge that landed', () => {
  it('tells the caller the merge landed before it reads the merge commit, and returns the commit', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-landed-')
    const events: string[] = []
    const command = await scripted({})
    const hooks = recordingHooks(events)
    const originalRun = command.run.bind(command)
    // Record the order of the commit-id read relative to the landed notification.
    command.run = (args, options) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') events.push('read merge commit')
      return originalRun(args, options)
    }

    const result = await attemptMerge(command, dir, 'wt-00000018', 'do the thing', sideCommit, signal, hooks)

    expect(result).toEqual({ kind: 'merged', mergeCommit: git(dir, 'rev-parse', 'HEAD').trim() })
    expect(events).toEqual(['landed', 'read merge commit'])
  }, GIT_TEST_TIMEOUT_MS)

  it('retries a failed merge commit read on a fresh signal, so one transient failure does not hide a landed merge', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-landed-retry-')
    const command = await scripted({ failRevParseHead: 1 })

    const result = await attemptMerge(command, dir, 'wt-00000019', 'do the thing', sideCommit, signal, recordingHooks())

    expect(result).toEqual({ kind: 'merged', mergeCommit: git(dir, 'rev-parse', 'HEAD').trim() })
    expect(command.commands.filter(args => args[0] === 'rev-parse' && args[1] === 'HEAD')).toHaveLength(2)
  }, GIT_TEST_TIMEOUT_MS)

  it('still reports the merge as landed when the merge commit cannot be read at all', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-landed-unreadable-')
    const command = await scripted({ failRevParseHead: 2 })
    const hooks = recordingHooks()

    await expect(attemptMerge(command, dir, 'wt-00000020', 'do the thing', sideCommit, signal, hooks))
      .rejects.toThrow('git rev-parse failed')

    expect(hooks.events).toEqual(['landed'])
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
  }, GIT_TEST_TIMEOUT_MS)
})
