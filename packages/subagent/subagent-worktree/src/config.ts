/**
 * Deployment configuration for the `subagentWorktrees` service, split from
 * `index.ts` so implementation modules can depend on the `Config` type
 * without importing the service class itself. The reviewer route and commit
 * author are flat scalar fields, not nested objects: Schemastery
 * materializes an omitted `z.object({...})` field as `{}` before validating
 * its own `required()` sub-fields, which would reject the common "omitted
 * entirely" case for an optional struct-shaped field.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/config
 */

import z from '@deepseek-ai/schemastery'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { WorktreeRoute } from './types.ts'

/** Deployment configuration for worktree placement, review, and merge. */
export interface Config {
  /** Absolute directory holding worktrees, records, and review checkouts; omitted resolves `<DSH_HOME>/worktrees` at load. */
  root?: string
  /** Prefix of every worktree branch name. */
  branchPrefix: string
  /** Maximum `open` or `reviewing` worktrees per repository. */
  maxWorktrees: number
  /** Reviewer provider route; set together with {@link reviewerModel}. Omitted uses the route of the Agent that accepts. */
  reviewerProvider?: string
  /** Reviewer model id; set together with {@link reviewerProvider}. */
  reviewerModel?: string
  /** Reviewer reasoning effort; requires {@link reviewerProvider} and {@link reviewerModel}. */
  reviewerReasoningEffort?: string
  /** Reject a reviewer route equal to the worker's route. */
  requireDistinctReviewer: boolean
  /** Check command (argv) run in the review checkout before the reviewer; empty runs none. A nonzero exit rejects the change. */
  testCommand: string[]
  /** Byte bound on the diff embedded in the reviewer prompt. */
  reviewDiffMaxBytes: number
  /** Remove the worktree directory and branch after a successful merge. */
  removeOnMerge: boolean
  /** Author name for harness commits; set together with {@link commitAuthorEmail}. Omitted uses git's configured identity. */
  commitAuthorName?: string
  /** Author email for harness commits; set together with {@link commitAuthorName}. */
  commitAuthorEmail?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  root: z.string().description('Absolute directory holding worktrees, records, and review checkouts. Omitted resolves <DSH_HOME>/worktrees.'),
  branchPrefix: z.string().default('dsh/worktree/').description('Prefix of every worktree branch name.'),
  maxWorktrees: z.natural().min(1).default(16).description('Maximum open or reviewing worktrees per repository.'),
  reviewerProvider: z.string().description('Reviewer provider route, set together with reviewerModel. Omitted uses the route of the agent that accepts.'),
  reviewerModel: z.string().description('Reviewer model id, set together with reviewerProvider.'),
  reviewerReasoningEffort: z.string().description('Reviewer reasoning effort; requires reviewerProvider and reviewerModel.'),
  requireDistinctReviewer: z.boolean().default(true).description('Reject a reviewer route equal to the worker route.'),
  testCommand: z.array(z.string().required()).default([]).description('Check command (argv) run in the review checkout before the reviewer. Empty runs none.'),
  reviewDiffMaxBytes: z.natural().min(1024).default(49152).description('Byte bound on the diff embedded in the reviewer prompt.'),
  removeOnMerge: z.boolean().default(true).description('Remove the worktree and its branch after a successful merge.'),
  commitAuthorName: z.string().description('Author name for harness commits, set together with commitAuthorEmail. Omitted uses the git configuration.'),
  commitAuthorEmail: z.string().description('Author email for harness commits, set together with commitAuthorName.'),
})

/** A resolved, validated commit author identity. */
export interface CommitAuthor {
  readonly name: string
  readonly email: string
}

/**
 * Resolve and validate the configured reviewer route: an explicit resolve
 * step run once at load, so every later `resolveReviewer` call reads a
 * pre-validated value instead of re-deriving it from raw config fields.
 * @param config - the plugin's validated configuration.
 * @returns the configured reviewer route, or `undefined` when none is configured.
 * @throws when `reviewerProvider`/`reviewerModel` are half-set, or `reviewerReasoningEffort`
 *   is set without both.
 */
export function resolveConfiguredReviewer(config: Config): WorktreeRoute | undefined {
  const { reviewerProvider, reviewerModel, reviewerReasoningEffort } = config
  if ((reviewerProvider === undefined) !== (reviewerModel === undefined)) {
    throw new Error('subagent-worktree: configured reviewerProvider and reviewerModel must be set together')
  }
  if (reviewerProvider === undefined || reviewerModel === undefined) {
    if (reviewerReasoningEffort !== undefined) {
      throw new Error('subagent-worktree: configured reviewerReasoningEffort requires reviewerProvider and reviewerModel')
    }
    return undefined
  }
  return {
    provider: reviewerProvider,
    model: reviewerModel,
    ...reviewerReasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reviewerReasoningEffort) },
  }
}

/**
 * Resolve and validate the configured commit author identity.
 * @param config - the plugin's validated configuration.
 * @returns the configured commit author, or `undefined` when none is configured (git's own identity applies).
 * @throws when `commitAuthorName`/`commitAuthorEmail` are half-set.
 */
export function resolveConfiguredCommitAuthor(config: Config): CommitAuthor | undefined {
  const { commitAuthorName, commitAuthorEmail } = config
  if ((commitAuthorName === undefined) !== (commitAuthorEmail === undefined)) {
    throw new Error('subagent-worktree: configured commitAuthorName and commitAuthorEmail must be set together')
  }
  if (commitAuthorName === undefined || commitAuthorEmail === undefined) return undefined
  return { name: commitAuthorName, email: commitAuthorEmail }
}
