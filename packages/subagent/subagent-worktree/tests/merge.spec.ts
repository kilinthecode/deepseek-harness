import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitRunner } from '../src/git.ts'
import type * as Git from '../src/git.ts'
import type { GitCommandResult, GitRunOptions } from '../src/git.ts'
import { attemptMerge } from '../src/merge.ts'
import type { MergeAttemptHooks } from '../src/merge.ts'
import { expireSignal } from './cleanup-signals.ts'
import { git, initFixtureRepo, removeFixture } from './harness.ts'

// Cleanup signals never run out on their own here, so a test can make one run out at a chosen moment.
vi.mock('../src/git.ts', async importOriginal => (
  (await import('./cleanup-signals.ts')).withExpirableCleanupSignals(await importOriginal<typeof Git>())
))

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
  /** Replaces every `git rev-parse -q --verify MERGE_HEAD`. */
  readonly mergeHeadProbe?: GitCommandResult
  /** Replaces the nth `git rev-parse -q --verify MERGE_HEAD` (counting from 1); the other probes run as real git. */
  readonly mergeHeadProbeAt?: Readonly<Record<number, GitCommandResult>>
  /** Replaces `git diff --name-only --diff-filter=U`, the unmerged-path scan. */
  readonly unmergedScan?: GitCommandResult
  /** Replaces `git merge --abort` (the real command then does not run). */
  readonly mergeAbort?: GitCommandResult
  /** Runs the real `git merge --abort`, then runs that command's own signal out and reports it killed. */
  readonly mergeAbortTimesOut?: boolean
  /** Fails the first this many `git rev-list` calls, which read the landing commit after a successful merge, with a nonzero exit. */
  readonly failLandingCommitRead?: number
}

/** Real git with scripted exceptions, recording every command it is asked to run. */
class ScriptedGit extends GitRunner {
  readonly commands: string[][] = []
  private landingCommitReadFailures = 0
  private mergeHeadProbes = 0

  constructor(subprocessRuntime: ConstructorParameters<typeof GitRunner>[0], private readonly script: Script) {
    super(subprocessRuntime)
  }

