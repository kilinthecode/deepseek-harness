/**
 * Declared result schemas and verbatim render templates for the worktree
 * tools. Pure mappings from `@deepseek-ai/dsh-subagent-worktree` domain
 * values to the compact JSON each tool returns and the text the model reads.
 * Neither direction depends on Cordis or tool execution, so every outcome
 * branch is unit-testable without booting a Context.
 * @module @deepseek-ai/dsh-tool-subagent-worktree/values
 */

import type { AcceptOutcome, WorktreeRecord } from '@deepseek-ai/dsh-subagent-worktree'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'

const REVIEWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
  },
} as const

const MERGED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'merged' },
    id: { type: 'string', required: true },
    repoRoot: { type: 'string', required: true },
    commit: { type: 'string', required: true },
    mergeCommit: { type: 'string', required: true },
    reviewer: { ...REVIEWER_SCHEMA, required: true },
    summary: { type: 'string', required: true },
    removed: { type: 'boolean', required: true },
  },
} as const

const REJECTED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'rejected' },
    id: { type: 'string', required: true },
    commit: { type: 'string', required: true },
    reviewer: { ...REVIEWER_SCHEMA, required: true },
    summary: { type: 'string', required: true },
    findings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const CHECKS_FAILED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'checks-failed' },
    id: { type: 'string', required: true },
    commit: { type: 'string', required: true },
    argv: { type: 'array', required: true, items: { type: 'string' } },
    // Absent when the check process left no exit code (for example, killed by a signal).
    exitCode: { type: 'number' },
    output: { type: 'string', required: true },
  },
} as const

const CONFLICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'conflict' },
    id: { type: 'string', required: true },
    commit: { type: 'string', required: true },
    branch: { type: 'string', required: true },
    files: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const BLOCKED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'blocked' },
    id: { type: 'string', required: true },
    commit: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
} as const

const EMPTY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'empty' },
    id: { type: 'string', required: true },
  },
} as const

/** Declared `accept_worktree` output schema: one arm per {@link AcceptOutcome} kind. */
export const ACCEPT_VALUE_SCHEMA = {
  oneOf: [MERGED_SCHEMA, REJECTED_SCHEMA, CHECKS_FAILED_SCHEMA, CONFLICT_SCHEMA, BLOCKED_SCHEMA, EMPTY_SCHEMA],
} as const

/** Canonical `accept_worktree` result, inferred from {@link ACCEPT_VALUE_SCHEMA}. */
export type AcceptToolValue = InferValue<typeof ACCEPT_VALUE_SCHEMA>

/**
 * Project one service {@link AcceptOutcome} into the tool's declared value.
 * @param outcome - the outcome `ctx.subagentWorktrees.accept()` settled with.
 * @returns the canonical `accept_worktree` result for that outcome.
 */
export function toAcceptToolValue(outcome: AcceptOutcome): AcceptToolValue {
  switch (outcome.kind) {
    case 'merged':
      return {
        kind: 'merged',
        id: outcome.record.id,
        repoRoot: outcome.record.repoRoot,
        commit: outcome.commit,
        mergeCommit: outcome.mergeCommit,
        reviewer: { provider: outcome.verdict.reviewerRoute.provider, model: outcome.verdict.reviewerRoute.model },
        summary: outcome.verdict.summary,
        removed: outcome.removed,
      }
    case 'rejected':
      return {
        kind: 'rejected',
        id: outcome.record.id,
        commit: outcome.commit,
        reviewer: { provider: outcome.verdict.reviewerRoute.provider, model: outcome.verdict.reviewerRoute.model },
        summary: outcome.verdict.summary,
        findings: [...outcome.verdict.findings],
      }
    case 'checks-failed':
      return {
        kind: 'checks-failed',
        id: outcome.record.id,
        commit: outcome.commit,
        argv: [...outcome.argv],
        ...outcome.exitCode === null ? {} : { exitCode: outcome.exitCode },
        output: outcome.output,
      }
    case 'conflict':
      return {
        kind: 'conflict',
        id: outcome.record.id,
        commit: outcome.commit,
        branch: outcome.record.branch,
        files: [...outcome.files],
      }
    case 'blocked':
      return {
        kind: 'blocked',
        id: outcome.record.id,
        commit: outcome.commit,
        reason: outcome.reason,
      }
    case 'empty':
      return { kind: 'empty', id: outcome.record.id }
    /* v8 ignore next 2 -- AcceptOutcome is a closed union; every current arm is handled above. */
    default:
      return assertNever(outcome, 'accept_worktree outcome')
  }
}

