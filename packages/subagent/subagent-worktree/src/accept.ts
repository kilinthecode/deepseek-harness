/**
 * The `accept` operation: the only operation that commits or merges. Commits
 * a finished worker's changes on its behalf, runs the configured check
 * command, has an independent reviewer child check the exact commit (skipping
 * a repeat review for a commit that already passed), and merges only a
 * passing change into the base checkout. Every non-`merged` outcome leaves
 * the worktree `open`; any error thrown before the merge lands also returns
 * it to `open` before rethrowing. Once the merge commit exists the record is
 * never reopened: the merge is a fact of the base checkout's history.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/accept
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { DIAGNOSTIC_TAIL_CHARS, tailChars } from './bounds.ts'
import { runCheckCommand } from './check-command.ts'
import type { CommitAuthor } from './config.ts'
import type { Config } from './index.ts'
import { GitCommandError, type GitRunner } from './git.ts'
import { attemptMerge } from './merge.ts'
import { reviewCheckoutPathFor, reviewCheckoutPrefixFor } from './paths.ts'
import type { WorktreeLayout } from './paths.ts'
import { pathExists } from './fs-util.ts'
import {
  assertOpenOrRecoverable, assertOwnerAuthority, requireRecordLocation, toPublicRecord, updateExistingRecordAt,
} from './records.ts'
import type { StoredWorktreeRecord } from './records.ts'
import { callerRouteOf, runReviewer } from './review.ts'
import { assertNoRunningWorkers } from './workers.ts'
import type {
  AcceptOutcome, AcceptWorktreeRequest, ResolveReviewerRequest, WorktreeId, WorktreeRecord, WorktreeRoute, WorktreeVerdict,
} from './types.ts'

/**
 * Milliseconds a contender waits for the per-repository merge lock: sized for
 * one other accept's merge, which may run repository hooks, rather than for
 * `withFileLock`'s file-work default. A fixed lifecycle constant, not a
 * deployment tunable.
 */
const MERGE_LOCK_WAIT_MS = 10 * 60 * 1000

/** Collaborators `accept` needs beyond the request itself. */
export interface AcceptDeps {
  /** Host context with `subprocess`, `subagents`, and `agents`. */
  readonly ctx: Context
  /** Command runner. */
  readonly git: GitRunner
  /** The service's configured or resolved worktree root. */
  readonly root: string
  /** The plugin's validated configuration. */
  readonly config: Config
  /**
   * The resolved, validated commit author (from `Config.commitAuthorName`/`commitAuthorEmail`),
   * or `undefined` to use git's own identity.
   */
  readonly commitAuthor: CommitAuthor | undefined
  /** The service's own `resolveReviewer`, so `accept` shares its precedence and independence check. */
  readonly resolveReviewer: (request: ResolveReviewerRequest) => WorktreeRoute
}

/** Transition a record back to `open` and build the outcome from its public shape. */
async function reopen(
  layout: WorktreeLayout, id: WorktreeId, build: (record: WorktreeRecord) => AcceptOutcome,
): Promise<AcceptOutcome> {
  const reopened = await updateExistingRecordAt(layout, id, current => ({ ...current, state: 'open' }))
  return build(toPublicRecord(reopened))
}

/**
 * Best-effort `git worktree remove --force`, logging rather than throwing: a
 * leftover is cleaned up by the next review's stale-directory sweep.
 */
async function removeReviewCheckout(deps: AcceptDeps, repoRoot: string, path: string, signal: AbortSignal): Promise<void> {
  try {
    await deps.git.expect(['worktree', 'remove', '--force', path], 'git worktree remove', { cwd: repoRoot, signal })
  } catch (error) {
    deps.ctx.logger.warn(`subagent-worktree: could not remove review checkout "${path}": ${String(error)}`)
  }
}

/**
 * Remove every leftover `reviews/<id>-*` checkout of this worktree before
 * starting a new one (crash recovery).
 */
async function cleanupStaleReviewDirs(
  deps: AcceptDeps, layout: WorktreeLayout, repoRoot: string, id: WorktreeId, signal: AbortSignal,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(layout.reviewsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const prefix = reviewCheckoutPrefixFor(id)
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const path = join(layout.reviewsDir, entry)
    if (await pathExists(path)) await removeReviewCheckout(deps, repoRoot, path, signal)
  }
}