  override async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    this.commands.push([...args])
    const { script } = this
    // Like the subprocess runtime, a command started on an aborted signal never runs.
    if (options.signal?.aborted === true) return KILLED
    if (args[0] === 'merge' && args[1] === '--abort' && script.mergeAbort !== undefined) return script.mergeAbort
    if (args[0] === 'merge' && args[1] === '--abort' && script.mergeAbortTimesOut === true) {
      await super.run(args, options)
      expireSignal(options.signal)
      return KILLED
    }
    if (args[0] === 'merge' && args[1] !== '--abort' && script.merge !== undefined) {
      if (script.merge.alongside !== undefined) await super.run(script.merge.alongside, options)
      script.merge.beforeResult?.()
      return script.merge.result
    }
    if (args[0] === 'symbolic-ref' && script.symbolicRef !== undefined) return script.symbolicRef
    if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) {
      this.mergeHeadProbes += 1
      const replaced = script.mergeHeadProbeAt?.[this.mergeHeadProbes]
      if (replaced !== undefined) return replaced
      if (script.mergeHeadProbe !== undefined) return script.mergeHeadProbe
    }
    if (args[0] === 'diff' && args.includes('--diff-filter=U') && script.unmergedScan !== undefined) return script.unmergedScan
    if (args[0] === 'rev-list' && this.landingCommitReadFailures < (script.failLandingCommitRead ?? 0)) {
      this.landingCommitReadFailures += 1
      return { exitCode: 128, stdout: '', stderr: 'fatal: scripted rev-list failure\n', stdoutLossy: false }
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

  it('aborts a merge that failed with a fatal exit right after establishing it is its own, before any other probe', async () => {
    const { dir, sideCommit } = await repoWithConflictingSideBranch('dsh-merge-abort-first-')
    const command = await scripted({
      merge: { alongside: ['merge', '--no-ff', '--no-edit', sideCommit], result: FAILED_128 },
    })

    await expect(attemptMerge(command, dir, 'wt-00000025', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('failed unexpectedly after starting')

    const afterMerge = command.commands.slice(command.commands.findIndex(args => args[0] === 'merge' && args[1] !== '--abort') + 1)
    // The MERGE_HEAD probe that establishes ownership, then the abort, then the probe that checks it worked.
    expect(afterMerge.map(args => args[0])).toEqual(['rev-parse', 'merge', 'rev-parse'])
    expect(afterMerge[1]).toEqual(['merge', '--abort'])
  }, GIT_TEST_TIMEOUT_MS)

  it('throws, and leaves no MERGE_HEAD, for a merge that stopped with the conflict exit code but left no unmerged paths', async () => {
    const { dir, sideCommit, baseHead } = await repoWithSideBranch('dsh-merge-exit1-no-conflicts-')
    // A prepared clean merge that a pre-merge-commit hook then refused: MERGE_HEAD is this call's, nothing is unmerged.
    const command = await scripted({
      merge: {
        alongside: ['merge', '--no-ff', '--no-commit', sideCommit],
        result: { exitCode: 1, stdout: '', stderr: 'error: pre-merge-commit hook failed\n', stdoutLossy: false },
      },
    })

    await expect(attemptMerge(command, dir, 'wt-00000026', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('merge of worktree wt-00000026 failed unexpectedly after starting: error: pre-merge-commit hook failed')

    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('still aborts the merge it started when reading the conflicting paths fails, then throws', async () => {
    const { dir, sideCommit, baseHead } = await repoWithConflictingSideBranch('dsh-merge-scan-fails-')
    const command = await scripted({ unmergedScan: FAILED_128 })

    await expect(attemptMerge(command, dir, 'wt-00000027', 'do the thing', sideCommit, signal, recordingHooks()))
      .rejects.toThrow('merge of worktree wt-00000027 stopped and was aborted, but its conflicting paths could not be read')

    expect(command.commands).toContainEqual(['merge', '--abort'])
    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('reports loudly, and throws that the base checkout may be left mid-merge, when the check that the abort worked fails', async () => {
    const { dir, sideCommit, baseHead } = await repoWithConflictingSideBranch('dsh-merge-verify-fails-')
    const hooks = recordingHooks()
    // Probe 1 is the pre-merge refusal check, probe 2 establishes ownership, probe 3 checks that the abort worked.
    const command = await scripted({ mergeHeadProbeAt: { 3: FAILED_128 } })

    const failure = await attemptMerge(command, dir, 'wt-00000028', 'do the thing', sideCommit, signal, hooks).catch((error: unknown) => error)

    expect(String(failure)).toContain('the merge of worktree wt-00000028 could not be confirmed aborted: the base checkout may be left mid-merge')
    expect(String(failure)).toContain('git merge --abort')
    expect(String(failure)).not.toContain(dir)
    expect(hooks.reports).toHaveLength(1)
    expect(hooks.reports[0]).toContain(`the merge of ${sideCommit} in "${dir}" could not be confirmed aborted`)
    expect(hooks.reports[0]).toContain('git merge --abort')
    // The abort itself ran, so nothing is actually left behind.
    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('checks that the abort worked on its own fresh signal, so an abort that timed out does not stop the check', async () => {
    const { dir, sideCommit, baseHead } = await repoWithConflictingSideBranch('dsh-merge-abort-times-out-')
    const hooks = recordingHooks()
    const command = await scripted({ mergeAbortTimesOut: true })

    const result = await attemptMerge(command, dir, 'wt-00000030', 'do the thing', sideCommit, signal, hooks)

    // The abort completed and then ran out of time; the check after it still ran and found nothing left behind.
    expect(result).toEqual({ kind: 'conflict', files: ['f.txt'] })
    expect(hooks.reports).toEqual([])
    expect(() => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow()
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
  }, GIT_TEST_TIMEOUT_MS)

  it('reports loudly, and throws, when the MERGE_HEAD probe after a failed merge fails, aborting nothing it cannot show is its own', async () => {
    const { dir, sideCommit } = await repoWithConflictingSideBranch('dsh-merge-ownership-probe-fails-')
    const hooks = recordingHooks()
    const command = await scripted({ mergeHeadProbeAt: { 2: FAILED_128 } })

    const failure = await attemptMerge(command, dir, 'wt-00000029', 'do the thing', sideCommit, signal, hooks).catch((error: unknown) => error)

    expect(String(failure)).toContain('the merge of worktree wt-00000029 failed, and whether it left a merge in progress could not be checked')
    expect(String(failure)).toContain('the base checkout may be left mid-merge')
    expect(String(failure)).not.toContain(dir)
    expect(hooks.reports).toHaveLength(1)
    expect(hooks.reports[0]).toContain(`the merge of ${sideCommit} in "${dir}" failed, and whether it left a merge in progress could not be checked`)
    expect(hooks.reports[0]).toContain('git merge --abort')
    expect(command.commands).not.toContainEqual(['merge', '--abort'])
    expect(git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).toBe(sideCommit)
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

  it('throws that the base checkout is left mid-merge, and logs the path, when it cannot clear a MERGE_HEAD it left behind', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-stuck-')
    const hooks = recordingHooks()
    const command = await scripted({
      merge: { alongside: ['merge', '--no-ff', '--no-commit', sideCommit], result: KILLED },
      mergeAbort: FAILED_128,
    })

    const failure = await attemptMerge(command, dir, 'wt-00000014', 'do the thing', sideCommit, signal, hooks).catch((error: unknown) => error)

    expect(String(failure)).toContain(
      'the merge of worktree wt-00000014 could not be aborted: the base checkout is left mid-merge and must be aborted there with "git merge --abort"',
    )
    expect(String(failure)).not.toContain(dir)
    expect(hooks.reports).toHaveLength(1)
    expect(hooks.reports[0]).toContain(`the merge of ${sideCommit} in "${dir}" could not be aborted and is still in progress`)
    expect(hooks.reports[0]).toContain('git merge --abort')
    expect(git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).toBe(sideCommit)
  }, GIT_TEST_TIMEOUT_MS)

  it.each([
    ['stopped on conflicts', undefined],
    ['failed with a fatal exit after starting', FAILED_128],
  ])('throws that the base checkout is left mid-merge, instead of returning an outcome, when the abort does not clear a merge that %s', async (_label, exit) => {
    const { dir, sideCommit } = await repoWithConflictingSideBranch('dsh-merge-stuck-outcome-')
    const hooks = recordingHooks()
    const command = await scripted({
      ...exit === undefined ? {} : { merge: { alongside: ['merge', '--no-ff', '--no-edit', sideCommit], result: exit } },
      mergeAbort: FAILED_128,
    })

    const failure = await attemptMerge(command, dir, 'wt-00000031', 'do the thing', sideCommit, signal, hooks).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('the base checkout is left mid-merge and must be aborted there with "git merge --abort"')
    expect(String(failure)).not.toContain(dir)
    expect(hooks.reports).toHaveLength(1)
    expect(hooks.reports[0]).toContain(`in "${dir}" could not be aborted and is still in progress`)
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
  it('tells the caller the merge landed before it reads the landing commit, and returns the commit', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-landed-')
    const events: string[] = []
    const command = await scripted({})
    const hooks = recordingHooks(events)
    const originalRun = command.run.bind(command)
    // Record the order of the commit-id read relative to the landed notification.
    command.run = (args, options) => {
      if (args[0] === 'rev-list') events.push('read landing commit')
      return originalRun(args, options)
    }

    const result = await attemptMerge(command, dir, 'wt-00000018', 'do the thing', sideCommit, signal, hooks)

    expect(result).toEqual({ kind: 'merged', mergeCommit: git(dir, 'rev-parse', 'HEAD').trim() })
    expect(events).toEqual(['landed', 'read landing commit'])
  }, GIT_TEST_TIMEOUT_MS)

  it('retries a failed landing commit read on a fresh signal, so one transient failure does not hide a landed merge', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-landed-retry-')
    const command = await scripted({ failLandingCommitRead: 1 })

    const result = await attemptMerge(command, dir, 'wt-00000019', 'do the thing', sideCommit, signal, recordingHooks())

    expect(result).toEqual({ kind: 'merged', mergeCommit: git(dir, 'rev-parse', 'HEAD').trim() })
    expect(command.commands.filter(args => args[0] === 'rev-list')).toHaveLength(2)
  }, GIT_TEST_TIMEOUT_MS)

  it('still reports the merge as landed when the landing commit cannot be read at all', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-landed-unreadable-')
    const command = await scripted({ failLandingCommitRead: 2 })
    const hooks = recordingHooks()

    await expect(attemptMerge(command, dir, 'wt-00000020', 'do the thing', sideCommit, signal, hooks))
      .rejects.toThrow('git rev-list failed')

    expect(hooks.events).toEqual(['landed'])
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
  }, GIT_TEST_TIMEOUT_MS)
})

describe('attemptMerge: which commit stands for the merge', () => {
  it('names the merge commit that lists the reviewed commit as a parent, not a later HEAD that a hook created', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-attribution-hook-')
    const hook = join(dir, '.git', 'hooks', 'post-merge')
    await writeFile(hook, '#!/bin/sh\ngit commit --allow-empty -q -m "hook commit"\n')
    await chmod(hook, 0o755)

    const result = await attemptMerge(await runner(), dir, 'wt-00000032', 'do the thing', sideCommit, signal, recordingHooks())

    // HEAD is the hook's later commit; the merge commit it sits on lists the reviewed commit as its second parent.
    expect(git(dir, 'log', '-1', '--pretty=%s').trim()).toBe('hook commit')
    const mergeCommit = git(dir, 'rev-parse', 'HEAD~1').trim()
    expect(git(dir, 'rev-parse', `${mergeCommit}^2`).trim()).toBe(sideCommit)
    expect(result).toEqual({ kind: 'merged', mergeCommit })
  }, GIT_TEST_TIMEOUT_MS)

  it('names the reviewed commit itself, never a later HEAD, when it was already contained and no merge commit was created', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-attribution-contained-')
    git(dir, 'merge', '--ff-only', 'side')
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'later work')
    const head = git(dir, 'rev-parse', 'HEAD').trim()

    const result = await attemptMerge(await runner(), dir, 'wt-00000033', 'do the thing', sideCommit, signal, recordingHooks())

    expect(result).toEqual({ kind: 'merged', mergeCommit: sideCommit })
    expect(sideCommit).not.toBe(head)
    // "Already up to date": git merge exited 0 and created nothing.
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('0')
  }, GIT_TEST_TIMEOUT_MS)

  it('skips a merge on the way that does not list the reviewed commit as a parent', async () => {
    const { dir, sideCommit } = await repoWithSideBranch('dsh-merge-attribution-transitive-')
    // The reviewed commit reached main through a branch built on top of it: a merge commit exists, but it lists that
    // branch's tip as its parent, not the reviewed commit.
    git(dir, 'checkout', '-q', '-b', 'mid', sideCommit)
    await writeFile(join(dir, 'mid.txt'), 'mid\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'mid work')
    git(dir, 'checkout', '-q', 'main')
    git(dir, 'merge', '--no-ff', '--no-edit', 'mid')

    const result = await attemptMerge(await runner(), dir, 'wt-00000034', 'do the thing', sideCommit, signal, recordingHooks())

    expect(result).toEqual({ kind: 'merged', mergeCommit: sideCommit })
    expect(git(dir, 'rev-list', '--count', '--merges', 'HEAD').trim()).toBe('1')
  }, GIT_TEST_TIMEOUT_MS)
})
