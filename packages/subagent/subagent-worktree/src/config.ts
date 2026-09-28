/**
 * Deployment configuration for the `subagentWorktrees` service, split from
 * `index.ts` so implementation modules can depend on the `Config` type
 * without importing the service class itself.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/config
 */

import z from '@deepseek-ai/schemastery'
import type { WorktreeRoute } from './types.ts'

/** Deployment configuration for worktree placement, review, and merge. */
export interface Config {
  /** Absolute directory holding worktrees, records, and review checkouts; omitted resolves `<DSH_HOME>/worktrees` at load. */
  root?: string
  /** Prefix of every worktree branch name. */
  branchPrefix: string
  /** Maximum `open` or `reviewing` worktrees per repository. */
  maxWorktrees: number
  /** Reviewer route; omitted uses the route of the Agent that accepts. */
  reviewer?: WorktreeRoute
  /** Reject a reviewer route equal to the worker's route. */
  requireDistinctReviewer: boolean
  /** Check command run in the review checkout before the reviewer; a nonzero exit rejects the change. */
  testCommand?: string[]
  /** Byte bound on the diff embedded in the reviewer prompt. */
  reviewDiffMaxBytes: number
  /** Remove the worktree directory and branch after a successful merge. */
  removeOnMerge: boolean
  /** Author identity for harness commits; omitted uses git's configured identity. */
  commitAuthor?: { name: string; email: string }
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  root: z.string().description('Absolute directory holding worktrees, records, and review checkouts. Omitted resolves <DSH_HOME>/worktrees.'),
  branchPrefix: z.string().default('dsh/worktree/').description('Prefix of every worktree branch name.'),
  maxWorktrees: z.natural().min(1).default(16).description('Maximum open or reviewing worktrees per repository.'),
  // z.union, not a bare z.object: an object() field defaults an absent key to
  // {} (schemastery materializes every object/array/dict/tuple/bitset field),
  // which would then fail this object's own required() sub-fields. Wrapping it
  // in a union with z.const(undefined) keeps the field genuinely optional
  // while still rejecting an incomplete route (see packages/api/terminal-controller/src/index.ts).
  reviewer: z.union([z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  }), z.const(undefined)]).description('Reviewer route. Omitted uses the route of the agent that accepts.'),
  requireDistinctReviewer: z.boolean().default(true).description('Reject a reviewer route equal to the worker route.'),
  testCommand: z.array(z.string()).description('Check command (argv) run in the review checkout before the reviewer.'),
  reviewDiffMaxBytes: z.natural().min(1024).default(49152).description('Byte bound on the diff embedded in the reviewer prompt.'),
  removeOnMerge: z.boolean().default(true).description('Remove the worktree and its branch after a successful merge.'),
  commitAuthor: z.object({
    name: z.string().required(),
    email: z.string().required(),
  }).description('Author identity for harness commits. Omitted uses the git configuration.'),
})
