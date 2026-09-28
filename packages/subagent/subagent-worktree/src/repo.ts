/** Repository top-level resolution shared by `create` and `list`. */

import { realpath } from 'node:fs/promises'
import type { GitRunner } from './git.ts'

/**
 * Resolve the canonical top-level directory of the repository enclosing `dir`.
 * @param git - command runner.
 * @param dir - a directory expected to be inside a git work tree.
 * @param signal - cancellation, when the caller has one to offer.
 * @returns the realpath-resolved top-level directory, or `undefined` when `dir` is not inside a git work tree.
 */
export async function repoRootOf(git: GitRunner, dir: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await git.run(['rev-parse', '--show-toplevel'], { cwd: dir, signal })
  if (result.exitCode !== 0) return undefined
  return realpath(result.stdout.trim())
}
