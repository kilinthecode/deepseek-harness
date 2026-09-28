/**
 * Types for isolated delegated-agent worktrees: durable records, requests,
 * and outcomes of the `ctx.subagentWorktrees` service.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Opaque worktree identity: `wt-` followed by eight lowercase hexadecimal digits. */
export type WorktreeId = Branded<'WorktreeId'>

/** Provider route an agent runs on. */
export interface WorktreeRoute {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Adapter-owned reasoning effort; omission follows the route default. */
  readonly reasoningEffort?: string
}

/**
 * Authority over a worktree. A `session` owner is the delegating Session that
 * created it; model-facing tools act only on worktrees their caller owns. The
 * `operator` owner is the local user acting through the `dsh agents` command,
 * who may act on every worktree of a repository.
 */
export type WorktreeOwner =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'operator' }

/**
 * Durable lifecycle state. `open` accepts work and review; `reviewing` is held
 * by one accept operation; `merged` and `discarded` are terminal.
 */
export type WorktreeState = 'open' | 'reviewing' | 'merged' | 'discarded'

/** Structured verdict returned by the reviewer child, bound to the exact commit it reviewed. */
export interface WorktreeVerdict {
  /** `pass` only when the change is correct, verified, and honest. */
  readonly verdict: 'pass' | 'fail'
  /** The reviewer's short account of what it verified. */
  readonly summary: string
  /** Each check the reviewer ran, with its command and result. */
  readonly checks: readonly string[]
  /** One entry per problem found; empty on a pass. */
  readonly findings: readonly string[]
  /** Full commit id the reviewer checked out and reviewed. */
  readonly commit: string
  /** Session id of the reviewer child. */
  readonly reviewerSessionId: SessionId
  /** Route the reviewer ran on. */
  readonly reviewerRoute: WorktreeRoute
  /** Epoch milliseconds when the verdict was recorded. */
  readonly at: number
}

/** Durable record of one worktree, persisted at each state transition. */
export interface WorktreeRecord {
  /** Worktree identity. */
  readonly id: WorktreeId
  /** Canonical top-level directory of the repository the worktree branches from. */
  readonly repoRoot: string
  /** Absolute directory of the linked worktree. */
  readonly path: string
  /** Branch checked out in the worktree. */
  readonly branch: string
  /** Full commit id the branch was created from. */
  readonly baseCommit: string
  /** Authority over the worktree. */
  readonly owner: WorktreeOwner
  /** Short display label, from the delegation description. */
  readonly label: string
  /** Task text the reviewer checks the change against. */
  readonly task: string
  /** Lifecycle state. */
  readonly state: WorktreeState
  /** Epoch milliseconds when the worktree was created. */
  readonly createdAt: number
  /** Worker Sessions attached in attachment order. */
  readonly workerSessionIds: readonly SessionId[]
  /** Route of the most recently attached worker, when known. */
  readonly workerRoute?: WorktreeRoute
  /** Latest reviewer verdict. */
  readonly lastVerdict?: WorktreeVerdict
  /** Merge commit id in the base checkout once merged. */
  readonly mergedCommit?: string
}

/** Bounded account of uncommitted changes in the base checkout when a worktree was created. */
export interface DirtySummary {
  /** Leading porcelain status entries, at most the configured bound. */
  readonly entries: readonly string[]
  /** Total number of porcelain status entries. */
  readonly total: number
}

/** Request to create one worktree branched from the base checkout's `HEAD`. */
export interface CreateWorktreeRequest {
  /** Authority recorded on the worktree. */
  readonly owner: WorktreeOwner
  /** Absolute directory inside the base checkout: the delegating Session's cwd or the operator's directory. */
  readonly baseDir: string
  /** Short display label. */
  readonly label: string
  /** Task text recorded for review. */
  readonly task: string
  /** Route the first worker will run on, when known before it starts. */
  readonly workerRoute?: WorktreeRoute
  /** Cancellation for provisioning. */
  readonly signal: AbortSignal
}

