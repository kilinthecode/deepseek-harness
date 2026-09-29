/**
 * Merges a reviewed commit into the base checkout, classifying a failed merge
 * as a conflict (aborted, branch kept), a refusal (blocked, nothing changed),
 * or an error (aborted if it started, then thrown). `--no-ff` is required:
 * parallel workers branch from the same base, so after the first merge every
 * later branch can no longer fast-forward.
 *
 * Only a merge this call started is ever aborted: the base checkout is the
 * user's working tree, and a `MERGE_HEAD` this call did not create (the user's
 * own merge, or another tool's) is left exactly as found. A `git merge` that
 * exits 128 never started one — git reaches 128 only through `die()`, before
 * the merge changes the checkout — so a `MERGE_HEAD` seen then belongs to
 * another operation even when it names the commit this call was merging.
 * Everything after the merge command fails runs on a fresh signal, because the
 * failure is often the caller's own cancellation and a command started on an
 * aborted signal never runs.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/merge
 */

import { DIAGNOSTIC_TAIL_CHARS, tailChars } from './bounds.ts'
import { cleanupSignal } from './git.ts'
import type { GitRunner } from './git.ts'

/**
 * Outcome of one merge attempt into the base checkout. A `merged` outcome names the commit that landed the
 * reviewed commit, as {@link landedCommitOf} defines it.
 */
export type MergeAttemptResult =
  | { readonly kind: 'merged'; readonly mergeCommit: string }
  | { readonly kind: 'conflict'; readonly files: readonly string[] }
  | { readonly kind: 'blocked'; readonly reason: string }

/** Callbacks from one merge attempt to its caller. */
export interface MergeAttemptHooks {
  /**
   * Called after the pre-merge probes pass and immediately before `git merge` starts, for a last check the caller
   * cannot make earlier. A throw stops the attempt before any merge state exists.
   */
  readonly beforeMerge: () => void
  /**
   * Called the instant `git merge` exits 0, before any follow-up git command, so the caller knows the merge
   * landed even if reading its commit id then fails.
   */
  readonly onLanded: () => void
  /**
   * Reports, for the host log, a merge this call started that may be left in progress. The message names the
   * absolute base checkout path; the error thrown right after it says the same to the caller without a path.
   */
  readonly report: (message: string) => void
}

/**
 * git's exit code for a `git symbolic-ref -q` or `git rev-parse -q --verify`
 * probe whose answer is "no". Any other nonzero exit, or none (the process was
 * cancelled), means the probe itself failed and its answer is unknown.
 */
const PROBE_NO_EXIT_CODE = 1

/** git's exit code for a merge that stopped on conflicts. */
const MERGE_CONFLICT_EXIT_CODE = 1

/**
 * git's exit code for a command that died instead of running. `builtin/merge.c` reaches it only through `die()`,
 * which runs before the merge touches the worktree, the index, or `MERGE_HEAD`: the case a base checkout with a
 * merge already in progress produces, `die("You have not concluded your merge (MERGE_HEAD exists).")`.
 */
const GIT_DIED_EXIT_CODE = 128

/**
 * The commit `MERGE_HEAD` names in the base checkout, when a merge is in progress.
 * @throws when the probe itself failed, so the caller never reads an unknown answer as "no merge in progress".
 */
async function readMergeHead(git: GitRunner, repoRoot: string, signal: AbortSignal): Promise<string | undefined> {
  const result = await git.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repoRoot, signal })
  if (result.exitCode === 0) return result.stdout.trim()
  if (result.exitCode === PROBE_NO_EXIT_CODE) return undefined
  throw new Error(`subagent-worktree: could not check the base checkout for a merge in progress (git rev-parse exited ${String(result.exitCode)})`)
}

/**
 * Whether the base checkout's `HEAD` is detached, so a merge there would update no branch.
 * @throws when the probe itself failed (a cancelled probe has no answer), rather than guessing.
 */
async function hasDetachedHead(git: GitRunner, repoRoot: string, signal: AbortSignal): Promise<boolean> {
  const result = await git.run(['symbolic-ref', '-q', 'HEAD'], { cwd: repoRoot, signal })
  if (result.exitCode === 0) return false
  if (result.exitCode === PROBE_NO_EXIT_CODE) return true
  throw new Error(`subagent-worktree: could not read HEAD of the base checkout (git symbolic-ref exited ${String(result.exitCode)})`)
}

/**
 * The error for a merge this call started that is still in progress in the base checkout. The host log gets the
 * absolute path; the error, which reaches the model, says the checkout is left mid-merge and how to clear it.
 */
