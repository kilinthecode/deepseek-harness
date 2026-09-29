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
import { cleanupSignal, GitCommandError, type GitRunner } from './git.ts'
import { recoverLandedMerge, sweepWorktree } from './landed.ts'
import type { LandedRecovery } from './landed.ts'
import { attemptMerge } from './merge.ts'
import type { MergeAttemptResult } from './merge.ts'
import { reviewCheckoutPathFor, reviewCheckoutPrefixFor } from './paths.ts'
import type { WorktreeLayout } from './paths.ts'
import { pathExists } from './fs-util.ts'
import {
  assertOpenOrRecoverable, assertOwnerAuthority, requireRecordLocation, toPublicRecord, updateExistingRecordAt, withoutReviewingPid,
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

/**
 * The record after an accept that did not merge: a `reviewing` record returns
 * to `open` and releases its accept claim. A record in any other state was
 * moved on while the accept ran (discarded, or recorded merged by a recovery)
 * and is left as it is, so an accept never reopens a closed record.
 */
function reopenedRecord(current: StoredWorktreeRecord): StoredWorktreeRecord {
  if (current.state !== 'reviewing') return current
  return { ...withoutReviewingPid(current), state: 'open' }
}

/** Return a still-`reviewing` record to `open` and build the outcome from the record as stored afterwards. */
async function reopen(
  layout: WorktreeLayout, id: WorktreeId, build: (record: WorktreeRecord) => AcceptOutcome,
): Promise<AcceptOutcome> {
  const reopened = await updateExistingRecordAt(layout, id, reopenedRecord)
  return build(toPublicRecord(reopened))
}

/**
 * Best-effort `git worktree remove --force` on a fresh signal, logging rather
 * than throwing: the accept's own signal is often why it is unwinding, and a
 * command started on an aborted signal never runs. A leftover is cleaned up by
 * the next review's stale-directory sweep.
 */
async function removeReviewCheckout(deps: AcceptDeps, repoRoot: string, path: string): Promise<void> {
  try {
    await deps.git.expect(['worktree', 'remove', '--force', path], 'git worktree remove', { cwd: repoRoot, signal: cleanupSignal() })
  } catch (error) {
    deps.ctx.logger.warn(`subagent-worktree: could not remove review checkout "${path}": ${String(error)}`)
  }
}

/**
 * Remove every leftover `reviews/<id>-*` checkout of this worktree before
 * starting a new one (crash recovery).
 */
async function cleanupStaleReviewDirs(
  deps: AcceptDeps, layout: WorktreeLayout, repoRoot: string, id: WorktreeId,
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
    if (await pathExists(path)) await removeReviewCheckout(deps, repoRoot, path)
  }
}

/**
 * Commit the worktree's staged changes, or reuse `HEAD` when nothing changed since the last accept. A worker
 * restarted after the claim would race the commit, so running workers are checked again right before `git add`.
 * @throws when an attached worker's Agent is running.
 */
async function commitWorktreeChanges(deps: AcceptDeps, record: StoredWorktreeRecord, id: WorktreeId, signal: AbortSignal): Promise<string> {
  assertNoRunningWorkers(deps.ctx.agents, record, id)
  await deps.git.expect(['add', '-A'], 'git add', { cwd: record.path, signal })
  const staged = await deps.git.run(
    // Asked for submodule changes whatever `diff.ignoreSubmodules` or `submodule.<name>.ignore` say, so a config
    // that hides them from `git diff` cannot make the change `git add -A` just staged read as an empty one.
    ['diff', '--cached', '--quiet', '--ignore-submodules=none'],
    { cwd: record.path, signal },
  )
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
  await cleanupStaleReviewDirs(deps, layout, record.repoRoot, request.id)
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
    await removeReviewCheckout(deps, record.repoRoot, reviewPath)
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
  deps: AcceptDeps, record: StoredWorktreeRecord, mergeCommit: string,
): Promise<boolean> {
  try {
    await deps.git.expect(['worktree', 'remove', '--force', record.path], 'git worktree remove', {
      cwd: record.repoRoot, signal: cleanupSignal(),
    })
    await deps.git.expect(['branch', '-D', record.branch], 'git branch -D', { cwd: record.repoRoot, signal: cleanupSignal() })
    return true
  } catch (error) {
    deps.ctx.logger.warn(
      `subagent-worktree: worktree ${record.id} merged as ${mergeCommit}, but removing its worktree and branch failed: ${String(error)}`,
    )
    return false
  }
}

