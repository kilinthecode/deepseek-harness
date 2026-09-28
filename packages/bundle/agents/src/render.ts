/**
 * Human-readable lines and NDJSON event payloads for `dsh agents`. Every
 * function here is pure: it turns a domain value (a worktree record, a
 * subagent result, a review verdict, an accept outcome) into display text or a
 * JSON-serializable event, with no I/O of its own. `--json` mode writes the
 * event payloads one per line; the default mode writes the text lines.
 * @module @deepseek-ai/dsh-agents/render
 */

import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { AcceptOutcome, DirtySummary, WorktreeRecord, WorktreeRoute, WorktreeVerdict } from '@deepseek-ai/dsh-subagent-worktree'

/** `--json` event reporting a worktree ready for the worker, freshly created or reused. */
export interface WorktreeEvent {
  readonly type: 'worktree'
  readonly id: string
  readonly path: string
  readonly branch: string
  readonly baseCommit: string
  readonly reused: boolean
  /** Present only for a freshly created worktree whose base checkout had uncommitted changes it does not contain. */
  readonly baseDirty?: DirtySummary
}

/** `--json` event reporting one row of `dsh agents list`. */
export interface ListEvent {
  readonly type: 'worktree'
  readonly id: string
  readonly path: string
  readonly branch: string
  readonly baseCommit: string
  readonly state: string
  readonly label: string
  readonly verdict?: 'pass' | 'fail'
}

/** `--json` event reporting a worker or fixer child's terminal outcome. */
export interface WorkerEvent {
  readonly type: 'worker'
  readonly sessionId: string
  readonly route: WorktreeRoute
  readonly stopReason: SubagentStopReason
}

/** `--json` event reporting the reviewer's verdict on one commit. */
export interface ReviewEvent {
  readonly type: 'review'
  readonly verdict: 'pass' | 'fail'
  readonly commit: string
  readonly reviewer: string
  readonly summary: string
  readonly findings: readonly string[]
}

/**
 * `--json` event reporting one accept or discard result. Mirrors
 * {@link AcceptOutcome}'s kinds, plus `discarded` for the `discard` verb.
 */
export type OutcomeEvent =
  | { readonly type: 'outcome'; readonly kind: 'merged'; readonly id: string; readonly commit: string; readonly mergeCommit: string; readonly removed: boolean }
  | { readonly type: 'outcome'; readonly kind: 'rejected'; readonly id: string; readonly commit: string; readonly summary: string; readonly findings: readonly string[] }
  | { readonly type: 'outcome'; readonly kind: 'checks-failed'; readonly id: string; readonly commit: string; readonly argv: readonly string[]; readonly exitCode: number | null; readonly output: string }
  | { readonly type: 'outcome'; readonly kind: 'conflict'; readonly id: string; readonly commit: string; readonly files: readonly string[] }
  | { readonly type: 'outcome'; readonly kind: 'blocked'; readonly id: string; readonly commit: string; readonly reason: string }
  | { readonly type: 'outcome'; readonly kind: 'empty'; readonly id: string }
  | { readonly type: 'outcome'; readonly kind: 'discarded'; readonly id: string; readonly branch: string }

/** `--json` event reporting a run-level failure that stopped before an outcome was reached. */
export interface ErrorEvent {
  readonly type: 'error'
  readonly message: string
}

/** The complete `dsh agents` NDJSON vocabulary. */
export type AgentsEvent = WorktreeEvent | WorkerEvent | ReviewEvent | OutcomeEvent | ErrorEvent | ListEvent

/** First seven hex characters of a commit id, the display convention used throughout `dsh agents`. */
function short(commit: string): string {
  return commit.slice(0, 7)
}

/** Build the `worktree` event for a freshly created or reused worktree. */
export function worktreeEvent(
  record: Pick<WorktreeRecord, 'id' | 'path' | 'branch' | 'baseCommit'>,
  reused: boolean,
  baseDirty?: DirtySummary,
): WorktreeEvent {
  return {
    type: 'worktree', id: record.id, path: record.path, branch: record.branch, baseCommit: record.baseCommit, reused,
    ...baseDirty === undefined ? {} : { baseDirty },
  }
}

