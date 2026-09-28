/**
 * Isolated git worktrees for delegated agents. The service creates one linked
 * worktree per delegated task outside every checkout, commits a finished
 * worker's changes on its behalf, has an independent reviewer child check the
 * exact commit, and merges only a passing change into the base checkout.
 *
 * @module @deepseek-ai/dsh-subagent-worktree
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subprocess'
import { acceptWorktree } from './accept.ts'
import { resolveConfiguredCommitAuthor, resolveConfiguredReviewer } from './config.ts'
import type { CommitAuthor } from './config.ts'
import { createWorktree } from './create.ts'
import { pathExists } from './fs-util.ts'
import { GitRunner } from './git.ts'
import {
  assertNotTerminal, assertOpenOrRecoverable, assertOwnerAuthority, layoutForRepo, listRecords, requireRecordLocation,
  toPublicRecord, updateExistingRecordAt,
} from './records.ts'
import { repoRootOf } from './repo.ts'
import { assertNoRunningWorkers } from './workers.ts'
import type {
  AcceptOutcome,
  AcceptWorktreeRequest,
  AttachWorkerRequest,
  CreateWorktreeRequest,
  DiscardWorktreeRequest,
  ListWorktreesRequest,
  ProvisionedWorktree,
  ResolveReviewerRequest,
  WorktreeOwner,
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

/**
 * Deployment configuration for worktree placement, review, and merge. The
 * reviewer route and commit author are flat scalar fields, not nested
 * objects, because Schemastery materializes an omitted `z.object({...})`
 * field as `{}` before validating its own `required()` sub-fields — see
 * {@link resolveConfiguredReviewer} and {@link resolveConfiguredCommitAuthor}
 * in `./config.ts`, which resolve and validate these flat fields once at load.
 */
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
const ConfigSchema: z<Config> = z.object({
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

/** Whether a filter owner admits a record's owner: exact match, `operator` filtering only `operator` records. */
function ownerMatches(recordOwner: WorktreeOwner, filterOwner: WorktreeOwner): boolean {
  if (filterOwner.kind === 'operator') return recordOwner.kind === 'operator'
  return recordOwner.kind === 'session' && recordOwner.sessionId === filterOwner.sessionId
}

/**
 * The `ctx.subagentWorktrees` service. Git runs through `ctx.subprocess` with
 * argv and an explicit cwd, in the host realm and outside any session
 * sandbox; its commands and check argv come only from this configuration or
 * operator input, never from model input.
 */
export class SubagentWorktrees extends Service {
  static inject = ['subprocess', 'subagents', 'agents']

  static Config = ConfigSchema

  /** Resolved once at load: `config.root`, or `<DSH_HOME>/worktrees` when omitted. */
  private readonly root: string

  /** Git command runner shared by every operation. */
  private readonly git: GitRunner

  /** Resolved once at load from the flat `reviewerProvider`/`reviewerModel`/`reviewerReasoningEffort` fields. */
  private readonly configuredReviewer: WorktreeRoute | undefined

  /** Resolved once at load from the flat `commitAuthorName`/`commitAuthorEmail` fields. */
  private readonly commitAuthor: CommitAuthor | undefined

  constructor(ctx: Context, protected readonly config: Config) {
    super(ctx, 'subagentWorktrees')
    this.root = config.root ?? dshHomePath('worktrees')
    if (!isAbsolute(this.root)) {
      throw new Error(`subagent-worktree: configured root "${this.root}" must be an absolute path`)
    }
    this.configuredReviewer = resolveConfiguredReviewer(config)
    this.commitAuthor = resolveConfiguredCommitAuthor(config)
    this.git = new GitRunner(ctx.subprocess)
  }

  /**
   * Create one linked worktree on a new branch from the base checkout's `HEAD`.
   * @param request - owner, base directory, label, task, worker route, and cancellation.
   * @returns the committed `open` record, the worker directory, and any uncommitted base changes left out.
   */
  create(request: CreateWorktreeRequest): Promise<ProvisionedWorktree> {
    return createWorktree(this.git, this.root, this.config.branchPrefix, this.config.maxWorktrees, request)
  }

  /**
   * Record one worker Session on an open worktree.
   * @param request - worktree id, owner, worker Session id, and route.
   * @returns the updated record.
   */
  async attach(request: AttachWorkerRequest): Promise<WorktreeRecord> {
    const located = await requireRecordLocation(this.root, request.id)
    assertOwnerAuthority(located.record, request.owner, request.id)
    assertNotTerminal(located.record, request.id)
    const updated = await updateExistingRecordAt(located.path, request.id, current => ({
      ...current,
      workerSessionIds: [...current.workerSessionIds, request.workerSessionId],
      workerRoute: request.workerRoute,
    }))
    return toPublicRecord(updated)
  }

  /**
   * Resolve the reviewer route (operator override, then configuration, then the
   * accepting Agent's route) and enforce independence from the worker. Routes
   * are equal when provider and model match; reasoning effort is ignored.
   * @param request - worker route, caller route, and optional override.
   * @returns the reviewer route.
   * @throws when `requireDistinctReviewer` is set and the resolved route equals the worker's.
   */
  resolveReviewer(request: ResolveReviewerRequest): WorktreeRoute {
    const route = request.override ?? this.configuredReviewer ?? request.callerRoute
    if (
      this.config.requireDistinctReviewer
      && route.provider === request.workerRoute.provider
      && route.model === request.workerRoute.model
    ) {
      throw new Error(
        `subagent-worktree: the reviewer would run on the worker's route ${route.provider}/${route.model}, `
        + 'so the review would not be independent; start the worker on another model or configure a reviewer route',
      )
    }
    return route
  }

  /**
   * Commit the worktree's changes, run the check command, have an independent
   * reviewer check the exact commit, and merge a passing change.
   * @param request - worktree id, owner, reviewer parent Agent, operator overrides, and cancellation.
   * @returns the accept outcome.
   */
  accept(request: AcceptWorktreeRequest): Promise<AcceptOutcome> {
    return acceptWorktree({
      ctx: this.ctx,
      git: this.git,
      root: this.root,
      config: this.config,
      commitAuthor: this.commitAuthor,
      resolveReviewer: req => this.resolveReviewer(req),
    }, request)
  }

  /**
   * Delete one worktree and its branch without merging.
   * @param request - worktree id, owner, and cancellation.
   * @returns the `discarded` record.
   */
  async discard(request: DiscardWorktreeRequest): Promise<WorktreeRecord> {
    const located = await requireRecordLocation(this.root, request.id)
    assertOwnerAuthority(located.record, request.owner, request.id)
    assertOpenOrRecoverable(located.record, request.id)
    assertNoRunningWorkers(this.ctx, located.record, request.id)

    const { record } = located
    if (await pathExists(record.path)) {
      await this.git.expect(['worktree', 'remove', '--force', record.path], 'git worktree remove', {
        cwd: record.repoRoot, signal: request.signal,
      })
    }
    await this.git.expect(['worktree', 'prune'], 'git worktree prune', { cwd: record.repoRoot, signal: request.signal })
    await this.git.expect(['branch', '-D', record.branch], 'git branch -D', { cwd: record.repoRoot, signal: request.signal })

    const updated = await updateExistingRecordAt(located.path, request.id, current => ({ ...current, state: 'discarded' }))
    return toPublicRecord(updated)
  }

  /**
   * List one repository's worktrees.
   * @param request - base directory, optional owner filter, and whether to include closed records.
   * @returns records ordered by creation time.
   */
  async list(request: ListWorktreesRequest): Promise<WorktreeRecord[]> {
    const repoRoot = await repoRootOf(this.git, request.baseDir)
    if (repoRoot === undefined) {
      throw new Error(`subagent-worktree: "${request.baseDir}" is not inside a git work tree`)
    }
    const layout = layoutForRepo(this.root, repoRoot)
    const records = (await listRecords(layout)).filter((record) => {
      if (!request.includeClosed && (record.state === 'merged' || record.state === 'discarded')) return false
      if (request.owner !== undefined && !ownerMatches(record.owner, request.owner)) return false
      return true
    })
    records.sort((a, b) => a.createdAt - b.createdAt)
    return records.map(toPublicRecord)
  }
}

export default SubagentWorktrees