/**
 * Best-effort release of this process's accept claim (`reviewingPid`), for a record write that failed while the
 * claim was held. A claim held by a live process pins the record as "being accepted" until that process exits; a
 * record `reviewing` with no claim reads as stale, which the next `accept` or `discard` can recover. The release
 * write can fail for the same reason the write before it did, so its failure is logged, not thrown.
 */
async function releaseClaim(deps: AcceptDeps, layout: WorktreeLayout, id: WorktreeId): Promise<void> {
  await updateExistingRecordAt(layout, id, withoutReviewingPid).catch((clearError: unknown) => {
    deps.ctx.logger.warn(`subagent-worktree: could not release the accept claim on worktree ${id}: ${String(clearError)}`)
  })
}

/** An error raised after the merge landed: the base checkout changed even though the accept failed. */
class MergeLandedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'MergeLandedError'
  }
}

/** What the merge step settled with: a merge outcome, or a merge that landed whose commit id could not be read. */
type MergeStep = MergeAttemptResult | { readonly kind: 'unreadable'; readonly cause: unknown }

/**
 * Persist `merged` (and the merge commit, when it is known) in one write. When
 * the write fails, this process's claim is released so a live process id does
 * not pin the record as "being accepted": a later accept or discard finds the
 * reviewed commit already in the base checkout and records it.
 * @throws {MergeLandedError} when the write failed.
 */
async function recordLandedMerge(
  deps: AcceptDeps, layout: WorktreeLayout, id: WorktreeId, mergeCommit: string | undefined,
): Promise<StoredWorktreeRecord> {
  try {
    return await updateExistingRecordAt(layout, id, current => ({
      ...withoutReviewingPid(current), state: 'merged', ...mergeCommit === undefined ? {} : { mergedCommit: mergeCommit },
    }))
  } catch (writeError) {
    await releaseClaim(deps, layout, id)
    throw new MergeLandedError(
      `subagent-worktree: the merge of worktree ${id} landed in the base checkout${mergeCommit === undefined ? '' : ` as ${mergeCommit}`}, `
      + `but recording it failed; the worktree record still says reviewing: ${String(writeError)}`,
      writeError,
    )
  }
}

/**
 * The outcome for a worktree that an earlier, crashed accept had already
 * merged: it is now recorded `merged`, and a leftover worktree or branch is
 * swept when `removeOnMerge` is set.
 * @throws {MergeLandedError} when the commit that landed it could not be read. The record is `merged` either way, so
 *   nothing reopens it; only the id is missing, and `discard` still clears any leftover worktree or branch.
 */
async function outcomeOfRecoveredMerge(deps: AcceptDeps, recovery: LandedRecovery): Promise<AcceptOutcome> {
  const { record, verdict, mergeCommit } = recovery
  if (mergeCommit === undefined) {
    throw new MergeLandedError(
      `subagent-worktree: the merge of worktree ${record.id} landed in the base checkout and is recorded merged, `
      + 'but its commit id could not be read',
    )
  }
  let removed = false
  if (deps.config.removeOnMerge) {
    try {
      await sweepWorktree(deps.git, record, cleanupSignal)
      removed = true
    } catch (error) {
      deps.ctx.logger.warn(
        `subagent-worktree: worktree ${record.id} was already merged as ${mergeCommit}, but removing its worktree and branch failed: ${String(error)}`,
      )
    }
  }
  return { kind: 'merged', record: toPublicRecord(record), commit: verdict.commit, mergeCommit, verdict, removed }
}

/**
 * Commit, check, review, and merge one worktree.
 * @param deps - host context, command runner, root, config, and `resolveReviewer`.
 * @param request - worktree id, owner, reviewer parent Agent, operator overrides, and cancellation.
 * @returns the accept outcome. A stale `reviewing` record whose reviewed commit already landed (an earlier accept
 *   crashed before recording it) is recorded `merged` and reported as `merged` without a second review or merge;
 *   when the commit that landed it cannot be read, the record is still recorded `merged` without a `mergedCommit`
 *   and the error thrown says the merge landed, exactly as for this accept's own merge.
 * @throws when `request.testCommand` or `request.reviewer` is set by a non-operator owner, the record is not found,
 *   not owned by `request.owner`, not `open` (or stale `reviewing`), or an attached worker is still running. Any git,
 *   subprocess, or reviewer failure before the merge lands rethrows after returning a still-`reviewing` record to
 *   `open`. Once `git merge` has exited 0 the record is never reopened: a failed write of the `merged` state, or a
 *   merge commit id that cannot be read — this accept's merge or a recovered one — throws an error that says the
 *   merge landed.
 */
