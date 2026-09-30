/**
 * Recovery of a worktree whose merge landed but was never recorded, and the
 * removal of a merged worktree's leftovers. An accept that dies after its
 * `git merge` exits 0 but before the `merged` write leaves the record
 * `reviewing` on a dead process id while the reviewed commit is already in the
 * base checkout's history; treating that record as `open` would run a second
 * review and a second merge of work that already landed. Only a worktree that
 * still holds exactly the reviewed commit is recovered: anything newer in it
 * is work nobody reviewed, and an older commit that landed says nothing about it.
 * Once those checks have established that the reviewed commit landed, the record
 * is closed as `merged` whatever the read of the commit that landed it does: the
 * read is retried once on a fresh signal, as the live merge path retries it, and
 * a read that fails twice closes the record without a `mergedCommit` and is
 * logged, because a record left `reviewing` would make every later `accept` fail
 * the same way.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/landed
 */

import type { GitCommandResult, GitRunner } from './git.ts'
import { readLandedCommit } from './merge.ts'
import type { WorktreeLayout } from './paths.ts'
import { isStaleReviewing, updateExistingRecordAt, withoutReviewingPid } from './records.ts'
import type { StoredWorktreeRecord } from './records.ts'
import type { WorktreeVerdict } from './types.ts'
import { pathExists } from './fs-util.ts'
import { worktreeGitDirOf } from './worktree-gitdir.ts'

/** A stale `reviewing` record whose reviewed commit had already landed, now recorded `merged`. */
export interface LandedRecovery {
  /** The record as now stored: `merged`, with `mergedCommit` set to {@link mergeCommit} when that read succeeded. */
  readonly record: StoredWorktreeRecord
  /** The verdict the merged commit was reviewed under. */
  readonly verdict: WorktreeVerdict
  /**
   * The commit that landed the reviewed commit, as the landing-commit read defines it, or `undefined` when reading it
   * failed on both signals: the record is then `merged` without a `mergedCommit`, which beats leaving it `reviewing`
   * for every later `accept` to fail on.
   */
  readonly mergeCommit: string | undefined
}

/** One deciding probe: its git subcommand, and the exit codes that are answers rather than failures. */
interface DecisiveProbe {
  /** The git subcommand, named in the thrown message. */
  readonly what: string
  /** Every exit code this probe answers in. */
  readonly answers: readonly number[]
}

/** git's exit code for a probe that answered "yes". */
const PROBE_YES_EXIT_CODE = 0

/**
 * git's exit code for `git merge-base --is-ancestor` when the first commit is not an ancestor of the second, and for
 * `git rev-parse -q --verify` when the ref does not exist. Any other nonzero exit is git itself dying, whose answer
 * is unknown, and is never read as "no".
 */
const PROBE_NO_EXIT_CODE = 1

/**
 * Run a git command whose answer decides whether a merge landed, and take only the exit codes that probe answers
 * in. A cancelled command has no exit code, and a command that exits with a code outside its documented answers
 * (128 from `git merge-base --is-ancestor`, or any failure of `rev-parse` or `status`) has no answer either: both
 * are refused instead of being read as "no", which would let a crashed accept's unreviewed work be removed.
 * @param probe - the subcommand's name, which the thrown message uses, and the exit codes it answers in.
 * @throws when the command was cancelled or exited with a code outside `probe.answers`. The message names the
 *   worktree id, never a path.
 */
async function decisiveRun(
  git: GitRunner, args: readonly string[], probe: DecisiveProbe, cwd: string, id: string, signal: AbortSignal,
  worktreeGitDir?: string,
): Promise<GitCommandResult> {
  const result = await git.run(args, { cwd, signal, worktreeGitDir })
  if (result.exitCode === null) {
    throw new Error(`subagent-worktree: could not check whether worktree ${id} already merged (git ${probe.what} was cancelled)`)
  }
  if (!probe.answers.includes(result.exitCode)) {
    throw new Error(
      `subagent-worktree: could not check whether worktree ${id} already merged (git ${probe.what} exited ${String(result.exitCode)})`,
    )
  }
  return result
}

/**
 * Whether the worktree still holds exactly the reviewed commit: its directory exists, its `HEAD` is that commit,
 * and nothing in it is modified, staged, or untracked. The status read is asked for what `git add -A` would stage
 * — every untracked file, and submodule changes whatever `status.showUntrackedFiles`, `status.ignoreSubmodules`, or
 * `submodule.<name>.ignore` say — because the user's git config must not hide work nobody reviewed. A worktree that
 * holds more holds work nobody reviewed.
 * @throws when a probe was cancelled or failed, so its answer is unknown.
 */
async function worktreeHoldsOnly(git: GitRunner, record: StoredWorktreeRecord, reviewed: string, signal: AbortSignal): Promise<boolean> {
  if (!await pathExists(record.path)) return false
  // The worktree is the worker's to write, so git is confined to its administrative directory from the shared git
  // directory (see `confinedWorktreeArgs`) rather than reading what the worktree says.
  const worktreeGitDir = await worktreeGitDirOf(git, record, signal)
  const head = await decisiveRun(
    git, ['rev-parse', 'HEAD'], { what: 'rev-parse', answers: [PROBE_YES_EXIT_CODE] }, record.path, record.id, signal, worktreeGitDir,
  )
  if (head.stdout.trim() !== reviewed) return false
  const status = await decisiveRun(
    git,
    ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
    { what: 'status', answers: [PROBE_YES_EXIT_CODE] },
    record.path,
    record.id,
    signal,
    worktreeGitDir,
  )
  return status.stdout.trim() === ''
}

