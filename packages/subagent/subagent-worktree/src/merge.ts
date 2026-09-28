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
 * Abort the merge in progress only when it is this call's own: `MERGE_HEAD` must name the commit this call merged.
 * @returns whether a merge that this call started was aborted and is gone.
 */
async function abortOwnMerge(
  git: GitRunner, repoRoot: string, commit: string, mergeHead: string | undefined, hooks: MergeAttemptHooks,
): Promise<void> {
  if (mergeHead !== commit) return
  const signal = cleanupSignal()
  await git.run(['merge', '--abort'], { cwd: repoRoot, signal })
  if (await readMergeHead(git, repoRoot, signal) !== undefined) {
    hooks.report(
      `subagent-worktree: the merge of ${commit} in "${repoRoot}" could not be aborted and is still in progress; `
      + 'run "git merge --abort" there before merging anything else',
    )
  }
}

/** The paths git lists as unmerged in the base checkout. */
async function unmergedPaths(git: GitRunner, repoRoot: string, signal: AbortSignal): Promise<string[]> {
  const unmerged = await git.expectComplete(['diff', '--name-only', '--diff-filter=U'], 'git diff --diff-filter=U', { cwd: repoRoot, signal })
  return unmerged.stdout.split('\n').filter(line => line.length > 0)
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
  const signal = cleanupSignal()
  const mergeHead = await readMergeHead(git, repoRoot, signal)
  if (failed.exitCode === null) {
    await abortOwnMerge(git, repoRoot, commit, mergeHead, hooks)
    throw new Error(`subagent-worktree: merge of worktree ${id} was killed before it finished`)
  }
  if (mergeHead === commit) {
    const files = await unmergedPaths(git, repoRoot, signal)
    await abortOwnMerge(git, repoRoot, commit, mergeHead, hooks)
    if (files.length > 0 && failed.exitCode === MERGE_CONFLICT_EXIT_CODE) return { kind: 'conflict', files }
    throw new Error(
      `subagent-worktree: merge of worktree ${id} failed unexpectedly after starting: ${tailChars(failed.stderr.trim(), DIAGNOSTIC_TAIL_CHARS)}`,
    )
  }
  if (mergeHead !== undefined || (await unmergedPaths(git, repoRoot, signal)).length > 0) {
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
