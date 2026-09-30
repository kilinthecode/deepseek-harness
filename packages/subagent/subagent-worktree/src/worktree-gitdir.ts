/**
 * Locating the administrative directory git keeps for one linked worktree
 * without reading the worktree's own `.git` entry. A sandboxed child can
 * rewrite that entry, so a command that trusted it would run against a
 * repository the child chose. The lookup reads only the repository's shared git
 * directory, which the child cannot write.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/worktree-gitdir
 */

import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GitRunner } from './git.ts'
import type { StoredWorktreeRecord } from './records.ts'
import { repoIdentityOf } from './repo.ts'

/** Whether a filesystem error reports a file or directory that does not exist. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * The administrative directory git created for the linked worktree at one
 * path: the entry of `<commonDir>/worktrees` whose `gitdir` file names that
 * path's `.git` file. Git writes that file when it adds the worktree, and only
 * a process with write access to the shared git directory can change it.
 * @param commonDir - the repository's realpath-resolved shared git directory.
 * @param worktreePath - the worktree directory.
 * @param id - the worktree id, which the thrown messages name instead of a path.
 * @returns `<commonDir>/worktrees/<name>`.
 * @throws when the worktree directory is gone or git has no linked worktree registered at it.
 */
export async function worktreeGitDirFor(commonDir: string, worktreePath: string, id: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(worktreePath)
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
    throw new Error(`subagent-worktree: worktree ${id} has no directory to run git in`)
  }
  const expected = join(canonical, '.git')
  const registry = join(commonDir, 'worktrees')
  let names: string[]
  try {
    names = await readdir(registry)
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
    names = []
  }
  for (const name of names) {
    let pointer: string
    try {
      pointer = await readFile(join(registry, name, 'gitdir'), 'utf8')
    } catch (error: unknown) {
      // An entry git is still creating or has begun to prune has no pointer file yet or any more.
      if (isMissing(error)) continue
      throw error
    }
    if (resolve(pointer.trim()) === expected) return join(registry, name)
  }
  throw new Error(`subagent-worktree: git has no linked worktree registered for worktree ${id}`)
}

/**
 * The administrative directory to confine git to for one worktree record,
 * found from the base checkout, which the child cannot write.
 * @param git - command runner.
 * @param record - the record naming the base checkout and the worktree directory.
 * @param signal - cancellation for the base checkout lookup.
 * @returns the worktree's administrative directory.
 * @throws when the base checkout is no longer a git work tree, or {@link worktreeGitDirFor} does.
 */
export async function worktreeGitDirOf(
  git: GitRunner, record: Pick<StoredWorktreeRecord, 'id' | 'repoRoot' | 'path'>, signal: AbortSignal,
): Promise<string> {
  const identity = await repoIdentityOf(git, record.repoRoot, signal)
  if (identity === undefined) {
    throw new Error(`subagent-worktree: the base checkout of worktree ${record.id} is no longer inside a git work tree`)
  }
  return worktreeGitDirFor(identity.commonDir, record.path, record.id)
}
