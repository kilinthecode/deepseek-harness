/**
 * Pure directory-layout computation for worktrees, records, and review
 * checkouts under the service's configured root. No function here performs
 * filesystem or git I/O, so the layout is directly unit-testable.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/paths
 */

import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'

/** Hexadecimal digest length kept from the repository-path hash in a `repoKey`. */
const REPO_KEY_HASH_HEX_LENGTH = 12

/** Characters allowed unescaped in a filesystem path segment derived from a repository name. */
const UNSAFE_PATH_SEGMENT_CHARS = /[^A-Za-z0-9._-]+/g

/** Fallback basename when a repository's own basename sanitizes to nothing. */
const SANITIZED_BASENAME_FALLBACK = 'repo'

/**
 * Replace characters a repository basename may hold but a path segment
 * should not (spaces, slashes-from-other-platforms, unicode punctuation) with
 * a single hyphen, so the result stays one readable path segment.
 * @param segment - candidate path segment, typically a repository basename.
 * @returns a sanitized, non-empty path segment.
 */
function sanitizePathSegment(segment: string): string {
  const cleaned = segment.replace(UNSAFE_PATH_SEGMENT_CHARS, '-')
  return cleaned.length === 0 ? SANITIZED_BASENAME_FALLBACK : cleaned
}

/**
 * Stable per-repository directory name: a readable basename plus a content
 * hash of the canonical repository path, so two repositories that happen to
 * share a basename (for example two `worktree` checkouts of the same project)
 * never collide.
 * @param canonicalToplevel - the repository's realpath-resolved top-level directory.
 * @returns the `<basename>-<hash>` directory name under the configured root.
 */
export function repoKeyFor(canonicalToplevel: string): string {
  const digest = createHash('sha256').update(canonicalToplevel).digest('hex').slice(0, REPO_KEY_HASH_HEX_LENGTH)
  return `${sanitizePathSegment(basename(canonicalToplevel))}-${digest}`
}

/** Directory layout for one repository's worktrees, records, and review checkouts. */
export interface WorktreeLayout {
  /** `<root>/<repoKey>`, the per-repository directory. */
  readonly repoDir: string
  /** `<repoDir>/records`, one JSON file per worktree. */
  readonly recordsDir: string
  /** `<repoDir>/reviews`, disposable detached review checkouts. */
  readonly reviewsDir: string
  /** `<repoDir>/merge`, the `withFileLock` target serializing merges into the base checkout. */
  readonly mergeLockPath: string
}

/**
 * Compute the directory layout for one repository.
 * @param root - the service's configured or resolved worktree root.
 * @param repoKey - this repository's {@link repoKeyFor} directory name.
 * @returns the repository's worktree, records, reviews, and merge-lock paths.
 */
export function layoutFor(root: string, repoKey: string): WorktreeLayout {
  const repoDir = join(root, repoKey)
  return {
    repoDir,
    recordsDir: join(repoDir, 'records'),
    reviewsDir: join(repoDir, 'reviews'),
    mergeLockPath: join(repoDir, 'merge'),
  }
}

/**
 * The linked worktree directory for one worktree id.
 * @param layout - the repository's directory layout.
 * @param id - the worktree id.
 * @returns `<repoDir>/<id>`.
 */
export function worktreeDirFor(layout: WorktreeLayout, id: string): string {
  return join(layout.repoDir, id)
}

/**
 * The durable record file for one worktree id.
 * @param layout - the repository's directory layout.
 * @param id - the worktree id.
 * @returns `<recordsDir>/<id>.json`.
 */
export function recordPathFor(layout: WorktreeLayout, id: string): string {
  return join(layout.recordsDir, `${id}.json`)
}

/**
 * A disposable detached review checkout directory for one worktree id.
 * @param layout - the repository's directory layout.
 * @param id - the worktree id under review.
 * @param suffix - a value distinguishing this checkout from a prior attempt for the same id.
 * @returns `<reviewsDir>/<id>-<suffix>`.
 */
export function reviewCheckoutPathFor(layout: WorktreeLayout, id: string, suffix: string | number): string {
  return join(layout.reviewsDir, `${id}-${suffix}`)
}

/**
 * Prefix shared by every review checkout directory belonging to one worktree id.
 * @param id - the worktree id.
 * @returns the `<id>-` prefix every one of its review checkout directory names starts with.
 */
export function reviewCheckoutPrefixFor(id: string): string {
  return `${id}-`
}
