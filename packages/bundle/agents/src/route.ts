/**
 * Pure parsing and derivation helpers shared by the `dsh agents` verbs: route
 * flags, display labels, check-command tokens, and the working directory of a
 * reused worktree.
 * @module @deepseek-ai/dsh-agents/route
 */

import { join, relative } from 'node:path'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { WorktreeRecord, WorktreeRoute } from '@deepseek-ai/dsh-subagent-worktree'

/** Longest display label kept verbatim before truncation; a protocol-level display bound, not a deployment tunable. */
export const MAX_LABEL_LENGTH = 72

/**
 * Parse a `<provider>/<model>` flag value into a route's provider and model.
 * @param flag - the flag name, for the error message (for example `--model`).
 * @param value - the raw flag value.
 * @returns the provider and model.
 * @throws when `value` has no `/` separating a non-empty provider from a non-empty model.
 */
export function parseRouteFlag(flag: string, value: string): { provider: string; model: string } {
  const index = value.indexOf('/')
  const provider = index < 0 ? '' : value.slice(0, index)
  const model = index < 0 ? '' : value.slice(index + 1)
  if (provider === '' || model === '') {
    throw new Error(`${flag} must be <provider>/<model>, got ${JSON.stringify(value)}`)
  }
  return { provider, model }
}

/**
 * Required-field guard for a startup value the current verb's grammar
 * guarantees. A thrown error here means the startup and runner plugins
 * disagree about a verb's published fields, not a user input mistake.
 * @param value - the value to check.
 * @param message - the internal-consistency error to throw when absent.
 * @returns `value`, narrowed to defined.
 */
export function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}

/**
 * Resolve the worker route from `--model`/`--effort`, defaulting to the
 * current default-model selection when `--model` is omitted.
 * @param model - raw `--model` value, or undefined to use the default selection.
 * @param effort - raw `--effort` value; ignored when `model` is omitted.
 * @param fallback - the default-model selection used when `--model` is omitted.
 * @returns the resolved worker route.
 */
export function resolveWorkerRoute(
  model: string | undefined,
  effort: string | undefined,
  fallback: WorktreeRoute,
): WorktreeRoute {
  if (model === undefined) return fallback
  const { provider, model: modelId } = parseRouteFlag('--model', model)
  return { provider, model: modelId, ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) } }
}

/**
 * Parse an optional `--reviewer`/`--reviewer-effort` pair into a reviewer
 * route override for {@link SubagentWorktrees.resolveReviewer}.
 * @param reviewer - raw `--reviewer` value, or undefined for no override.
 * @param reviewerEffort - raw `--reviewer-effort` value; ignored when `reviewer` is omitted.
 * @returns the override route, or undefined when `--reviewer` was not supplied.
 */
export function resolveReviewerOverride(
  reviewer: string | undefined,
  reviewerEffort: string | undefined,
): WorktreeRoute | undefined {
  if (reviewer === undefined) return undefined
  const { provider, model } = parseRouteFlag('--reviewer', reviewer)
  return { provider, model, ...reviewerEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reviewerEffort) } }
}

/**
 * Split a check-command flag value on whitespace into argv, as documented for
 * `--test`. This is a literal whitespace split, not shell tokenization: a
 * command needing quoting or globbing belongs in a wrapper script.
 * @param value - the raw `--test` flag value.
 * @returns the non-empty whitespace-separated tokens.
 */
export function splitTestCommand(value: string): string[] {
  return value.split(/\s+/).filter(token => token !== '')
}

/**
 * Derive a display label from a task's first line when `--name` is omitted.
 * @param task - the task text.
 * @returns the first line, collapsed to single spaces and capped at {@link MAX_LABEL_LENGTH}.
 */
export function deriveLabel(task: string): string {
  const newline = task.indexOf('\n')
  const firstLine = (newline < 0 ? task : task.slice(0, newline)).trim().replace(/\s+/gu, ' ')
  const label = firstLine === '' ? task.trim().replace(/\s+/gu, ' ') : firstLine
  if (label.length <= MAX_LABEL_LENGTH) return label
  return `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`
}

/**
 * Convert a {@link WorktreeRoute} into a {@link ModelSelection}. A
 * `ModelSelection` is also a valid {@link AgentOptions} (whose same-named
 * fields are optional), so this single conversion covers both an Agent's
 * `agentOptions` and a `ctx.subagents.start()` request's `agentOptions`.
 * @param route - the resolved worker, fixer, or operator route.
 * @returns the equivalent model selection.
 */
export function toModelSelection(route: WorktreeRoute): ModelSelection {
  return {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
  }
}

/**
 * Resolve the worker directory for a reused worktree record: the worktree
 * joined with `baseDir`'s path relative to the repository top level, matching
 * {@link ProvisionedWorktree.workDir}'s contract for a freshly created one.
 * @param record - the worktree record being reused.
 * @param baseDir - the invoking directory inside the base checkout.
 * @returns the absolute directory the reused worker runs in.
 */
export function resolveWorkDir(record: Pick<WorktreeRecord, 'path' | 'repoRoot'>, baseDir: string): string {
  return join(record.path, relative(record.repoRoot, baseDir))
}