/**
 * Render the verbatim `accept_worktree` text for one declared result.
 * @param value - the value {@link toAcceptToolValue} produced.
 * @returns the exact model-facing sentence(s) for that outcome.
 */
export function renderAcceptToolValue(value: AcceptToolValue): string {
  switch (value.kind) {
    case 'merged': {
      const base = `Merged worktree ${value.id} into ${value.repoRoot}: commit ${value.commit} as merge `
        + `${value.mergeCommit}. Reviewer ${value.reviewer.provider}/${value.reviewer.model} passed it: ${value.summary}`
      return value.removed ? `${base} The worktree was removed; start a new child for further work.` : base
    }
    case 'rejected': {
      const findings = value.findings.map(finding => `- ${finding}`).join('\n')
      return `Review failed for worktree ${value.id} at commit ${value.commit} (reviewer ${value.reviewer.provider}/${value.reviewer.model}): ${value.summary}\n`
        + `Findings:\n${findings}\n`
        + 'Send these findings to the child with send_message, wait for it to finish, then accept again.'
    }
    case 'checks-failed':
      return `Checks failed for worktree ${value.id} at commit ${value.commit}: \`${value.argv.join(' ')}\` `
        + `exited ${String(value.exitCode ?? null)}.\n${value.output}`
    case 'conflict':
      return `Worktree ${value.id} passed review at commit ${value.commit} but conflicts with your checkout in: ${value.files.join(', ')}. `
        + `Nothing was merged. Merge branch ${value.branch} yourself and resolve the conflicts, or discard the worktree.`
    case 'blocked':
      return `Worktree ${value.id} passed review at commit ${value.commit}, but the merge could not start: ${value.reason}. `
        + 'Commit or set aside the conflicting changes in your checkout, then accept again.'
    case 'empty':
      return `Worktree ${value.id} has no changes to accept.`
    /* v8 ignore next 2 -- AcceptToolValue mirrors the closed AcceptOutcome union handled in toAcceptToolValue. */
    default:
      return assertNever(value, 'accept_worktree result')
  }
}

/** Declared `discard_worktree` output schema. */
export const DISCARD_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    branch: { type: 'string', required: true },
  },
} as const

/** Canonical `discard_worktree` result, inferred from {@link DISCARD_VALUE_SCHEMA}. */
export type DiscardToolValue = InferValue<typeof DISCARD_VALUE_SCHEMA>

/**
 * Project the discarded {@link WorktreeRecord} into the tool's declared value.
 * @param record - the record `ctx.subagentWorktrees.discard()` returned.
 * @returns the canonical `discard_worktree` result.
 */
export function toDiscardToolValue(record: WorktreeRecord): DiscardToolValue {
  return { id: record.id, branch: record.branch }
}

/**
 * Render the verbatim `discard_worktree` text.
 * @param value - the value {@link toDiscardToolValue} produced.
 * @returns the exact model-facing confirmation sentence.
 */
export function renderDiscardToolValue(value: DiscardToolValue): string {
  return `Discarded worktree ${value.id} and branch ${value.branch}.`
}

/** Declared `list_worktrees` output schema: one row per open record. */
export const LIST_VALUE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      state: { type: 'string', required: true, enum: ['open', 'reviewing', 'merged', 'discarded'] },
      branch: { type: 'string', required: true },
      label: { type: 'string', required: true },
      // Absent until the worktree's first review verdict is recorded.
      verdict: { type: 'string', enum: ['pass', 'fail'] },
    },
  },
} as const

/** Canonical `list_worktrees` result, inferred from {@link LIST_VALUE_SCHEMA}. */
export type ListToolValue = InferValue<typeof LIST_VALUE_SCHEMA>

/**
 * Project the listed {@link WorktreeRecord}s into the tool's declared value.
 * @param records - the records `ctx.subagentWorktrees.list()` returned.
 * @returns the canonical `list_worktrees` result, one row per record.
 */
export function toListToolValue(records: readonly WorktreeRecord[]): ListToolValue {
  return records.map(record => ({
    id: record.id,
    state: record.state,
    branch: record.branch,
    label: record.label,
    ...record.lastVerdict === undefined ? {} : { verdict: record.lastVerdict.verdict },
  }))
}

/**
 * Render the verbatim `list_worktrees` text.
 * @param value - the value {@link toListToolValue} produced.
 * @returns one line per record, or the no-open-worktrees sentence when empty.
 */
export function renderListToolValue(value: ListToolValue): string {
  if (value.length === 0) return 'No open worktrees.'
  return value.map(row => `${row.id}  ${row.state}  ${row.branch}  ${row.label}  ${row.verdict ?? 'not reviewed'}`).join('\n')
}