/** A created worktree and where its worker works. */
export interface ProvisionedWorktree {
  /** The committed `open` record. */
  readonly record: WorktreeRecord
  /** Absolute directory for the worker Session: the worktree joined with `baseDir`'s path inside the repository. */
  readonly workDir: string
  /** Uncommitted base-checkout changes the worktree does not contain, when any exist. */
  readonly baseDirty?: DirtySummary
}

/** Request to record one worker Session on an open worktree. */
export interface AttachWorkerRequest {
  /** Worktree identity. */
  readonly id: WorktreeId
  /** Authority; must match the record owner unless it is the operator. */
  readonly owner: WorktreeOwner
  /** Session id of the worker that works in the worktree. */
  readonly workerSessionId: SessionId
  /** Route the worker runs on. */
  readonly workerRoute?: WorktreeRoute
}

/** Inputs for resolving the reviewer route and enforcing its independence from the worker. */
export interface ResolveReviewerRequest {
  /** Route the worker runs on. */
  readonly workerRoute: WorktreeRoute
  /** Route of the Agent that accepts the worktree, used when no reviewer is configured. */
  readonly callerRoute: WorktreeRoute
  /** Operator override for one accept, taking precedence over configuration. */
  readonly override?: WorktreeRoute
}

/** Request to commit, check, review, and merge one worktree. */
export interface AcceptWorktreeRequest {
  /** Worktree identity. */
  readonly id: WorktreeId
  /** Authority; must match the record owner unless it is the operator. */
  readonly owner: WorktreeOwner
  /** Live Agent the reviewer child starts under: the delegating lead or the operator's Agent. */
  readonly parent: Agent
  /** Operator reviewer-route override for this accept. */
  readonly reviewer?: WorktreeRoute
  /** Operator check command for this accept, replacing the configured one. */
  readonly testCommand?: readonly string[]
  /** Cancellation for the whole operation. */
  readonly signal: AbortSignal
}

/**
 * Result of one accept. `merged` landed the commit; `rejected` carries a
 * failing verdict; `checks-failed` reports the configured check command;
 * `conflict` and `blocked` passed review but could not merge; `empty` found
 * no change. Every non-merged outcome leaves the worktree `open`.
 */
export type AcceptOutcome =
  | {
    readonly kind: 'merged'
    readonly record: WorktreeRecord
    readonly commit: string
    readonly mergeCommit: string
    readonly verdict: WorktreeVerdict
    /** Whether the worktree directory and branch were removed after the merge. */
    readonly removed: boolean
  }
  | { readonly kind: 'rejected'; readonly record: WorktreeRecord; readonly commit: string; readonly verdict: WorktreeVerdict }
  | {
    readonly kind: 'checks-failed'
    readonly record: WorktreeRecord
    readonly commit: string
    readonly argv: readonly string[]
    readonly exitCode: number | null
    /** Bounded tail of the combined check output. */
    readonly output: string
  }
  | {
    readonly kind: 'conflict'
    readonly record: WorktreeRecord
    readonly commit: string
    readonly verdict: WorktreeVerdict
    /** Paths git reported as conflicted before the merge was aborted. */
    readonly files: readonly string[]
  }
  | {
    readonly kind: 'blocked'
    readonly record: WorktreeRecord
    readonly commit: string
    readonly verdict: WorktreeVerdict
    /** Bounded git message explaining why the merge did not start. */
    readonly reason: string
  }
  | { readonly kind: 'empty'; readonly record: WorktreeRecord }

/** Request to delete one worktree and its branch without merging. */
export interface DiscardWorktreeRequest {
  /** Worktree identity. */
  readonly id: WorktreeId
  /** Authority; must match the record owner unless it is the operator. */
  readonly owner: WorktreeOwner
  /** Cancellation for the git work. */
  readonly signal: AbortSignal
}

/** Request to list one repository's worktrees. */
export interface ListWorktreesRequest {
  /** Absolute directory inside a checkout of the repository. */
  readonly baseDir: string
  /** Restrict to one owner; omit for the operator view of every owner. */
  readonly owner?: WorktreeOwner
  /** Include `merged` and `discarded` records. */
  readonly includeClosed?: boolean
}