/** Human line for a freshly created or reused worktree. */
export function worktreeLine(
  record: Pick<WorktreeRecord, 'id' | 'path' | 'branch' | 'baseCommit'>,
  reused: boolean,
  baseDirty?: DirtySummary,
): string {
  const verb = reused ? 'Reusing' : 'Created'
  const base = `${verb} worktree ${record.id} at ${record.path} (branch ${record.branch}, base ${short(record.baseCommit)}).`
  if (baseDirty === undefined) return base
  return `${base} Your checkout has ${String(baseDirty.total)} uncommitted change(s) that the worktree does not contain.`
}

/** Build the `worktree` event for one `dsh agents list` row. */
export function listEvent(record: WorktreeRecord): ListEvent {
  return {
    type: 'worktree', id: record.id, path: record.path, branch: record.branch, baseCommit: record.baseCommit,
    state: record.state, label: record.label,
    ...record.lastVerdict === undefined ? {} : { verdict: record.lastVerdict.verdict },
  }
}

/** Build the `worker` event for a settled worker or fixer child. */
export function workerEvent(sessionId: string, route: WorktreeRoute, stopReason: SubagentStopReason): WorkerEvent {
  return { type: 'worker', sessionId, route, stopReason }
}

/** Human line for a settled worker or fixer child. */
export function workerLine(sessionId: string, route: WorktreeRoute, stopReason: SubagentStopReason): string {
  return `Worker ${sessionId} (${route.provider}/${route.model}) finished: ${stopReason}.`
}

/** Build the `review` event from a recorded verdict. */
export function reviewEvent(verdict: WorktreeVerdict): ReviewEvent {
  return {
    type: 'review',
    verdict: verdict.verdict,
    commit: verdict.commit,
    reviewer: `${verdict.reviewerRoute.provider}/${verdict.reviewerRoute.model}`,
    summary: verdict.summary,
    findings: verdict.findings,
  }
}

/** Human line for a recorded verdict. */
export function reviewLine(verdict: WorktreeVerdict): string {
  return `Reviewer ${verdict.reviewerRoute.provider}/${verdict.reviewerRoute.model} at ${short(verdict.commit)}: `
    + `${verdict.verdict} — ${verdict.summary}`
}

/** The verdict a merged, rejected, conflicted, or blocked outcome carries; the other kinds carry none. */
export function outcomeVerdict(outcome: AcceptOutcome): WorktreeVerdict | undefined {
  return outcome.kind === 'merged' || outcome.kind === 'rejected'
    || outcome.kind === 'conflict' || outcome.kind === 'blocked'
    ? outcome.verdict
    : undefined
}

/** Build the `outcome` event for one accept result. */
export function outcomeEvent(outcome: AcceptOutcome): OutcomeEvent {
  switch (outcome.kind) {
    case 'merged':
      return { type: 'outcome', kind: 'merged', id: outcome.record.id, commit: outcome.commit, mergeCommit: outcome.mergeCommit, removed: outcome.removed }
    case 'rejected':
      return { type: 'outcome', kind: 'rejected', id: outcome.record.id, commit: outcome.commit, summary: outcome.verdict.summary, findings: outcome.verdict.findings }
    case 'checks-failed':
      return { type: 'outcome', kind: 'checks-failed', id: outcome.record.id, commit: outcome.commit, argv: outcome.argv, exitCode: outcome.exitCode, output: outcome.output }
    case 'conflict':
      return { type: 'outcome', kind: 'conflict', id: outcome.record.id, commit: outcome.commit, files: outcome.files }
    case 'blocked':
      return { type: 'outcome', kind: 'blocked', id: outcome.record.id, commit: outcome.commit, reason: outcome.reason }
    case 'empty':
      return { type: 'outcome', kind: 'empty', id: outcome.record.id }
    /* v8 ignore next 2 -- AcceptOutcome is a closed union covering every SubagentWorktrees.accept result. */
    default:
      throw new Error(`dsh-agents: unknown accept outcome kind ${JSON.stringify((outcome as { kind: string }).kind)}`)
  }
}

