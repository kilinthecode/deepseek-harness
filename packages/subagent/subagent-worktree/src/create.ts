/**
 * Creates one linked worktree on a new branch from the base checkout's `HEAD`:
 * resolves the repository, enforces `maxWorktrees`, provisions the git
 * worktree, computes the worker's directory and the base checkout's dirty
 * summary, and persists the fresh `open` record.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/create
 */

import { realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { BASE_DIRTY_MAX_ENTRIES, boundedLines } from './bounds.ts'
import type { GitRunner } from './git.ts'
import { worktreeDirFor } from './paths.ts'
import { countOpenSlots, createRecord, generateWorktreeId, layoutForRepo, toPublicRecord } from './records.ts'
import type { StoredWorktreeRecord } from './records.ts'
import { repoRootOf } from './repo.ts'
import type { CreateWorktreeRequest, ProvisionedWorktree } from './types.ts'

/**
 * Create one worktree for `request`.
 * @param git - command runner.
 * @param root - the service's configured or resolved worktree root.
 * @param branchPrefix - `Config.branchPrefix`.
 * @param maxWorktrees - `Config.maxWorktrees`.
 * @param request - owner, base directory, label, task, optional worker route, and cancellation.
 * @returns the committed `open` record, the worker directory, and any uncommitted base changes left out.
 * @throws when `request.baseDir` is not inside a git work tree, or the repository already has `maxWorktrees` open worktrees.
 */
export async function createWorktree(
  git: GitRunner,
  root: string,
  branchPrefix: string,
  maxWorktrees: number,
  request: CreateWorktreeRequest,
): Promise<ProvisionedWorktree> {
  const repoRoot = await repoRootOf(git, request.baseDir, request.signal)
  if (repoRoot === undefined) {
    throw new Error(`subagent-worktree: "${request.baseDir}" is not inside a git work tree, so no isolated worktree can be created`)
  }
  const layout = layoutForRepo(root, repoRoot)

  const openSlots = await countOpenSlots(layout)
  if (openSlots >= maxWorktrees) {
    throw new Error(`subagent-worktree: ${openSlots} worktrees are already open for ${repoRoot}; accept or discard one first`)
  }

  const id = await generateWorktreeId(layout)
  const branch = `${branchPrefix}${id}`
  const worktreePath = worktreeDirFor(layout, id)
  await git.expect(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], 'git worktree add', {
    cwd: repoRoot, signal: request.signal,
  })
  const head = await git.expect(['rev-parse', 'HEAD'], 'git rev-parse', { cwd: worktreePath, signal: request.signal })
  const baseCommit = head.stdout.trim()

  // Canonicalize both sides before computing the relative path: repoRoot is
  // already a realpath, and baseDir may reach the same directory through a
  // symlinked prefix (for example macOS's /tmp -> /private/tmp), which would
  // otherwise turn an empty relative path into a spurious "../.." traversal.
  const canonicalBaseDir = await realpath(request.baseDir)
  const relativeBaseDir = relative(repoRoot, canonicalBaseDir)
  const workDir = relativeBaseDir === '' ? worktreePath : join(worktreePath, relativeBaseDir)

  const status = await git.expect(['status', '--porcelain'], 'git status', { cwd: repoRoot, signal: request.signal })
  const { entries, total } = boundedLines(status.stdout, BASE_DIRTY_MAX_ENTRIES)

  const record: StoredWorktreeRecord = {
    id,
    repoRoot,
    path: worktreePath,
    branch,
    baseCommit,
    owner: request.owner,
    label: request.label,
    task: request.task,
    state: 'open',
    createdAt: Date.now(),
    workerSessionIds: [],
    workerRoute: request.workerRoute,
  }
  const persisted = await createRecord(layout, record)

  return {
    record: toPublicRecord(persisted),
    workDir,
    ...total === 0 ? {} : { baseDirty: { entries, total } },
  }
}
