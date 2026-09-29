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
import { cleanupSignal } from './git.ts'
import type { GitRunner } from './git.ts'
import { worktreeDirFor } from './paths.ts'
import { countOpenSlots, createRecord, generateWorktreeId, layoutForRepo, toPublicRecord } from './records.ts'
import type { ScanWarning, StoredWorktreeRecord } from './records.ts'
import { repoIdentityOf } from './repo.ts'
import type { CreateWorktreeRequest, ProvisionedWorktree } from './types.ts'

/**
 * Best-effort removal of a worktree and branch that provisioning just created,
 * after a later provisioning step failed. Each command runs on its own fresh
 * signal, because the request's own signal is often why provisioning failed
 * and a command started on an aborted signal never runs, and a removal that
 * timed out must not abort the branch deletion after it. Each step is
 * attempted whatever the other did — a worktree that will not remove must not
 * also keep its branch — and uses `run`, not `expect`: the caller's original
 * error is what must reach the caller, so a further failure here is swallowed
 * rather than thrown. A leftover is recovered by a later prune or an
 * operator's cleanup.
 */
async function cleanupFailedWorktree(git: GitRunner, repoRoot: string, worktreePath: string, branch: string): Promise<void> {
  try {
    await git.run(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, signal: cleanupSignal() })
  } catch {
    // The branch deletion below still runs, and the caller reports the original failure.
  }
  await git.run(['branch', '-D', branch], { cwd: repoRoot, signal: cleanupSignal() })
}

/**
 * Create one worktree for `request`.
 * @param git - command runner.
 * @param root - the service's configured or resolved worktree root.
 * @param branchPrefix - `Config.branchPrefix`.
 * @param maxWorktrees - `Config.maxWorktrees`.
 * @param request - owner, base directory, label, task, optional worker route, and cancellation.
 * @param warn - receives a warning for each stray file the slot count skipped in the records directory.
 * @returns the committed `open` record, the worker directory, and any uncommitted base changes left out.
 * @throws when `request.baseDir` is not inside a git work tree, or the repository already has `maxWorktrees`
 *   open worktrees. `maxWorktrees` is advisory under concurrency: two `create` calls for the same repository
 *   that both read the slot count before either persists a record can both pass this check.
 */
export async function createWorktree(
  git: GitRunner,
  root: string,
  branchPrefix: string,
  maxWorktrees: number,
  request: CreateWorktreeRequest,
  warn?: ScanWarning,
): Promise<ProvisionedWorktree> {
  const identity = await repoIdentityOf(git, request.baseDir, request.signal)
  if (identity === undefined) {
    throw new Error(`subagent-worktree: "${request.baseDir}" is not inside a git work tree, so no isolated worktree can be created`)
  }
  const { repoRoot } = identity
  // Keyed by the shared git common directory, not repoRoot: every linked
  // worktree of one repository resolves the same commonDir, so worktrees
  // created from different linked checkouts still share one records
  // directory, merge lock, and maxWorktrees count. repoRoot — this specific
  // checkout's own top-level directory — stays the record's merge target.
  const layout = layoutForRepo(root, identity.commonDir)

  const openSlots = await countOpenSlots(layout, warn)
  if (openSlots >= maxWorktrees) {
    throw new Error(`subagent-worktree: ${openSlots} worktrees are already open for ${repoRoot}; accept or discard one first`)
  }

  const id = await generateWorktreeId(layout)
  const branch = `${branchPrefix}${id}`
  const worktreePath = worktreeDirFor(layout, id)
  await git.expect(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], 'git worktree add', {
    cwd: repoRoot, signal: request.signal,
  })

  try {
    const head = await git.expectComplete(['rev-parse', 'HEAD'], 'git rev-parse', { cwd: worktreePath, signal: request.signal })
    const baseCommit = head.stdout.trim()

    // Canonicalize both sides before computing the relative path: repoRoot is
    // already a realpath, and baseDir may reach the same directory through a
    // symlinked prefix (for example macOS's /tmp -> /private/tmp), which would
    // otherwise turn an empty relative path into a spurious "../.." traversal.
    const canonicalBaseDir = await realpath(request.baseDir)
    const relativeBaseDir = relative(repoRoot, canonicalBaseDir)
    const workDir = relativeBaseDir === '' ? worktreePath : join(worktreePath, relativeBaseDir)

    // Asked for what `git add -A` would stage — every untracked file, and submodule changes whatever
    // `status.showUntrackedFiles`, `status.ignoreSubmodules`, or `submodule.<name>.ignore` say — so the user's git
    // config cannot hide base changes this worktree does not contain.
    const status = await git.expectComplete(
      ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
      'git status',
      { cwd: repoRoot, signal: request.signal },
    )
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
  } catch (error) {
    try {
      await cleanupFailedWorktree(git, repoRoot, worktreePath, branch)
    } catch {
      // Best-effort: `error` below is what the caller must see; a leftover worktree/branch here is
      // recovered by a later `git worktree prune` or an operator's cleanup.
    }
    throw error
  }
}
