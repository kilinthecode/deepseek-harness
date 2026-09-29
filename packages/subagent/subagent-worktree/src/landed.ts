/**
 * Recovery of a worktree whose merge landed but was never recorded, and the
 * removal of a merged worktree's leftovers. An accept that dies after its
 * `git merge` exits 0 but before the `merged` write leaves the record
 * `reviewing` on a dead process id while the reviewed commit is already in the
 * base checkout's history; treating that record as `open` would run a second
 * review and a second merge of work that already landed. Only a worktree that
 * still holds exactly the reviewed commit is recovered: anything newer in it
 * is work nobody reviewed, and an older commit that landed says nothing about it.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/landed
 */

import type { GitCommandResult, GitRunner } from './git.ts'
import { landedCommitOf } from './merge.ts'
import type { WorktreeLayout } from './paths.ts'
import { isStaleReviewing, updateExistingRecordAt, withoutReviewingPid } from './records.ts'
import type { StoredWorktreeRecord } from './records.ts'
import type { WorktreeVerdict } from './types.ts'
import { pathExists } from './fs-util.ts'

/** A stale `reviewing` record whose reviewed commit had already landed, now recorded `merged`. */
export interface LandedRecovery {
  /** The record as now stored: `merged`, with `mergedCommit` set to {@link mergeCommit}. */
  readonly record: StoredWorktreeRecord
  /** The verdict the merged commit was reviewed under. */
  readonly verdict: WorktreeVerdict
  /** The commit that landed the reviewed commit, as {@link landedCommitOf} defines it. */
  readonly mergeCommit: string
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
 * git's exit code for `git merge-base --is-ancestor` when the first commit is not an ancestor of the second. Any
 * other nonzero exit is git itself dying, whose answer is unknown, and is never read as "no".
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
): Promise<GitCommandResult> {
  const result = await git.run(args, { cwd, signal })
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
  const head = await decisiveRun(
    git, ['rev-parse', 'HEAD'], { what: 'rev-parse', answers: [PROBE_YES_EXIT_CODE] }, record.path, record.id, signal,
  )
  if (head.stdout.trim() !== reviewed) return false
  const status = await decisiveRun(
    git,
    ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
    { what: 'status', answers: [PROBE_YES_EXIT_CODE] },
    record.path,
    record.id,
    signal,
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
 * @param git - command runner.
 * @param layout - the repository layout the record is stored under.
 * @param record - the record as read.
 * @param signal - cancellation for the check.
 * @returns the recovery, or undefined when the record needs no recovery.
 * @throws when a check was cancelled or failed, and so has no answer: the record is then left exactly as it was,
 *   with no claim taken on it, so a later `accept` or `discard` either recovers it or fails the same way.
 */
export async function recoverLandedMerge(
  git: GitRunner, layout: WorktreeLayout, record: StoredWorktreeRecord, signal: AbortSignal,
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

  const mergeCommit = await landedCommitOf(git, record.repoRoot, verdict.commit, signal)
  // Tracked on an object: the updater runs later, under the record lock, and may find the record already moved on.
  const outcome = { recorded: false }
  const updated = await updateExistingRecordAt(layout, record.id, (current) => {
    if (!isStaleReviewing(current)) return current
    outcome.recorded = true
    return { ...withoutReviewingPid(current), state: 'merged', mergedCommit: mergeCommit }
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
 * @throws when a git command that had something to remove fails.
 */
export async function sweepWorktree(git: GitRunner, record: StoredWorktreeRecord, signalFor: () => AbortSignal): Promise<void> {
  const options = (): { cwd: string; signal: AbortSignal } => ({ cwd: record.repoRoot, signal: signalFor() })
  if (await pathExists(record.path)) {
    await git.expect(['worktree', 'remove', '--force', record.path], 'git worktree remove', options())
  }
  await git.expect(['worktree', 'prune'], 'git worktree prune', options())
  const branch = await git.run(['rev-parse', '-q', '--verify', `refs/heads/${record.branch}`], options())
  if (branch.exitCode === 0) {
    await git.expect(['branch', '-D', record.branch], 'git branch -D', options())
  }
}
