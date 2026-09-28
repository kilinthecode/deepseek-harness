/**
 * Merges a reviewed commit into the base checkout, classifying a failed merge
 * as either a conflict (aborted, branch kept) or a refusal to even start
 * (blocked, nothing changed). `--no-ff` is required: parallel workers branch
 * from the same base, so after the first merge every later branch can no
 * longer fast-forward.
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

/**
 * Attempt `git merge --no-ff --no-edit` of one reviewed commit into the base
 * checkout. A failure with unmerged paths is a conflict, aborted before
 * returning so the branch and its commit stay intact for a retry. A failure
 * with no unmerged paths never started a merge (for example local changes
 * would be overwritten) and needs no abort.
 * @param git - command runner.
 * @param repoRoot - the base checkout's top-level directory.
 * @param id - the worktree id, named in the merge commit message.
 * @param label - the worktree's display label, named in the merge commit message.
 * @param commit - the reviewed commit to merge.
 * @param signal - cancellation for the whole accept operation.
 * @returns the merge outcome.
 */
export async function attemptMerge(
  git: GitRunner,
  repoRoot: string,
  id: string,
  label: string,
  commit: string,
  signal: AbortSignal,
): Promise<MergeAttemptResult> {
  const message = `Merge worktree ${id}: ${label}`
  const result = await git.run(['merge', '--no-ff', '--no-edit', '-m', message, commit], { cwd: repoRoot, signal })
  if (result.exitCode === 0) {
    const head = await git.expect(['rev-parse', 'HEAD'], 'git rev-parse', { cwd: repoRoot, signal })
    return { kind: 'merged', mergeCommit: head.stdout.trim() }
  }
  const unmerged = await git.expect(['diff', '--name-only', '--diff-filter=U'], 'git diff --diff-filter=U', { cwd: repoRoot, signal })
  const files = unmerged.stdout.split('\n').filter(line => line.length > 0)
  if (files.length > 0) {
    await git.expect(['merge', '--abort'], 'git merge --abort', { cwd: repoRoot, signal })
    return { kind: 'conflict', files }
  }
  return { kind: 'blocked', reason: tailChars(result.stderr.trim(), DIAGNOSTIC_TAIL_CHARS) }
}
