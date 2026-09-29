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
import { GitRunner } from './git.ts'
import { recoverLandedMerge, sweepWorktree } from './landed.ts'
import {
  assertOpen, assertOpenOrRecoverable, assertOwnerAuthority, layoutForRepo, listRecords, requireRecordLocation,
  toPublicRecord, updateExistingRecordAt,
} from './records.ts'
import type { ScanWarning } from './records.ts'
import { repoIdentityOf } from './repo.ts'
import { assertNoRunningWorkers } from './workers.ts'
import { assertWorktreeId } from './worktree-id.ts'
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
export { assertWorktreeId } from './worktree-id.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Isolated git worktrees for delegated agents. */
    subagentWorktrees: SubagentWorktrees
  }

  interface Events {
    /**
     * Whether worktree isolation is offered on delegation tools changed: the first live offer was
     * registered, or the last one was withdrawn. It does not fire while offers are added or withdrawn
     * with at least one other still live. Delegation tools listen and mount again; a listener failure is
     * logged and does not stop the other listeners or the offer that triggered it.
     * @param offered - the new value of {@link SubagentWorktrees.offersIsolation}.
     * @mode emit
     */
    'subagent-worktree/offer-changed'(offered: boolean): void
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
  /**
   * Reject a reviewer route equal to the worker's route (provider and model). Off by default, so a worker
   * that inherits the accepting Agent's route is reviewed on that same route; turn it on together with
   * {@link reviewerProvider} and {@link reviewerModel} to enforce a reviewer on another model.
   */
  requireDistinctReviewer: boolean
  /** Check command (argv) run in the review checkout before the reviewer; empty runs none. A nonzero exit rejects the change. */
  testCommand: string[]
  /** Milliseconds the check command may run before it is terminated and the accept reports `checks-failed`. */
  checkTimeoutMs: number
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
  requireDistinctReviewer: z.boolean().default(false).description('Reject a reviewer route equal to the worker route. Off by default: a worker that inherits the accepting agent route is reviewed on that route. Set it with reviewerProvider and reviewerModel to enforce a reviewer on another model.'),
  testCommand: z.array(z.string().required()).default([]).description('Check command (argv) run in the review checkout before the reviewer. Empty runs none.'),
  checkTimeoutMs: z.natural().min(1000).default(900_000).description('Milliseconds the check command may run before it is terminated and reported as checks-failed.'),
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

  /** Git command runner shared by every operation, created on first use. */
  private gitRunner: GitRunner | undefined

  /** Resolved once at load from the flat `reviewerProvider`/`reviewerModel`/`reviewerReasoningEffort` fields. */
  private readonly configuredReviewer: WorktreeRoute | undefined

  /** Resolved once at load from the flat `commitAuthorName`/`commitAuthorEmail` fields. */
  private readonly commitAuthor: CommitAuthor | undefined

  /** Logs a candidate directory or stray file that a record scan skipped instead of failing on. */
  private readonly warnScan: ScanWarning = (message) => { this.ctx.logger.warn(message) }

  /** Isolation offers registered through {@link offerIsolation} and not yet withdrawn. */
  private liveOffers = 0

  constructor(ctx: Context, protected readonly config: Config) {
    super(ctx, 'subagentWorktrees')
    this.root = config.root ?? dshHomePath('worktrees')
    if (!isAbsolute(this.root)) {
      throw new Error(`subagent-worktree: configured root "${this.root}" must be an absolute path`)
    }
    this.configuredReviewer = resolveConfiguredReviewer(config)
    this.commitAuthor = resolveConfiguredCommitAuthor(config)
  }

  /** The git runner over the injected subprocess service; construction touches no service. */
  private get git(): GitRunner {
    this.gitRunner ??= new GitRunner(this.ctx.subprocess)
    return this.gitRunner
  }

  /**
   * Whether at least one offer of worktree isolation is live. A delegation tool whose provider has the `cwd`
   * capability offers the `isolation: "worktree"` parameter while this holds, in addition to its own
   * `worktreeIsolation` row setting, and mounts again when it changes. Registered offers include those
   * that reach tools mounted inside agent presets, whose rows a bundle patch cannot change.
   * @returns whether any offer registered through {@link offerIsolation} has not been withdrawn.
   */
  get offersIsolation(): boolean {
    return this.liveOffers > 0
  }

  /**
   * Offer worktree isolation on delegation tools until the returned disposer runs. Offers are counted: the
   * offer stands while at least one registration is live, so two consumers can offer independently.
   * `subagent-worktree/offer-changed` fires when this registration is the first live offer, and when
   * withdrawing it leaves none.
   * @returns a disposer that withdraws this offer; calling it again has no effect.
   */
  offerIsolation(): () => void {
    this.liveOffers += 1
    if (this.liveOffers === 1) this.notifyOfferChanged(true)
    let live = true
    return () => {
      if (!live) return
      live = false
      this.liveOffers -= 1
      if (this.liveOffers === 0) this.notifyOfferChanged(false)
    }
  }

  /**
   * Tell every listener that {@link offersIsolation} flipped. A listener that throws or rejects is
   * logged, never propagated: the count is already updated, and the caller of `offerIsolation` must
   * still receive its disposer.
   * @param offered - the value of {@link offersIsolation} after the flip.
   */
  private notifyOfferChanged(offered: boolean): void {
    const args: unknown[] = ['subagent-worktree/offer-changed', offered]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`subagent-worktree/offer-changed listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`subagent-worktree/offer-changed listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Create one linked worktree on a new branch from the base checkout's `HEAD`.
   * @param request - owner, base directory, label, task, worker route, and cancellation.
   * @returns the committed `open` record, the worker directory, and any uncommitted base changes left out.
   */
  create(request: CreateWorktreeRequest): Promise<ProvisionedWorktree> {
    return createWorktree(this.git, this.root, this.config.branchPrefix, this.config.maxWorktrees, request, this.warnScan)
  }

  /**
   * Record one worker Session on an open worktree.
   * @param request - worktree id, owner, worker Session id, and route.
   * @returns the updated record.
   * @throws when the id is malformed, no such worktree exists, the owner does not own it, or it is not `open`.
   */
  async attach(request: AttachWorkerRequest): Promise<WorktreeRecord> {
    assertWorktreeId(request.id)
    const located = await requireRecordLocation(this.root, request.id, this.warnScan)
    assertOwnerAuthority(located.record, request.owner, request.id)
    // The state check runs under the record lock so an attach cannot slip
    // between an accept's `open` -> `reviewing` transition and its commit.
    const updated = await updateExistingRecordAt(located.layout, request.id, (current) => {
      assertOpen(current, request.id)
      return {
        ...current,
        workerSessionIds: [...current.workerSessionIds, request.workerSessionId],
        workerRoute: request.workerRoute,
      }
    })
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
   * @throws when the id is malformed, or a non-operator owner sets `testCommand` or `reviewer`; see {@link acceptWorktree}.
   */
  async accept(request: AcceptWorktreeRequest): Promise<AcceptOutcome> {
    assertWorktreeId(request.id)
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
   * Delete one worktree and its branch without merging. The record is claimed
   * under its lock before any git change, so a concurrent `accept` cannot act on
   * a worktree this call is deleting. A `merged` or `discarded` record is not
   * changed: `discard` only removes a worktree directory or branch that a crash
   * between the merge and its cleanup, or a failed earlier `discard`, left behind,
   * so a retry after a failure finishes the cleanup.
   * @param request - worktree id, owner, and cancellation.
   * @returns the `discarded` record, or the unchanged `merged` or `discarded` record after cleaning up its leftovers.
   * @throws when the id is malformed, no such worktree exists, the owner does not own it, an attached worker is
   *   still running, the record is being accepted, or a git cleanup command fails.
   */
  async discard(request: DiscardWorktreeRequest): Promise<WorktreeRecord> {
    assertWorktreeId(request.id)
    const located = await requireRecordLocation(this.root, request.id, this.warnScan)
    assertOwnerAuthority(located.record, request.owner, request.id)

    // A stale `reviewing` record whose reviewed commit already landed (an earlier accept crashed before
    // recording it) is recorded `merged`, and then only its leftovers are swept.
    const recovery = await recoverLandedMerge(this.git, located.layout, located.record, request.signal)
    const claimed = recovery?.record ?? await updateExistingRecordAt(located.layout, request.id, (current) => {
      if (current.state === 'merged' || current.state === 'discarded') return current
      assertOpenOrRecoverable(current, request.id)
      assertNoRunningWorkers(this.ctx.agents, current, request.id)
      return { ...current, state: 'discarded' }
    })

    // Each removal tolerates the thing it removes already being gone, so a
    // discard that was interrupted after the claim can be finished by hand.
    await sweepWorktree(this.git, claimed, request.signal)
    return toPublicRecord(claimed)
  }

  /**
   * List one repository's worktrees.
   * @param request - base directory, optional owner filter, and whether to include closed records.
   * @returns records ordered by creation time.
   */
  async list(request: ListWorktreesRequest): Promise<WorktreeRecord[]> {
    const identity = await repoIdentityOf(this.git, request.baseDir)
    if (identity === undefined) {
      throw new Error(`subagent-worktree: "${request.baseDir}" is not inside a git work tree`)
    }
    const layout = layoutForRepo(this.root, identity.commonDir)
    const records = (await listRecords(layout, this.warnScan)).filter((record) => {
      if (!request.includeClosed && (record.state === 'merged' || record.state === 'discarded')) return false
      if (request.owner !== undefined && !ownerMatches(record.owner, request.owner)) return false
      return true
    })
    records.sort((a, b) => a.createdAt - b.createdAt)
    return records.map(toPublicRecord)
  }
}

export default SubagentWorktrees