function mergeSurvivedAbort(hooks: MergeAttemptHooks, repoRoot: string, id: string, commit: string): Error {
  hooks.report(
    `subagent-worktree: the merge of ${commit} in "${repoRoot}" could not be aborted and is still in progress; `
    + 'run "git merge --abort" there before merging anything else',
  )
  return new Error(
    `subagent-worktree: the merge of worktree ${id} could not be aborted: the base checkout is left mid-merge and must be `
    + 'aborted there with "git merge --abort" before anything else is merged',
  )
}

/**
 * The error for this call's own merge that was aborted while another operation started its own merge in the base
 * checkout in the meantime. That `MERGE_HEAD` is not this call's, so it must not be aborted: the abort worked, and
 * the caller is told the checkout has another merge to leave alone. The host log gets the absolute path and the
 * commit the other merge is of; the error, which reaches the model, names neither.
 */
function mergeReplacedAfterAbort(
  hooks: MergeAttemptHooks, repoRoot: string, id: string, commit: string, foreign: string,
): Error {
  hooks.report(
    `subagent-worktree: the merge of ${commit} in "${repoRoot}" was aborted, and a merge of ${foreign} is now `
    + 'in progress there; leave that one to whoever started it',
  )
  return new Error(
    `subagent-worktree: the merge of worktree ${id} was aborted, but another merge is now in progress in the base `
    + 'checkout; that merge belongs to another operation and must not be aborted here',
  )
}

/**
 * The error for a merge this call started whose state could not be determined, so it may be in progress. The host
 * log gets the absolute path and the cause; the error, which reaches the model, names neither.
 * @param situation - what could not be determined, as a clause that follows "the merge".
 */
function mergeStateUnknown(
  hooks: MergeAttemptHooks, repoRoot: string, id: string, commit: string, situation: string, cause: unknown,
): Error {
  hooks.report(
    `subagent-worktree: the merge of ${commit} in "${repoRoot}" ${situation} (${String(cause)}), so it may still be in progress; `
    + 'run "git status" there, and "git merge --abort" if it shows a merge',
  )
  return new Error(
    `subagent-worktree: the merge of worktree ${id} ${situation}: the base checkout may be left mid-merge; check it, `
    + 'and abort the merge there with "git merge --abort" if one is in progress',
  )
}

/**
 * The commit `MERGE_HEAD` names right after this call's `git merge` failed.
 * @throws when the probe itself fails: a merge this call started may then be in progress and unnoticed, which is
 *   reported and thrown as {@link mergeStateUnknown}.
 */
async function readMergeHeadAfterFailure(
  git: GitRunner, repoRoot: string, id: string, commit: string, hooks: MergeAttemptHooks,
): Promise<string | undefined> {
  try {
    return await readMergeHead(git, repoRoot, cleanupSignal())
  } catch (error) {
    throw mergeStateUnknown(hooks, repoRoot, id, commit, 'failed, and whether it left a merge in progress could not be checked', error)
  }
}

/**
 * Abort the merge this call started, which the caller has already established is this call's own (`MERGE_HEAD`
 * names the commit this call merged), and check that it is gone. The abort and the check each run on their own
 * fresh signal, so an abort that timed out does not stop the check.
 * @throws when the merge survives the abort, when a `MERGE_HEAD` naming another commit took its place (that merge
 *   is not this call's to abort, so no second abort runs), or when the abort or the check failed and so left the
 *   state unknown but possibly this call's: the base checkout is then left mid-merge, and no classification of the
 *   failed merge can stand in for saying so.
 */
async function abortOwnMerge(git: GitRunner, repoRoot: string, id: string, commit: string, hooks: MergeAttemptHooks): Promise<void> {
  let remaining: string | undefined
  try {
    await git.run(['merge', '--abort'], { cwd: repoRoot, signal: cleanupSignal() })
    remaining = await readMergeHead(git, repoRoot, cleanupSignal())
  } catch (error) {
    throw mergeStateUnknown(hooks, repoRoot, id, commit, 'could not be confirmed aborted', error)
  }
  if (remaining === undefined) return
  // Another operation started its own merge between the abort and this check: that `MERGE_HEAD` is not this call's,
  // so it is reported and thrown, never aborted.
  if (remaining !== commit) throw mergeReplacedAfterAbort(hooks, repoRoot, id, commit, remaining)
  throw mergeSurvivedAbort(hooks, repoRoot, id, commit)
}

/** The paths git lists as unmerged in the base checkout. */
async function unmergedPaths(git: GitRunner, repoRoot: string, signal: AbortSignal): Promise<string[]> {
  const unmerged = await git.expectComplete(['diff', '--name-only', '--diff-filter=U'], 'git diff --diff-filter=U', { cwd: repoRoot, signal })
  return unmerged.stdout.split('\n').filter(line => line.length > 0)
}

