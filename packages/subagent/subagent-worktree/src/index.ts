/**
 * Isolated git worktrees for delegated agents. The service creates one linked
 * worktree per delegated task outside every checkout, commits a finished
 * worker's changes on its behalf, has an independent reviewer child check the
 * exact commit, and merges only a passing change into the base checkout.
 *
 * @module @deepseek-ai/dsh-subagent-worktree
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {
  AcceptOutcome,
  AcceptWorktreeRequest,
  AttachWorkerRequest,
  CreateWorktreeRequest,
  DiscardWorktreeRequest,
  ListWorktreesRequest,
  ProvisionedWorktree,
  ResolveReviewerRequest,
  WorktreeRecord,
  WorktreeRoute,
} from './types.ts'

export type * from './types.ts'
export { renderReviewerPrompt, renderWorkerBrief, VERDICT_SCHEMA } from './text.ts'
export type { ReviewerPromptFacts, WorkerBriefFacts } from './text.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Isolated git worktrees for delegated agents. */
    subagentWorktrees: SubagentWorktrees
  }
}

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

/**
 * The `ctx.subagentWorktrees` service. Git runs through `ctx.subprocess` with
 * argv and an explicit cwd, in the host realm and outside any session
 * sandbox; its commands and check argv come only from this configuration or
 * operator input, never from model input.
 */
export class SubagentWorktrees extends Service {
  static inject = ['subprocess', 'subagents']

  static Config: z<Config> = z.object({
    root: z.string().description('Absolute directory holding worktrees, records, and review checkouts. Omitted resolves <DSH_HOME>/worktrees.'),
    branchPrefix: z.string().default('dsh/worktree/').description('Prefix of every worktree branch name.'),
    maxWorktrees: z.natural().min(1).default(16).description('Maximum open or reviewing worktrees per repository.'),
    reviewerProvider: z.string().description('Reviewer provider route, set together with reviewerModel. Omitted uses the route of the agent that accepts.'),
    reviewerModel: z.string().description('Reviewer model id, set together with reviewerProvider.'),
    reviewerReasoningEffort: z.string().description('Reviewer reasoning effort; requires reviewerProvider and reviewerModel.'),
    requireDistinctReviewer: z.boolean().default(true).description('Reject a reviewer route equal to the worker route.'),
    testCommand: z.array(z.string()).description('Check command (argv) run in the review checkout before the reviewer. Empty runs none.'),
    reviewDiffMaxBytes: z.natural().min(1024).default(49152).description('Byte bound on the diff embedded in the reviewer prompt.'),
    removeOnMerge: z.boolean().default(true).description('Remove the worktree and its branch after a successful merge.'),
    commitAuthorName: z.string().description('Author name for harness commits, set together with commitAuthorEmail. Omitted uses the git configuration.'),
    commitAuthorEmail: z.string().description('Author email for harness commits, set together with commitAuthorName.'),
  })

  constructor(ctx: Context, protected readonly config: Config) {
    super(ctx, 'subagentWorktrees')
  }

  /**
   * Create one linked worktree on a new branch from the base checkout's `HEAD`.
   * @param request - owner, base directory, label, task, optional worker route, and cancellation.
   * @returns the committed `open` record, the worker directory, and any uncommitted base changes left out.
   */
  create(request: CreateWorktreeRequest): Promise<ProvisionedWorktree> {
    void request
    throw new Error('subagent-worktree: create is not implemented')
  }

  /**
   * Record one worker Session on an open worktree.
   * @param request - worktree id, owner, worker Session id, and route.
   * @returns the updated record.
   */
  attach(request: AttachWorkerRequest): Promise<WorktreeRecord> {
    void request
    throw new Error('subagent-worktree: attach is not implemented')
  }

  /**
   * Resolve the reviewer route (operator override, then configuration, then the
   * accepting Agent's route) and enforce independence from the worker.
   * @param request - worker route, caller route, and optional override.
   * @returns the reviewer route.
   * @throws when `requireDistinctReviewer` is set and the resolved route equals the worker's.
   */
  resolveReviewer(request: ResolveReviewerRequest): WorktreeRoute {
    void request
    throw new Error('subagent-worktree: resolveReviewer is not implemented')
  }

  /**
   * Commit the worktree's changes, run the check command, have an independent
   * reviewer check the exact commit, and merge a passing change.
   * @param request - worktree id, owner, reviewer parent Agent, operator overrides, and cancellation.
   * @returns the accept outcome.
   */
  accept(request: AcceptWorktreeRequest): Promise<AcceptOutcome> {
    void request
    throw new Error('subagent-worktree: accept is not implemented')
  }

  /**
   * Delete one worktree and its branch without merging.
   * @param request - worktree id, owner, and cancellation.
   * @returns the `discarded` record.
   */
  discard(request: DiscardWorktreeRequest): Promise<WorktreeRecord> {
    void request
    throw new Error('subagent-worktree: discard is not implemented')
  }

  /**
   * List one repository's worktrees.
   * @param request - base directory, optional owner filter, and whether to include closed records.
   * @returns records ordered by creation time.
   */
  list(request: ListWorktreesRequest): Promise<WorktreeRecord[]> {
    void request
    throw new Error('subagent-worktree: list is not implemented')
  }
}

export default SubagentWorktrees
