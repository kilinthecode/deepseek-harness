/**
 * The reviewer child: resolving the accepting Agent's own route (for
 * independence checking and as the default reviewer route), bounding the
 * diff embedded in its prompt, starting it through `ctx.subagents`, and
 * validating its structured result as a {@link WorktreeVerdict} — fail closed
 * on anything else.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/review
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import { truncateUtf8Prefix } from './bounds.ts'
import type { GitRunner } from './git.ts'
import { renderReviewerPrompt, VERDICT_SCHEMA } from './text.ts'
import type { WorktreeRoute, WorktreeVerdict } from './types.ts'

/**
 * Floor for the diff-collection byte cap, independent of the configurable
 * `reviewDiffMaxBytes`. `ctx.subprocess` collect mode keeps the TAIL on
 * overflow, but the reviewer prompt keeps the HEAD (with a truncation notice
 * pointing at the rest), so the raw collection must stay comfortably above
 * what will actually be embedded — otherwise the subprocess layer's own
 * tail-keeping truncation would run first and discard the head this service
 * means to keep. This ceiling only guards a truly pathological diff; ordinary
 * changes never approach it.
 */
const DIFF_COLLECT_FLOOR_BYTES = 8 * 1024 * 1024

/** Reviewer provider name: the only registered provider offering the `cwd` capability a review checkout needs. */
const REVIEWER_PROVIDER = 'spawn'

/** Verdict returned when the reviewer child produced no valid structured result. */
const NO_VERDICT_MESSAGE = 'the reviewer returned no structured verdict'

/**
 * Resolve the accepting Agent's current route as a {@link WorktreeRoute}. Used
 * both as `resolveReviewer`'s `callerRoute` and, when a worktree has no
 * recorded `workerRoute`, as the independence check's stand-in worker route.
 * @param parent - the Agent accepting the worktree.
 * @returns the Agent's effective provider, model, and reasoning effort.
 * @throws when the Agent has no effective provider and model yet (for example
 *   an operator root Agent that has never resolved a route).
 */
export function callerRouteOf(parent: Agent): WorktreeRoute {
  const options = parentAgentOptionsForDelegation(parent)
  if (options.provider === undefined || options.model === undefined) {
    throw new Error(
      'subagent-worktree: cannot resolve a reviewer route because the accepting agent has no effective provider and model yet',
    )
  }
  return {
    provider: options.provider,
    model: options.model,
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** Structural validation of the reviewer's `structured` result against {@link VERDICT_SCHEMA}, in host code. */
function isReviewerVerdictShape(value: unknown): value is { verdict: 'pass' | 'fail'; summary: string; checks: string[]; findings: string[] } {
  return isPlainObject(value)
    && (value.verdict === 'pass' || value.verdict === 'fail')
    && typeof value.summary === 'string'
    && isStringArray(value.checks)
    && isStringArray(value.findings)
}

/** Inputs for one reviewer run. */
export interface RunReviewerParams {
  /** The Agent the reviewer child starts under: the delegating lead or the operator's Agent. */
  readonly parent: Agent
  /** The disposable detached review checkout, already checked out at `commit`. */
  readonly reviewDir: string
  /** The exact commit under review. */
  readonly commit: string
  /** The commit the change was branched from. */
  readonly baseCommit: string
  /** Task text the change must satisfy. */
  readonly task: string
  /** The worktree's display label, used in the reviewer child's own label. */
  readonly label: string
  /** The resolved, independence-checked reviewer route. */
  readonly reviewerRoute: WorktreeRoute
  /** `Config.reviewDiffMaxBytes` or its default. */
  readonly reviewDiffMaxBytes: number
  /** Cancellation for the whole accept operation. */
  readonly signal: AbortSignal
}

/**
 * Compute the bounded `git diff <base>..<commit>` text embedded in the
 * reviewer prompt.
 * @param git - command runner.
 * @param params - review checkout, commit range, and the configured byte bound.
 * @returns the bounded diff text and whether it was truncated.
 */
async function boundedDiff(git: GitRunner, params: RunReviewerParams): Promise<{ text: string; truncated: boolean }> {
  const collectBytes = Math.max(DIFF_COLLECT_FLOOR_BYTES, params.reviewDiffMaxBytes + 1)
  const raw = await git.expect(['diff', `${params.baseCommit}..${params.commit}`], 'git diff', {
    cwd: params.reviewDir, signal: params.signal, maxBytes: collectBytes,
  })
  return truncateUtf8Prefix(raw.stdout, params.reviewDiffMaxBytes)
}

/**
 * Start the reviewer child, await its result, and validate its structured
 * output as a {@link WorktreeVerdict} — fail closed (verdict `fail`, with the
 * single finding {@link NO_VERDICT_MESSAGE}) when it is missing or malformed,
 * whether because the run produced no structured value, failed schema
 * validation, or did not complete.
 * @param ctx - host context with the `subagents` registry.
 * @param git - command runner, for the bounded diff.
 * @param params - review checkout, commit range, task, route, and cancellation.
 * @returns the verdict, bound to `params.commit`.
 */
export async function runReviewer(ctx: Context, git: GitRunner, params: RunReviewerParams): Promise<WorktreeVerdict> {
  const { text: diff, truncated: diffTruncated } = await boundedDiff(git, params)
  const prompt = renderReviewerPrompt({
    reviewDir: params.reviewDir,
    commit: params.commit,
    baseCommit: params.baseCommit,
    task: params.task,
    diff,
    diffTruncated,
  })
  const run = await ctx.subagents.start(REVIEWER_PROVIDER, {
    label: `Review ${params.label}`,
    prompt: [{ type: 'text', text: prompt }],
    parent: params.parent,
    cwd: params.reviewDir,
    outputSchema: VERDICT_SCHEMA,
    agentOptions: {
      provider: params.reviewerRoute.provider,
      model: params.reviewerRoute.model,
      ...params.reviewerRoute.reasoningEffort === undefined ? {} : { reasoningEffort: params.reviewerRoute.reasoningEffort },
    },
    signal: params.signal,
  })
  let result: Awaited<typeof run.result>
  try {
    result = await run.result
  } finally {
    await run.dispose()
  }
  const at = Date.now()
  if (!isReviewerVerdictShape(result.structured)) {
    return {
      verdict: 'fail',
      summary: NO_VERDICT_MESSAGE,
      checks: [],
      findings: [NO_VERDICT_MESSAGE],
      commit: params.commit,
      reviewerSessionId: run.id,
      reviewerRoute: params.reviewerRoute,
      at,
    }
  }
  return {
    verdict: result.structured.verdict,
    summary: result.structured.summary,
    checks: result.structured.checks,
    findings: result.structured.findings,
    commit: params.commit,
    reviewerSessionId: run.id,
    reviewerRoute: params.reviewerRoute,
    at,
  }
}