/** The paths that stopped a merge on conflicts, or the failure that kept them from being read; never throws. */
async function readConflicts(git: GitRunner, repoRoot: string): Promise<{ files: string[] } | { failure: unknown }> {
  try {
    return { files: await unmergedPaths(git, repoRoot, cleanupSignal()) }
  } catch (failure) {
    return { failure }
  }
}

/**
 * The commit that landed a reviewed commit in the base checkout's history: the earliest merge commit on the way
 * from `reviewed` to `HEAD` that lists `reviewed` as a parent, which is the merge commit `git merge --no-ff`
 * created. When no merge commit lists it (it was fast-forwarded in, or `git merge` found it already contained
 * and created nothing), the reviewed commit is its own landing commit. It is never `HEAD` as such, which may
 * be a later commit that has nothing to do with the reviewed one.
 *
 * The listing is read newest-first, so a history longer than the command's output cap — after a landing merge,
 * every later merge on the way is such a commit, so the listing grows with every merge — loses its newest lines
 * and keeps the oldest ones, which are the merges that can answer this. The reversed listing this used to read
 * would have lost the answer itself to that cut, and `--max-count` cannot bound it either, because git applies
 * the limit before reversing.
 * @param git - command runner.
 * @param repoRoot - the base checkout's top-level directory.
 * @param reviewed - the reviewed commit, which is an ancestor of the base checkout's `HEAD`.
 * @param signal - cancellation for the read.
 * @returns the landing commit's full id.
 * @throws when `git rev-list` failed: a history longer than its output cap is not a failure.
 */
export async function landedCommitOf(git: GitRunner, repoRoot: string, reviewed: string, signal: AbortSignal): Promise<string> {
  const merges = await git.expectTruncatable(
    ['rev-list', '--ancestry-path', '--merges', '--parents', `${reviewed}..HEAD`], 'git rev-list', { cwd: repoRoot, signal },
  )
  // A truncated read kept a suffix of the listing, whose first line may have lost its head to the cut and is no
  // commit line at all, so it is dropped. The last line that lists the reviewed commit is the earliest merge.
  const lines = merges.stdout.split('\n').slice(merges.stdoutLossy ? 1 : 0)
  let landed = reviewed
  for (const line of lines) {
    const [merge = '', ...parents] = line.split(' ')
    if (merge !== '' && parents.includes(reviewed)) landed = merge
  }
  return landed
}

/**
 * Read the landing commit right after a successful merge. A cancellation or a transient failure must not hide
 * a merge that already landed, so a failed read is retried once on a fresh signal.
 */
async function readLandedCommit(git: GitRunner, repoRoot: string, reviewed: string, signal: AbortSignal): Promise<string> {
  try {
    return await landedCommitOf(git, repoRoot, reviewed, signal)
  } catch {
    return await landedCommitOf(git, repoRoot, reviewed, cleanupSignal())
  }
}

/**
 * Classify a `git merge` that did not exit 0, aborting only a merge this call started. A merge that died (exit 128)
 * is never this call's: `builtin/merge.c` reaches that exit only through `die()`, which runs before the merge
 * changes anything, so a `MERGE_HEAD` seen then was started by another operation, even when it names the commit
 * this call was merging. Every other nonzero exit is classified by the merge state, because git's exit codes cannot
 * otherwise separate a refusal from an error (an untracked file in the way is also refused with a nonzero exit).
 * @throws when the merge was killed, or failed after starting without stopping on conflicts, or a merge this
 *   call started could not be aborted or shown to be gone: the base checkout is then left mid-merge.
 */
