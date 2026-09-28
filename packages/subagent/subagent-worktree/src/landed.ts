/**
 * Recovery of a worktree whose merge landed but was never recorded, and the
 * removal of a merged worktree's leftovers. An accept that dies after its
 * `git merge` exits 0 but before the `merged` write leaves the record
 * `reviewing` on a dead process id while the reviewed commit is already in the
 * base checkout's history; treating that record as `open` would run a second
 * review and a second merge of work that already landed.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/landed
 */

import type { GitRunner } from './git.ts'
import type { WorktreeLayout } from './paths.ts'
import { isStaleReviewing, updateExistingRecordAt, withoutReviewingPid } from './records.ts'
import type { StoredWorktreeRecord } from './records.ts'
import type { WorktreeVerdict } from './types.ts'
import { pathExists } from './fs-util.ts'

/** A stale `reviewing` record whose reviewed commit had already landed, now recorded `merged`. */
export interface LandedRecovery {
  /** The record as now stored: `merged`, with its merge commit when one could be found. */
  readonly record: StoredWorktreeRecord
  /** The verdict the merged commit was reviewed under. */
  readonly verdict: WorktreeVerdict
}

/**
 * The earliest merge commit in the base checkout that brought `reviewed` in,
 * or undefined when no merge commit lies between them (the commit landed
 * without one).
 */
async function firstMergeContaining(git: GitRunner, repoRoot: string, reviewed: string, signal: AbortSignal): Promise<string | undefined> {
  const merges = await git.expectComplete(
    ['rev-list', '--ancestry-path', '--merges', '--reverse', `${reviewed}..HEAD`], 'git rev-list', { cwd: repoRoot, signal },
  )
  return merges.stdout.split('\n').find(line => line.length > 0)
}

/**
 * Before a stale `reviewing` record is treated as `open`, check whether its
 * reviewed commit is already an ancestor of the merge target's `HEAD`
 * (`git merge-base --is-ancestor`), and if so record `merged` instead. Records
 * that are not stale, that never had a verdict, or whose commit is not an
 * ancestor (or no longer exists) are left for the caller's ordinary handling.
 * @param git - command runner.
 * @param layout - the repository layout the record is stored under.
 * @param record - the record as read.
 * @param signal - cancellation for the check.
 * @returns the recovery, or undefined when the record needs no recovery.
 * @throws when the ancestry check was cancelled and so has no answer.
 */
export async function recoverLandedMerge(
  git: GitRunner, layout: WorktreeLayout, record: StoredWorktreeRecord, signal: AbortSignal,
): Promise<LandedRecovery | undefined> {
  const verdict = record.lastVerdict
  if (verdict === undefined || !isStaleReviewing(record)) return undefined
  const ancestor = await git.run(['merge-base', '--is-ancestor', verdict.commit, 'HEAD'], { cwd: record.repoRoot, signal })
  if (ancestor.exitCode === null) {
    throw new Error(`subagent-worktree: could not check whether worktree ${record.id} already merged (git merge-base was cancelled)`)
  }
  if (ancestor.exitCode !== 0) return undefined

  const mergeCommit = await firstMergeContaining(git, record.repoRoot, verdict.commit, signal)
  // Tracked on an object: the updater runs later, under the record lock, and may find the record already moved on.
  const outcome = { recorded: false }
  const updated = await updateExistingRecordAt(layout, record.id, (current) => {
    if (!isStaleReviewing(current)) return current
    outcome.recorded = true
    return { ...withoutReviewingPid(current), state: 'merged', ...mergeCommit === undefined ? {} : { mergedCommit: mergeCommit } }
  })
  return outcome.recorded ? { record: updated, verdict } : undefined
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
