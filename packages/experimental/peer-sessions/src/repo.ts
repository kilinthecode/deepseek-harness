/**
 * Peer repository identity, read from the filesystem alone.
 *
 * Peers group by repository, not by exact directory: a linked worktree and its
 * main checkout are one repository, and a subdirectory belongs to the checkout
 * above it. The key is derived from `.git` markers on disk, so it needs no
 * `git` subprocess (absent in a bare runtime, slow on every presence write)
 * and reads no environment variable: `GIT_DIR` is ignored, because a session's
 * repository is the one holding its working directory.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions/repo
 */

import { lstat, readFile, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Prefix of the single line a gitfile writes: the administrative directory of the checkout. */
const GITDIR_PREFIX = 'gitdir:'

/** One walked path's `lstat` entry, or `undefined` when it cannot be probed. */
async function lstatOrUndefined(filename: string): Promise<Stats | undefined> {
  try {
    return await lstat(filename)
  } catch {
    // ENOENT is the ordinary answer at every level of the walk; ENOTDIR
    // appears when the walked path is itself not a directory, and EACCES when
    // a level cannot be searched. None of them is a marker, so the walk goes on.
    return undefined
  }
}

/** Whether `error` is a filesystem `ENOENT`: the path names nothing, as opposed to a path that cannot be accessed. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Read one small file as text; a missing or unreadable path yields `undefined`. */
async function readText(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, 'utf8')
  } catch {
    // ENOENT and EACCES are unusable alike: no key is derived from a file that
    // was not read. Bytes that are not UTF-8 decode to U+FFFD rather than
    // fail, which is harmless because only the first line is parsed.
    return undefined
  }
}

/** The `git:` key of one repository directory, or `undefined` when it cannot be canonicalized. */
async function gitKey(directory: string): Promise<string | undefined> {
  try {
    return `git:${await realpath(directory)}`
  } catch {
    // A dangling gitdir, or one this process cannot traverse, names no
    // repository; the caller falls back to the directory key.
    return undefined
  }
}

/**
 * The `git:` key one `.git` file names.
 * @param directory - directory holding the gitfile; its gitdir may be relative to it.
 * @param marker - absolute path of the gitfile.
 * @returns the key of the repository that gitfile belongs to, or `undefined` when the file is malformed or unreadable.
 */
async function gitfileKey(directory: string, marker: string): Promise<string | undefined> {
  const content = await readText(marker)
  if (content === undefined) return undefined
  // A gitfile holds one line; git ends it with a newline, a hand-written one may not.
  const end = content.indexOf('\n')
  const line = (end === -1 ? content : content.slice(0, end)).trim()
  if (!line.startsWith(GITDIR_PREFIX)) return undefined
  const target = line.slice(GITDIR_PREFIX.length).trim()
  if (target === '') return undefined
  const gitdir = resolve(directory, target)
  const commondir = join(gitdir, 'commondir')
  let common: string
  try {
    common = await readFile(commondir, 'utf8')
  } catch (error) {
    // A gitfile without a commondir, such as a submodule checkout, is its own
    // repository; only a commondir points at a shared one. Any other failure,
    // such as an unsearchable gitdir, leaves the checkout unidentified.
    return isNotFound(error) ? gitKey(gitdir) : undefined
  }
  return gitKey(resolve(gitdir, common.trim()))
}

/** The `git:` key one existing `.git` entry names, or `undefined` when it is not a usable marker. */
async function markerKey(directory: string, marker: string, entry: Stats): Promise<string | undefined> {
  if (entry.isDirectory()) return gitKey(marker)
  if (!entry.isFile()) return undefined
  return gitfileKey(directory, marker)
}

/**
 * Resolve the repository key that groups peer sessions for one working
 * directory.
 *
 * The walk starts at `canonicalCwd` and stops at the first `.git` entry it
 * finds: a directory keyed by its canonical path, or a file keyed by the
 * repository its `gitdir` line and optional `commondir` point at. A `.git`
 * entry that exists but names no usable repository ends the walk, because an
 * enclosing checkout must not be inherited from a directory that has its own
 * unusable marker. Without any `.git` up to the filesystem root the directory
 * stands alone: its key is `dir:` plus `canonicalCwd`, which is also what a
 * repository-less directory falls back to. Only a directory or a regular file
 * is a usable marker, so a symlinked `.git` falls back as well.
 *
 * `canonicalCwd` must already be absolute and canonicalized, as
 * `realpathNormalize` returns it: distinct spellings of one directory must
 * produce one key.
 *
 * @param canonicalCwd - canonical working directory of the session.
 * @returns `git:` plus the canonical repository directory, or `dir:` plus `canonicalCwd` when no repository is found.
 */
export async function peerRepoKey(canonicalCwd: string): Promise<string> {
  for (let directory = canonicalCwd;;) {
    const marker = join(directory, '.git')
    const entry = await lstatOrUndefined(marker)
    if (entry !== undefined) return await markerKey(directory, marker, entry) ?? `dir:${canonicalCwd}`
    const parent = dirname(directory)
    if (parent === directory) return `dir:${canonicalCwd}`
    directory = parent
  }
}
