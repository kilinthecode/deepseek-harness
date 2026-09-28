/**
 * The `accept` operation: the only operation that commits or merges. Commits
 * a finished worker's changes on its behalf, runs the configured check
 * command, has an independent reviewer child check the exact commit (skipping
 * a repeat review for a commit that already passed), and merges only a
 * passing change into the base checkout. Every non-`merged` outcome leaves
 * the worktree `open`; any thrown error also returns it to `open` before
 * rethrowing.
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
async function reopen(path: string, id: WorktreeId, build: (record: WorktreeRecord) => AcceptOutcome): Promise<AcceptOutcome> {
  const reopened = await updateExistingRecordAt(path, id, current => ({ ...current, state: 'open' }))
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
  const head = await deps.git.expect(['rev-parse', 'HEAD'], 'git rev-parse', { cwd: record.path, signal })
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
      const checked = await runCheckCommand(deps.ctx.subprocess, testArgv, reviewPath, request.signal)
      if (checked.exitCode !== 0) {
        return {
          kind: 'checks-failed',
          argv: testArgv,
          exitCode: checked.exitCode,
          output: tailChars(checked.combinedOutput, DIAGNOSTIC_TAIL_CHARS),
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
 * Commit, check, review, and merge one worktree.
 * @param deps - host context, command runner, root, config, and `resolveReviewer`.
 * @param request - worktree id, owner, reviewer parent Agent, operator overrides, and cancellation.
 * @returns the accept outcome.
 * @throws when the record is not found, not owned by `request.owner`, not `open` (or stale `reviewing`),
 *   or an attached worker is still running; also rethrows any git, subprocess, or reviewer failure after
 *   returning a still-`reviewing` record to `open`.
 */
export async function acceptWorktree(deps: AcceptDeps, request: AcceptWorktreeRequest): Promise<AcceptOutcome> {
  const located = await requireRecordLocation(deps.root, request.id)
  assertOwnerAuthority(located.record, request.owner, request.id)
  assertNoRunningWorkers(deps.ctx, located.record, request.id)

  // The open/stale-reviewing/terminal check runs only here, under the record
  // lock: two concurrent accepts both pass ownership and worker checks on
  // their own reads, but only the lock serializes the state transition, so
  // checking state before acquiring it would not actually close the race.
  const reviewing = await updateExistingRecordAt(located.path, request.id, (current) => {
    assertOpenOrRecoverable(current, request.id)
    return { ...current, state: 'reviewing', reviewingPid: process.pid, reviewingStartedAt: Date.now() }
  })

  try {
    const commit = await commitWorktreeChanges(deps, reviewing, request.id, request.signal)
    if (commit === reviewing.baseCommit) {
      return await reopen(located.path, request.id, record => ({ kind: 'empty', record }))
    }

    const reused = reviewing.lastVerdict
    let verdict: WorktreeVerdict
    if (reused !== undefined && reused.verdict === 'pass' && reused.commit === commit) {
      verdict = reused
    } else {
      const outcome = await checkAndReview(deps, located.layout, reviewing, request, commit)
      if (outcome.kind === 'checks-failed') {
        return await reopen(located.path, request.id, record => ({
          kind: 'checks-failed', record, commit, argv: outcome.argv, exitCode: outcome.exitCode, output: outcome.output,
        }))
      }
      verdict = outcome.verdict
      await updateExistingRecordAt(located.path, request.id, current => ({ ...current, lastVerdict: verdict }))
    }

    if (verdict.verdict === 'fail') {
      return await reopen(located.path, request.id, record => ({ kind: 'rejected', record, commit, verdict }))
    }

    return await withFileLock(located.layout.mergeLockPath, async (): Promise<AcceptOutcome> => {
      const mergeResult = await attemptMerge(deps.git, reviewing.repoRoot, request.id, reviewing.label, commit, request.signal)
      if (mergeResult.kind === 'conflict') {
        return reopen(located.path, request.id, record => ({ kind: 'conflict', record, commit, verdict, files: mergeResult.files }))
      }
      if (mergeResult.kind === 'blocked') {
        return reopen(located.path, request.id, record => ({ kind: 'blocked', record, commit, verdict, reason: mergeResult.reason }))
      }
      // Record the merge fact before any cleanup that could still fail: the
      // merge itself already landed, so a later cleanup failure must not make
      // this report a state that contradicts the base checkout's real history.
      const merged = await updateExistingRecordAt(located.path, request.id, current => ({
        ...current, state: 'merged', mergedCommit: mergeResult.mergeCommit,
      }))
      let removed = false
      if (deps.config.removeOnMerge) {
        await deps.git.expect(['worktree', 'remove', '--force', reviewing.path], 'git worktree remove', {
          cwd: reviewing.repoRoot, signal: request.signal,
        })
        await deps.git.expect(['branch', '-D', reviewing.branch], 'git branch -D', {
          cwd: reviewing.repoRoot, signal: request.signal,
        })
        removed = true
      }
      return { kind: 'merged', record: toPublicRecord(merged), commit, mergeCommit: mergeResult.mergeCommit, verdict, removed }
    })
  } catch (error) {
    await updateExistingRecordAt(located.path, request.id, current => (
      current.state === 'reviewing' ? { ...current, state: 'open' } : current
    )).catch((revertError: unknown) => {
      deps.ctx.logger.warn(`subagent-worktree: could not reopen worktree ${request.id} after a failed accept: ${String(revertError)}`)
    })
    throw error
  }
}
