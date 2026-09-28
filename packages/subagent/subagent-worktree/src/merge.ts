/**
 * Merges a reviewed commit into the base checkout, classifying a failed merge
 * as a conflict (aborted, branch kept), a refusal (blocked, nothing changed),
 * or an error (aborted if it started, then thrown). `--no-ff` is required:
 * parallel workers branch from the same base, so after the first merge every
 * later branch can no longer fast-forward.
 *
 * Only a merge this call started is ever aborted: the base checkout is the
 * user's working tree, and a `MERGE_HEAD` this call did not create (the user's
 * own merge, or another tool's) is left exactly as found. Everything after the
 * merge command fails runs on a fresh signal, because the failure is often the
 * caller's own cancellation and a command started on an aborted signal never
 * runs.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/merge
 */

import { DIAGNOSTIC_TAIL_CHARS, tailChars } from './bounds.ts'
import { cleanupSignal } from './git.ts'
import type { GitRunner } from './git.ts'

/** Outcome of one merge attempt into the base checkout. */
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
  /** Reports a condition an operator must fix by hand, such as a merge in progress this call could not abort. */
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
 * The commit `MERGE_HEAD` names right after this call's `git merge` failed. When the probe itself fails, a merge
 * this call started may be in progress and unnoticed, so that is reported before the probe's error propagates.
 */
async function readMergeHeadAfterFailure(
  git: GitRunner, repoRoot: string, commit: string, hooks: MergeAttemptHooks,
): Promise<string | undefined> {
  try {
    return await readMergeHead(git, repoRoot, cleanupSignal())
  } catch (error) {
    hooks.report(
      `subagent-worktree: after the merge of ${commit} in "${repoRoot}" failed, the base checkout could not be checked for a merge `
      + `left in progress (${String(error)}); run "git status" there, and "git merge --abort" if it shows a merge`,
    )
    throw error
  }
}

/**
 * Abort the merge this call started, which the caller has already established is this call's own (`MERGE_HEAD`
 * names the commit this call merged), and check that it is gone. A merge that survives the abort, and an abort
 * or check that failed and so left the state unknown but possibly this call's, are both reported.
 */
async function abortOwnMerge(git: GitRunner, repoRoot: string, commit: string, hooks: MergeAttemptHooks): Promise<void> {
  const signal = cleanupSignal()
  try {
    await git.run(['merge', '--abort'], { cwd: repoRoot, signal })
    if (await readMergeHead(git, repoRoot, signal) === undefined) return
    hooks.report(
      `subagent-worktree: the merge of ${commit} in "${repoRoot}" could not be aborted and is still in progress; `
      + 'run "git merge --abort" there before merging anything else',
    )
  } catch (error) {
    hooks.report(
      `subagent-worktree: the merge of ${commit} in "${repoRoot}" could not be confirmed aborted (${String(error)}), so it may still `
      + 'be in progress; run "git status" there, and "git merge --abort" if it shows a merge',
    )
  }
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
 * Read the merge commit id right after a successful merge. A cancellation or a transient failure must not hide
 * a merge that already landed, so a failed read is retried once on a fresh signal.
 */
async function readMergeCommit(git: GitRunner, repoRoot: string, signal: AbortSignal): Promise<string> {
  try {
    return (await git.expectComplete(['rev-parse', 'HEAD'], 'git rev-parse', { cwd: repoRoot, signal })).stdout.trim()
  } catch {
    return (await git.expectComplete(['rev-parse', 'HEAD'], 'git rev-parse', { cwd: repoRoot, signal: cleanupSignal() })).stdout.trim()
  }
}

/**
 * Classify a `git merge` that did not exit 0, aborting only a merge this call started. git's exit codes cannot
 * separate a refusal from an error (an untracked file in the way exits 128), so the merge state decides.
 * @throws when the merge was killed, or failed after starting without stopping on conflicts.
 */
async function classifyFailedMerge(
  git: GitRunner,
  repoRoot: string,
  id: string,
  commit: string,
  failed: { exitCode: number | null; stderr: string },
  hooks: MergeAttemptHooks,
): Promise<MergeAttemptResult> {
  const mergeHead = await readMergeHeadAfterFailure(git, repoRoot, commit, hooks)
  if (failed.exitCode === null) {
    if (mergeHead === commit) await abortOwnMerge(git, repoRoot, commit, hooks)
    throw new Error(`subagent-worktree: merge of worktree ${id} was killed before it finished`)
  }
  if (mergeHead === commit) {
    // Only a merge that stopped with the conflict exit code can report conflicts, and the abort discards the unmerged
    // paths that outcome names, so that one case reads them first; a failed read never skips the abort. Every other
    // failed exit needs no paths and is aborted before any further probe runs.
    const conflicts = failed.exitCode === MERGE_CONFLICT_EXIT_CODE ? await readConflicts(git, repoRoot) : undefined
    await abortOwnMerge(git, repoRoot, commit, hooks)
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
 * the merge state decides: a merge this call started that stopped on conflicts
 * is aborted and reported as `conflict`; one that was killed, or failed after
 * starting without conflicts, is aborted and thrown; conflicts or a
 * `MERGE_HEAD` this call did not create are `blocked` and left untouched; a
 * clean refusal that started no merge is `blocked` with git's message.
 * @param git - command runner.
 * @param repoRoot - the base checkout's top-level directory.
 * @param id - the worktree id, named in the merge commit message.
 * @param label - the worktree's display label, named in the merge commit message.
 * @param commit - the reviewed commit to merge, as a full commit id.
 * @param signal - cancellation for the whole accept operation.
 * @param hooks - last-moment check, landed notification, and operator reports.
 * @returns the merge outcome.
 * @throws when a pre-merge probe or `hooks.beforeMerge` failed, this call's merge was killed or failed after
 *   starting, or the merge commit id could not be read after a successful merge (`hooks.onLanded` has then
 *   already been called).
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
    return { kind: 'merged', mergeCommit: await readMergeCommit(git, repoRoot, signal) }
  }
  return classifyFailedMerge(git, repoRoot, id, commit, result, hooks)
}
