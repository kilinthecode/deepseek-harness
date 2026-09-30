/**
 * Project identity for project-scoped memories: root discovery from a
 * session working directory and the path-safe key prefix derived from the
 * root.
 * @module @deepseek-ai/dsh-memory/src/project
 */

import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MemoryName, ProjectMemoryKey } from './domain.ts'

/** Longest basename fragment kept in a project slug before the hash suffix. */
const SLUG_BASENAME_MAX_CHARS = 40

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
  } catch (_error: unknown) {
    // ENOENT, ENOTDIR, and EACCES all mean the same thing here: no usable marker at this path.
    return false
  }
  return true
}

/**
 * Walk upward from `cwd` to the first directory containing one of `markers`.
 * @param cwd - absolute or relative working directory; resolved against the process cwd.
 * @param markers - directory entries that identify a project root, such as `.git`.
 * @returns the absolute project root, or `undefined` when no ancestor carries a marker.
 */
export async function findProjectRoot(cwd: string, markers: readonly string[]): Promise<string | undefined> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await exists(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Derive the readable, unique, path-safe slug of one project root: the
 * sanitized basename followed by eight hex characters of the root's SHA-1.
 * @param root - absolute project root.
 * @returns the slug, for example `deepseek-harness-3f9a1c2b`.
 */
export function projectSlug(root: string): string {
  const base = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASENAME_MAX_CHARS)
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8)
  return `${base.length > 0 ? base : 'root'}-${hash}`
}

/**
 * Build the project-table key of one memory.
 * @param root - absolute project root the memory belongs to.
 * @param name - validated memory name.
 * @returns the key `<slug>__<name>`.
 */
export function projectMemoryKey(root: string, name: MemoryName): ProjectMemoryKey {
  return brandString<ProjectMemoryKey>(`${projectSlug(root)}__${name}`)
}
