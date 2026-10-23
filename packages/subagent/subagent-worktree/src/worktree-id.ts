/**
 * Runtime validation of the worktree id shape. `WorktreeId` is a branded
 * `string` with no runtime tag, so nothing stops a caller from constructing
 * one directly (`brandString<WorktreeId>(raw)`) with no format check; this
 * validator is the one place that shape is enforced, applied at every public
 * method entry and again immediately before any path is built from an id, so
 * a malformed or malicious id (for example a path-traversal attempt) can
 * never reach the filesystem.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/worktree-id
 */

import type { WorktreeId } from './types.ts'

/** The service's own worktree id shape: `wt-` followed by eight lowercase hexadecimal digits. */
const WORKTREE_ID_PATTERN = /^wt-[0-9a-f]{8}$/

/**
 * Whether a string has the worktree id shape.
 * @param value - the candidate id, such as a record file's name without its extension.
 * @returns whether `value` is `wt-` followed by eight lowercase hexadecimal digits.
 */
export function isWorktreeId(value: string): value is WorktreeId {
  return WORKTREE_ID_PATTERN.test(value)
}

/**
 * Validate a worktree id's shape.
 * @param value - the candidate id, from a request, a record field, or a record file name.
 * @returns an assertion that `value` is a {@link WorktreeId}.
 * @throws when `value` does not match `wt-` followed by eight lowercase hexadecimal digits.
 */
export function assertWorktreeId(value: string): asserts value is WorktreeId {
  if (!isWorktreeId(value)) {
    throw new Error(`subagent-worktree: "${value}" is not a worktree id (expected "wt-" followed by eight lowercase hexadecimal digits)`)
  }
}