/** Commit the worktree's staged changes, or reuse `HEAD` when nothing changed since the last accept. */
async function commitWorktreeChanges(deps: AcceptDeps, record: StoredWorktreeRecord, id: WorktreeId, signal: AbortSignal): Promise<string> {
  await deps.git.expect(['add', '-A'], 'git add', { cwd: record.path, signal })
  const staged = await deps.git.run(['diff', '--cached', '--quiet'], { cwd: record.path, signal })
  /* v8 ignore next -- `git diff --cached --quiet` in a worktree the immediately preceding `git add -A` just
   * confirmed valid returns only 0 (clean) or 1 (staged changes) under real git; any other exit code is a
   * host-level git failure (for example a corrupted index) too invasive to construct without a fake git binary. */
  if (staged.exitCode !== 0 && staged.exitCode !== 1) throw new GitCommandError('git diff --cached --quiet', staged)
  if (staged.exitCode === 1) {
    const authorArgs = deps.commitAuthor === undefined
      ? []
      : ['-c', `user.name=${deps.commitAuthor.name}`, '-c', `user.email=${deps.commitAuthor.email}`]
    await deps.git.expect(
      [...authorArgs, 'commit', '--no-verify', '-m', `${record.label} (worktree ${id})`],
      'git commit',
      { cwd: record.path, signal },
    )
  }
  const head = await deps.git.expectComplete(['rev-parse', 'HEAD'], 'git rev-parse', { cwd: record.path, signal })
  return head.stdout.trim()
}

/** Outcome of the check command and reviewer step, run inside one disposable review checkout. */
type CheckAndReviewOutcome =
  | { readonly kind: 'checks-failed'; readonly argv: readonly string[]; readonly exitCode: number | null; readonly output: string }
  | { readonly kind: 'reviewed'; readonly verdict: WorktreeVerdict }

/** Run the configured check command, then the reviewer, in one review checkout at `commit`; the checkout is always removed. */
async function checkAndReview(
  deps: AcceptDeps,
  layout: WorktreeLayout,
  record: StoredWorktreeRecord,
  request: AcceptWorktreeRequest,
  commit: string,
): Promise<CheckAndReviewOutcome> {
  await cleanupStaleReviewDirs(deps, layout, record.repoRoot, request.id, request.signal)
  const reviewPath = reviewCheckoutPathFor(layout, request.id, Date.now())
  await deps.git.expect(['worktree', 'add', '--detach', reviewPath, commit], 'git worktree add', {
    cwd: record.repoRoot, signal: request.signal,
  })
  try {
    const testArgv = request.testCommand ?? deps.config.testCommand
    if (testArgv.length > 0) {
      const checked = await runCheckCommand(deps.ctx.subprocess, testArgv, reviewPath, request.signal, deps.config.checkTimeoutMs)
      if (checked.timedOut || checked.exitCode !== 0) {
        const tail = tailChars(checked.combinedOutput, DIAGNOSTIC_TAIL_CHARS)
        return {
          kind: 'checks-failed',
          argv: testArgv,
          exitCode: checked.exitCode,
          output: checked.timedOut
            ? `${tail}\n[the check command exceeded checkTimeoutMs (${deps.config.checkTimeoutMs} ms) and was terminated]`
            : tail,
        }
      }
    }
    const reviewerRoute = deps.resolveReviewer({
      workerRoute: record.workerRoute,
      callerRoute: callerRouteOf(request.parent),
      ...request.reviewer === undefined ? {} : { override: request.reviewer },
    })
    const verdict = await runReviewer(deps.ctx, deps.git, {
      parent: request.parent,
      reviewDir: reviewPath,
      commit,
      baseCommit: record.baseCommit,
      task: record.task,
      label: record.label,
      reviewerRoute,
      reviewDiffMaxBytes: deps.config.reviewDiffMaxBytes,
      signal: request.signal,
    })
    return { kind: 'reviewed', verdict }
  } finally {
    await removeReviewCheckout(deps, record.repoRoot, reviewPath, request.signal)
  }
}

/**
 * Remove a merged worktree's directory and branch. Logs and returns `false`
 * instead of throwing: the merge already landed and was recorded, so a cleanup
 * failure must not turn a merged outcome into an error. `discard` finishes a
 * leftover worktree or branch of a `merged` record.
 * @returns whether both the directory and the branch were removed.
 */
async function removeMergedWorktree(
  deps: AcceptDeps, record: StoredWorktreeRecord, mergeCommit: string, signal: AbortSignal,
): Promise<boolean> {
  try {
    await deps.git.expect(['worktree', 'remove', '--force', record.path], 'git worktree remove', { cwd: record.repoRoot, signal })
    await deps.git.expect(['branch', '-D', record.branch], 'git branch -D', { cwd: record.repoRoot, signal })
    return true
  } catch (error) {
    deps.ctx.logger.warn(
      `subagent-worktree: worktree ${record.id} merged as ${mergeCommit}, but removing its worktree and branch failed: ${String(error)}`,
    )
    return false
  }
}

/**
 * Commit, check, review, and merge one worktree.
 * @param deps - host context, command runner, root, config, and `resolveReviewer`.
 * @param request - worktree id, owner, reviewer parent Agent, operator overrides, and cancellation.
 * @returns the accept outcome.
 * @throws when `request.testCommand` or `request.reviewer` is set by a non-operator owner, the record is not found,
 *   not owned by `request.owner`, not `open` (or stale `reviewing`), or an attached worker is still running. Any git,
 *   subprocess, or reviewer failure before the merge lands rethrows after returning a still-`reviewing` record to
 *   `open`. A failure after the merge commit exists rethrows without touching the record's state; a failed write of
 *   the `merged` state says the merge landed.
 */
