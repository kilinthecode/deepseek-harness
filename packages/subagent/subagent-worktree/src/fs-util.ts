/** Filesystem existence probe shared by record and worktree-directory lookups. */

import { stat } from 'node:fs/promises'

/**
 * Whether a path currently exists, distinguishing absence from a real access failure.
 * @param path - absolute or relative filesystem path to probe.
 * @returns `true` when `stat` succeeds, `false` for `ENOENT`.
 * @throws any other `stat` failure (for example a permission error), which is not absence.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