export async function acceptWorktree(deps: AcceptDeps, request: AcceptWorktreeRequest): Promise<AcceptOutcome> {
  // `testCommand` runs an operator-supplied argv with host privileges and
  // `reviewer` picks the model that judges the change: only the operator (the
  // local user acting through `dsh agents`) may set either, never a session
  // owner acting on a model's behalf.
  if (request.owner.kind !== 'operator' && (request.testCommand !== undefined || request.reviewer !== undefined)) {
    throw new Error('subagent-worktree: the testCommand and reviewer overrides of accept are operator-only')
  }

  const located = await requireRecordLocation(deps.root, request.id, (message) => { deps.ctx.logger.warn(message) })
  assertOwnerAuthority(located.record, request.owner, request.id)

  // An earlier accept that died after its merge landed but before recording it left a stale `reviewing`
  // record whose reviewed commit is already in the base checkout: record it `merged`, never re-merge it.
  const recovery = await recoverLandedMerge(deps.git, located.layout, located.record, request.signal, (message) => {
    deps.ctx.logger.warn(message)
  })
  if (recovery !== undefined) return await outcomeOfRecoveredMerge(deps, recovery)

  // The state and running-worker checks run only here, under the record lock:
  // two concurrent accepts (or an accept racing a worker restart) both pass
  // any check made on their own earlier reads, but only the lock serializes
  // the transition, so checking before acquiring it would not close the race.
  const reviewing = await updateExistingRecordAt(located.layout, request.id, (current) => {
    assertOpenOrRecoverable(current, request.id)
    assertNoRunningWorkers(deps.ctx.agents, current, request.id)
    return { ...current, state: 'reviewing', reviewingPid: process.pid }
  })

  const landing = { landed: false }
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
    const step: MergeStep = await withFileLock(
      located.layout.mergeLockPath,
      () => attemptMerge(deps.git, reviewing.repoRoot, request.id, reviewing.label, commit, request.signal, {
        // The review may have run for minutes: a worker restarted since would race the merge, so check once more.
        beforeMerge: () => { assertNoRunningWorkers(deps.ctx.agents, reviewing, request.id) },
        onLanded: () => { landing.landed = true },
        report: (message) => { deps.ctx.logger.error(message) },
      }),
      { waitMs: MERGE_LOCK_WAIT_MS },
    ).catch((error: unknown): MergeStep => {
      // `git merge` exited 0 (`onLanded` ran) but reading the merge commit failed even on a retry.
      if (landing.landed) return { kind: 'unreadable', cause: error }
      throw error
    })
    if (step.kind === 'conflict') {
      return await reopen(located.layout, request.id, record => ({ kind: 'conflict', record, commit, verdict, files: step.files }))
    }
    if (step.kind === 'blocked') {
      return await reopen(located.layout, request.id, record => ({ kind: 'blocked', record, commit, verdict, reason: step.reason }))
    }

    // The merge landed in the base checkout's history (`onLanded` marked it the
    // instant `git merge` exited 0). From here no failure may reopen the
    // record: reporting `open` for work that already landed would invite a
    // second merge of the same branch.
    const merged = await recordLandedMerge(deps, located.layout, request.id, step.kind === 'merged' ? step.mergeCommit : undefined)
    if (step.kind === 'unreadable') {
      throw new MergeLandedError(
        `subagent-worktree: the merge of worktree ${request.id} landed in the base checkout and is recorded merged, `
        + `but its commit id could not be read: ${String(step.cause)}`,
        step.cause,
      )
    }
    const removed = deps.config.removeOnMerge && await removeMergedWorktree(deps, reviewing, step.mergeCommit)
    return { kind: 'merged', record: toPublicRecord(merged), commit, mergeCommit: step.mergeCommit, verdict, removed }
  } catch (error) {
    if (!landing.landed) {
      await updateExistingRecordAt(located.layout, request.id, reopenedRecord).catch(async (revertError: unknown) => {
        await releaseClaim(deps, located.layout, request.id)
        deps.ctx.logger.warn(`subagent-worktree: could not reopen worktree ${request.id} after a failed accept: ${String(revertError)}`)
      })
    }
    throw error
  }
}