export async function acceptWorktree(deps: AcceptDeps, request: AcceptWorktreeRequest): Promise<AcceptOutcome> {
  // `testCommand` runs an operator-supplied argv with host privileges and
  // `reviewer` picks the model that judges the change: only the operator (the
  // local user acting through `dsh agents`) may set either, never a session
  // owner acting on a model's behalf.
  if (request.owner.kind !== 'operator' && (request.testCommand !== undefined || request.reviewer !== undefined)) {
    throw new Error('subagent-worktree: the testCommand and reviewer overrides of accept are operator-only')
  }

  const located = await requireRecordLocation(deps.root, request.id)
  assertOwnerAuthority(located.record, request.owner, request.id)

  // The state and running-worker checks run only here, under the record lock:
  // two concurrent accepts (or an accept racing a worker restart) both pass
  // any check made on their own earlier reads, but only the lock serializes
  // the transition, so checking before acquiring it would not close the race.
  const reviewing = await updateExistingRecordAt(located.layout, request.id, (current) => {
    assertOpenOrRecoverable(current, request.id)
    assertNoRunningWorkers(deps.ctx.agents, current, request.id)
    return { ...current, state: 'reviewing', reviewingPid: process.pid }
  })

  let mergeLanded = false
  try {
    const commit = await commitWorktreeChanges(deps, reviewing, request.id, request.signal)
    if (commit === reviewing.baseCommit) {
      return await reopen(located.layout, request.id, record => ({ kind: 'empty', record }))
    }

    const reused = reviewing.lastVerdict
    let verdict: WorktreeVerdict
    if (reused !== undefined && reused.verdict === 'pass' && reused.commit === commit) {
      verdict = reused
    } else {
      const outcome = await checkAndReview(deps, located.layout, reviewing, request, commit)
      if (outcome.kind === 'checks-failed') {
        return await reopen(located.layout, request.id, record => ({
          kind: 'checks-failed', record, commit, argv: outcome.argv, exitCode: outcome.exitCode, output: outcome.output,
        }))
      }
      verdict = outcome.verdict
      await updateExistingRecordAt(located.layout, request.id, current => ({ ...current, lastVerdict: verdict }))
    }

    if (verdict.verdict === 'fail') {
      return await reopen(located.layout, request.id, record => ({ kind: 'rejected', record, commit, verdict }))
    }

    // The merge lock covers only the merge itself: recording the result and
    // removing the worktree happen after it is released, so a slow removal
    // never holds up another accept's merge into the same base checkout.
    const mergeResult = await withFileLock(
      located.layout.mergeLockPath,
      () => attemptMerge(deps.git, reviewing.repoRoot, request.id, reviewing.label, commit, request.signal),
      { waitMs: MERGE_LOCK_WAIT_MS },
    )
    if (mergeResult.kind === 'conflict') {
      return await reopen(located.layout, request.id, record => ({ kind: 'conflict', record, commit, verdict, files: mergeResult.files }))
    }
    if (mergeResult.kind === 'blocked') {
      return await reopen(located.layout, request.id, record => ({ kind: 'blocked', record, commit, verdict, reason: mergeResult.reason }))
    }

    // The merge commit now exists in the base checkout's history. From here no
    // failure may reopen the record: reporting `open` for work that already
    // landed would invite a second merge of the same branch.
    mergeLanded = true
    let merged: StoredWorktreeRecord
    try {
      merged = await updateExistingRecordAt(located.layout, request.id, current => ({
        ...current, state: 'merged', mergedCommit: mergeResult.mergeCommit,
      }))
    } catch (error) {
      throw new Error(
        `subagent-worktree: the merge of worktree ${request.id} landed in the base checkout as ${mergeResult.mergeCommit}, `
        + `but recording it failed; the worktree record still says reviewing: ${String(error)}`,
        { cause: error },
      )
    }
    const removed = deps.config.removeOnMerge && await removeMergedWorktree(deps, reviewing, mergeResult.mergeCommit, request.signal)
    return { kind: 'merged', record: toPublicRecord(merged), commit, mergeCommit: mergeResult.mergeCommit, verdict, removed }
  } catch (error) {
    if (!mergeLanded) {
      await updateExistingRecordAt(located.layout, request.id, current => (
        current.state === 'reviewing' ? { ...current, state: 'open' } : current
      )).catch((revertError: unknown) => {
        deps.ctx.logger.warn(`subagent-worktree: could not reopen worktree ${request.id} after a failed accept: ${String(revertError)}`)
      })
    }
    throw error
  }
}