/** Human line for one accept result. */
export function outcomeLine(outcome: AcceptOutcome): string {
  switch (outcome.kind) {
    case 'merged':
      return `Merged worktree ${outcome.record.id}: commit ${short(outcome.commit)} as merge ${short(outcome.mergeCommit)}.`
        + (outcome.removed ? ' The worktree was removed; start a new one for further work.' : '')
    case 'rejected':
      return `Review failed for worktree ${outcome.record.id} at ${short(outcome.commit)}: ${outcome.verdict.summary}\n`
        + findingsBlock(outcome.verdict.findings)
    case 'checks-failed':
      return `Checks failed for worktree ${outcome.record.id} at ${short(outcome.commit)}: `
        + `\`${outcome.argv.join(' ')}\` exited ${String(outcome.exitCode)}.\n${outcome.output}`
    case 'conflict':
      return `Worktree ${outcome.record.id} passed review at ${short(outcome.commit)} but conflicts with your checkout `
        + `in: ${outcome.files.join(', ')}. Nothing was merged; merge the branch yourself or discard the worktree.`
    case 'blocked':
      return `Worktree ${outcome.record.id} passed review at ${short(outcome.commit)}, but the merge could not start: ${outcome.reason}`
    case 'empty':
      return `Worktree ${outcome.record.id} has no changes to accept.`
    /* v8 ignore next 2 -- AcceptOutcome is a closed union covering every SubagentWorktrees.accept result. */
    default:
      throw new Error(`dsh-agents: unknown accept outcome kind ${JSON.stringify((outcome as { kind: string }).kind)}`)
  }
}

/** Render one finding per line, prefixed for a rejected outcome's human text. */
function findingsBlock(findings: readonly string[]): string {
  return findings.length === 0
    ? 'Findings: none reported.'
    : `Findings:\n${findings.map(finding => `- ${finding}`).join('\n')}`
}

/** Build the `outcome` event for a successful discard. */
export function discardEvent(id: string, branch: string): OutcomeEvent {
  return { type: 'outcome', kind: 'discarded', id, branch }
}

/** Human line for a successful discard. */
export function discardLine(id: string, branch: string): string {
  return `Discarded worktree ${id} and branch ${branch}.`
}

/** Build the `error` event for a run-level failure. */
export function errorEvent(message: string): ErrorEvent {
  return { type: 'error', message }
}

/** Human line for a run-level failure, matching the `dsh: <message>` convention every dsh app uses. */
export function errorLine(message: string): string {
  return `dsh: ${message}`
}

/** One `dsh agents list` row: id, state, branch, label, and the latest verdict or `not reviewed`. */
export function listLine(record: WorktreeRecord): string {
  const verdict = record.lastVerdict?.verdict ?? 'not reviewed'
  return `${record.id}  ${record.state}  ${record.branch}  ${record.label}  ${verdict}`
}

/**
 * The process exit code for an accept outcome: `0` for a landed merge, `2`
 * for every other outcome (a passing worktree is never itself an error).
 * @param outcome - the settled accept outcome.
 * @returns `0` or `2`.
 */
export function exitCodeForOutcome(outcome: AcceptOutcome): 0 | 2 {
  return outcome.kind === 'merged' ? 0 : 2
}

/** Whether a fix round may retry this outcome: only a review or check failure is fixable. */
export function isFixable(outcome: AcceptOutcome): outcome is Extract<AcceptOutcome, { kind: 'rejected' | 'checks-failed' }> {
  return outcome.kind === 'rejected' || outcome.kind === 'checks-failed'
}
