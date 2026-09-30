/** Repository identity resolution shared by `create` and `list`. */

import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { GitRunner } from './git.ts'

/**
 * A repository's identity as seen from one checkout of it.
 */
export interface RepoIdentity {
  /**
   * Realpath-resolved top-level directory of the checkout `dir` was inside.
   * This is the concrete directory every worktree, commit, and merge for this
   * request targets — a record's own `repoRoot`.
   */
  readonly repoRoot: string
  /**
   * Realpath-resolved shared git common directory (ordinarily `<repo>/.git`,
   * the same path from every linked worktree of one repository). Used only to
   * key the per-repository worktree layout, so worktrees created from
   * different linked checkouts of the same repository still share one
   * records directory, merge lock, and `maxWorktrees` count.
   */
  readonly commonDir: string
}

/**
 * Resolve the identity of the repository enclosing `dir`: its own top-level
 * checkout directory and the git common directory shared by every linked
 * worktree of it.
 * @param git - command runner.
 * @param dir - a directory expected to be inside a git work tree.
 * @param signal - cancellation, when the caller has one to offer.
 * @returns the resolved identity, or `undefined` when `dir` is not inside a git work tree.
 * @throws when git's output is captured lossily and cannot be safely parsed.
 */
export async function repoIdentityOf(git: GitRunner, dir: string, signal?: AbortSignal): Promise<RepoIdentity | undefined> {
  const result = await git.run(['rev-parse', '--show-toplevel', '--git-common-dir'], { cwd: dir, signal })
  if (result.exitCode !== 0) return undefined
  if (result.stdoutLossy) {
    throw new Error('subagent-worktree: git rev-parse output exceeded its capture limit; refusing to parse a partial result')
  }
  const lines = result.stdout.split('\n')
  const toplevel = lines[0]?.trim()
  const commonDirRaw = lines[1]?.trim()
  if (toplevel === undefined || toplevel === '' || commonDirRaw === undefined || commonDirRaw === '') return undefined
  const [repoRoot, commonDir] = await Promise.all([
    realpath(toplevel),
    realpath(isAbsolute(commonDirRaw) ? commonDirRaw : join(dir, commonDirRaw)),
  ])
  return { repoRoot, commonDir }
}
