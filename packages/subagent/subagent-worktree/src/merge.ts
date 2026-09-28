/**
 * Merges a reviewed commit into the base checkout, classifying a failed merge
 * as either a conflict (aborted, branch kept) or a refusal to even start
 * (blocked, nothing changed). `--no-ff` is required: parallel workers branch
 * from the same base, so after the first merge every later branch can no
 * longer fast-forward. Never aborts a merge this function did not itself
 * start: a pre-existing `MERGE_HEAD` or a detached `HEAD` refuses up front,
 * and a killed or otherwise fatal merge attempt is escalated rather than
 * silently reported as a normal outcome.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/merge
 */

import { DIAGNOSTIC_TAIL_CHARS, tailChars } from './bounds.ts'
import type { GitRunner } from './git.ts'

/** Outcome of one merge attempt into the base checkout. */
export type MergeAttemptResult =
  | { readonly kind: 'merged'; readonly mergeCommit: string }
  | { readonly kind: 'conflict'; readonly files: readonly string[] }
  | { readonly kind: 'blocked'; readonly reason: string }

/** Whether the base checkout already has `MERGE_HEAD` (some operation's merge already in progress). */
async function hasMergeHeadAlready(git: GitRunner, repoRoot: string, signal: AbortSignal): Promise<boolean> {
  const result = await git.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repoRoot, signal })
  return result.exitCode === 0
}

/** Whether the base checkout's `HEAD` is detached (not on a branch, so a merge there would update no branch). */
async function hasDetachedHead(git: GitRunner, repoRoot: string, signal: AbortSignal): Promise<boolean> {
  const result = await git.run(['symbolic-ref', '-q', 'HEAD'], { cwd: repoRoot, signal })
  return result.exitCode !== 0
}

/** Abort a `MERGE_HEAD` this function's own merge left behind, best-effort — the caller is about to throw regardless. */
async function abortLeftoverMerge(git: GitRunner, repoRoot: string, signal: AbortSignal): Promise<void> {
  if (await hasMergeHeadAlready(git, repoRoot, signal)) {
    await git.run(['merge', '--abort'], { cwd: repoRoot, signal })
  }
}

/**
 * Attempt `git merge --no-ff --no-edit` of one reviewed commit into the base
 * checkout.
 *
 * Before starting, refuses as `blocked` — without running `git merge` at all —
 * when the base checkout already has an operation in progress (`MERGE_HEAD`
 * exists) or its `HEAD` is detached. After the function's own `git merge`
 * fails: unmerged paths are a real conflict, aborted before returning so the
 * branch and its commit stay intact for a retry; otherwise, a killed attempt
 * (no exit code) or a fatal error that nonetheless left `MERGE_HEAD` behind is
 * aborted and then thrown, never reported as a normal outcome; only a clean
 * refusal that started no merge at all (nothing to abort) is `blocked`.
 * @param git - command runner.
 * @param repoRoot - the base checkout's top-level directory.
 * @param id - the worktree id, named in the merge commit message.
 * @param label - the worktree's display label, named in the merge commit message.
 * @param commit - the reviewed commit to merge.
 * @param signal - cancellation for the whole accept operation.
 * @returns the merge outcome.
 * @throws when the function's own merge attempt was killed or failed fatally after starting.
 */
export async function attemptMerge(
  git: GitRunner,
  repoRoot: string,
  id: string,
  label: string,
  commit: string,
  signal: AbortSignal,
): Promise<MergeAttemptResult> {
  if (await hasMergeHeadAlready(git, repoRoot, signal)) {
    return { kind: 'blocked', reason: 'the base checkout already has a merge in progress (MERGE_HEAD exists)' }
  }
  if (await hasDetachedHead(git, repoRoot, signal)) {
    return { kind: 'blocked', reason: 'the base checkout HEAD is detached; a merge there would update no branch' }
  }

  const message = `Merge worktree ${id}: ${label}`
  const result = await git.run(['merge', '--no-ff', '--no-edit', '-m', message, commit], { cwd: repoRoot, signal })
  if (result.exitCode === 0) {
    const head = await git.expectComplete(['rev-parse', 'HEAD'], 'git rev-parse', { cwd: repoRoot, signal })
    return { kind: 'merged', mergeCommit: head.stdout.trim() }
  }

  const unmerged = await git.expectComplete(['diff', '--name-only', '--diff-filter=U'], 'git diff --diff-filter=U', { cwd: repoRoot, signal })
  const files = unmerged.stdout.split('\n').filter(line => line.length > 0)
  if (files.length > 0) {
    await git.expect(['merge', '--abort'], 'git merge --abort', { cwd: repoRoot, signal })
    return { kind: 'conflict', files }
  }

  if (result.exitCode === null) {
    await abortLeftoverMerge(git, repoRoot, signal)
    throw new Error(`subagent-worktree: merge of worktree ${id} was killed before it finished`)
  }
  if (await hasMergeHeadAlready(git, repoRoot, signal)) {
    await abortLeftoverMerge(git, repoRoot, signal)
    throw new Error(
      `subagent-worktree: merge of worktree ${id} failed unexpectedly after starting: `
      + tailChars(result.stderr.trim(), DIAGNOSTIC_TAIL_CHARS),
    )
  }
  return { kind: 'blocked', reason: tailChars(result.stderr.trim(), DIAGNOSTIC_TAIL_CHARS) }
}