/**
 * Before a stale `reviewing` record is treated as `open`, check whether the
 * commit its worktree was reviewed at has already landed, and if so record
 * `merged` instead. That takes a passing verdict, a worktree that still holds
 * exactly the reviewed commit (its `HEAD` is that commit and it is clean), and
 * that commit being an ancestor of the merge target's `HEAD`
 * (`git merge-base --is-ancestor`). Any other record is left for the caller's
 * ordinary handling, which reviews whatever the worktree holds now.
 *
 * Once those checks have established that the reviewed commit landed, the
 * record is closed as `merged` even when the commit that landed it cannot be
 * read: the merge already happened, and a record left `reviewing` would fail
 * every later `accept` on a read that may never succeed. That read is tried on
 * the caller's signal and retried once on a fresh one, as the live merge path
 * retries it; a read that fails twice is logged, and the recovery reports no
 * {@link LandedRecovery.mergeCommit}.
 * @param git - command runner.
 * @param layout - the repository layout the record is stored under.
 * @param record - the record as read.
 * @param signal - cancellation for the checks and for the first landing-commit read, whose retry runs on a fresh
 *   signal so the caller's own cancellation cannot lose a commit id for good.
 * @param log - receives the host-log message of a landing-commit read that failed; the message names the absolute
 *   path and the commit, which the caller's own error then does not.
 * @returns the recovery, or undefined when the record needs no recovery.
 * @throws when a check was cancelled or failed, and so has no answer: the record is then left exactly as it was,
 *   with no claim taken on it, so a later `accept` or `discard` either recovers it or fails the same way.
 */
export async function recoverLandedMerge(
  git: GitRunner, layout: WorktreeLayout, record: StoredWorktreeRecord, signal: AbortSignal,
  log: (message: string) => void,
): Promise<LandedRecovery | undefined> {
  const verdict = record.lastVerdict
  if (verdict === undefined || verdict.verdict !== 'pass' || !isStaleReviewing(record)) return undefined
  const ancestor = await decisiveRun(
    git,
    ['merge-base', '--is-ancestor', verdict.commit, 'HEAD'],
    { what: 'merge-base', answers: [PROBE_YES_EXIT_CODE, PROBE_NO_EXIT_CODE] },
    record.repoRoot,
    record.id,
    signal,
  )
  if (ancestor.exitCode === PROBE_NO_EXIT_CODE) return undefined
  if (!await worktreeHoldsOnly(git, record, verdict.commit, signal)) return undefined

  let mergeCommit: string | undefined
  try {
    // Retried once on a fresh signal, exactly as the live merge path reads it: the caller's signal is often why this
    // first read failed, and a merge that already landed must not lose its commit id for good.
    mergeCommit = await readLandedCommit(git, record.repoRoot, verdict.commit, signal)
  } catch (error) {
    // The reviewed commit landed, so the record is closed either way: reading which commit landed it is what failed.
    log(
      `subagent-worktree: worktree ${record.id} already landed in "${record.repoRoot}" (commit ${verdict.commit}), but `
      + `the commit that landed it could not be read: ${String(error)}`,
    )
    mergeCommit = undefined
  }
  // Tracked on an object: the updater runs later, under the record lock, and may find the record already moved on.
  const outcome = { recorded: false }
  const updated = await updateExistingRecordAt(layout, record.id, (current) => {
    if (!isStaleReviewing(current)) return current
    outcome.recorded = true
    return {
      ...withoutReviewingPid(current),
      state: 'merged',
      ...mergeCommit === undefined ? {} : { mergedCommit: mergeCommit },
    }
  })
  return outcome.recorded ? { record: updated, verdict, mergeCommit } : undefined
}

/**
 * Remove a worktree's directory, its git registration, and its branch, each
 * only if it is still there, so a sweep that was interrupted, or a worktree
 * removed by hand, can be finished by running it again.
 * @param git - command runner.
 * @param record - the record whose worktree and branch are removed.
 * @param signalFor - the cancellation signal of each git command, asked for once per command. A caller sweeping
 *   after a cancellable operation of its own passes that operation's signal; a caller cleaning up after the
 *   operation ended passes a source of fresh signals, so one command that timed out does not abort the next.
 * @throws when a git command that had something to remove fails, or the branch probe answered with neither of its
 *   documented exit codes: whether the branch still had to be removed is then unknown, and reporting a discard whose
 *   branch may still exist as a success would hide it.
 */
export async function sweepWorktree(git: GitRunner, record: StoredWorktreeRecord, signalFor: () => AbortSignal): Promise<void> {
  const options = (): { cwd: string; signal: AbortSignal } => ({ cwd: record.repoRoot, signal: signalFor() })
  if (await pathExists(record.path)) {
    await git.expect(['worktree', 'remove', '--force', record.path], 'git worktree remove', options())
  }
  await git.expect(['worktree', 'prune'], 'git worktree prune', options())
  const branch = await git.run(['rev-parse', '-q', '--verify', `refs/heads/${record.branch}`], options())
  if (branch.exitCode === PROBE_NO_EXIT_CODE) return
  // Only the probe's own answers may skip the deletion: a cancelled probe, or git dying with 128, says nothing about
  // whether the branch exists, and reading it as "already gone" would report the sweep as done with the branch left.
  if (branch.exitCode !== PROBE_YES_EXIT_CODE) {
    throw new Error(
      `subagent-worktree: could not check whether worktree ${record.id}'s branch still exists `
      + `(git rev-parse ${branch.exitCode === null ? 'was cancelled' : `exited ${String(branch.exitCode)}`})`,
    )
  }
  await git.expect(['branch', '-D', record.branch], 'git branch -D', options())
}