async function classifyFailedMerge(
  git: GitRunner,
  repoRoot: string,
  id: string,
  commit: string,
  failed: { exitCode: number | null; stderr: string },
  hooks: MergeAttemptHooks,
): Promise<MergeAttemptResult> {
  const mergeHead = await readMergeHeadAfterFailure(git, repoRoot, id, commit, hooks)
  if (failed.exitCode === null) {
    if (mergeHead === commit) await abortOwnMerge(git, repoRoot, id, commit, hooks)
    throw new Error(`subagent-worktree: merge of worktree ${id} was killed before it finished`)
  }
  if (failed.exitCode === GIT_DIED_EXIT_CODE) {
    // git changed nothing, so there is no merge of this call's to undo: aborting here would destroy the merge of
    // another operation that is already in progress, whatever `MERGE_HEAD` now names.
    if (mergeHead !== undefined) {
      return { kind: 'blocked', reason: 'the base checkout has a merge in progress (MERGE_HEAD exists), and git refused this merge before starting it' }
    }
    // A refusal with no MERGE_HEAD can still be about unmerged paths another operation left behind (a conflicted
    // cherry-pick is refused with the same exit code), and those paths name the state better than git's message.
    if ((await unmergedPaths(git, repoRoot, cleanupSignal())).length > 0) {
      return { kind: 'blocked', reason: 'the base checkout has conflicts this accept did not create' }
    }
    return { kind: 'blocked', reason: tailChars(failed.stderr.trim(), DIAGNOSTIC_TAIL_CHARS) }
  }
  if (mergeHead === commit) {
    // Only a merge that stopped with the conflict exit code can report conflicts, and the abort discards the unmerged
    // paths that outcome names, so that one case reads them first; a failed read never skips the abort. Every other
    // failed exit needs no paths and is aborted before any further probe runs.
    const conflicts = failed.exitCode === MERGE_CONFLICT_EXIT_CODE ? await readConflicts(git, repoRoot) : undefined
    await abortOwnMerge(git, repoRoot, id, commit, hooks)
    if (conflicts !== undefined && 'failure' in conflicts) {
      throw new Error(
        `subagent-worktree: merge of worktree ${id} stopped and was aborted, but its conflicting paths could not be read: ${String(conflicts.failure)}`,
        { cause: conflicts.failure },
      )
    }
    if (conflicts !== undefined && conflicts.files.length > 0) return { kind: 'conflict', files: conflicts.files }
    throw new Error(
      `subagent-worktree: merge of worktree ${id} failed unexpectedly after starting: ${tailChars(failed.stderr.trim(), DIAGNOSTIC_TAIL_CHARS)}`,
    )
  }
  if (mergeHead !== undefined || (await unmergedPaths(git, repoRoot, cleanupSignal())).length > 0) {
    return { kind: 'blocked', reason: 'the base checkout has conflicts this accept did not create' }
  }
  return { kind: 'blocked', reason: tailChars(failed.stderr.trim(), DIAGNOSTIC_TAIL_CHARS) }
}

/**
 * Attempt `git merge --no-ff --no-edit` of one reviewed commit into the base
 * checkout.
 *
 * Before starting, refuses as `blocked` — without running `git merge` at all —
 * when the base checkout already has an operation in progress (`MERGE_HEAD`
 * exists) or its `HEAD` is detached. After this call's own `git merge` fails,
 * the merge state decides: a merge that died (exit 128, which git reaches only
 * from `die()`, before it starts — another operation's merge already in
 * progress is the case in point) is `blocked` with nothing aborted, because
 * whatever `MERGE_HEAD` then holds is not this call's; a merge this call
 * started that stopped on conflicts is aborted and reported as `conflict`; one
 * that was killed, or failed after starting without conflicts, is aborted and
 * thrown; conflicts or a `MERGE_HEAD` this call did not create are `blocked`
 * and left untouched; a clean refusal that started no merge is `blocked` with
 * git's message.
 * @param git - command runner.
 * @param repoRoot - the base checkout's top-level directory.
 * @param id - the worktree id, named in the merge commit message.
 * @param label - the worktree's display label, named in the merge commit message.
 * @param commit - the reviewed commit to merge, as a full commit id.
 * @param signal - cancellation for the whole accept operation.
 * @param hooks - last-moment check, landed notification, and operator reports.
 * @returns the merge outcome; a merged one names {@link landedCommitOf} of the reviewed commit.
 * @throws when a pre-merge probe or `hooks.beforeMerge` failed, this call's merge was killed or failed after
 *   starting, a merge this call started could not be aborted or shown to be gone (the base checkout is then left
 *   mid-merge, and the error says so), another merge took that merge's place after the abort (thrown, with that
 *   other merge left exactly as found), or the landing commit could not be read after a successful merge
 *   (`hooks.onLanded` has then already been called).
 */
export async function attemptMerge(
  git: GitRunner,
  repoRoot: string,
  id: string,
  label: string,
  commit: string,
  signal: AbortSignal,
  hooks: MergeAttemptHooks,
): Promise<MergeAttemptResult> {
  if (await readMergeHead(git, repoRoot, signal) !== undefined) {
    return { kind: 'blocked', reason: 'the base checkout already has a merge in progress (MERGE_HEAD exists)' }
  }
  if (await hasDetachedHead(git, repoRoot, signal)) {
    return { kind: 'blocked', reason: 'the base checkout HEAD is detached; a merge there would update no branch' }
  }

  hooks.beforeMerge()
  const message = `Merge worktree ${id}: ${label}`
  const result = await git.run(['merge', '--no-ff', '--no-edit', '-m', message, commit], { cwd: repoRoot, signal })
  if (result.exitCode === 0) {
    hooks.onLanded()
    return { kind: 'merged', mergeCommit: await readLandedCommit(git, repoRoot, commit, signal) }
  }
  return classifyFailedMerge(git, repoRoot, id, commit, result, hooks)
}
