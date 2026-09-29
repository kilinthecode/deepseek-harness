---
description: "Isolated git worktrees for delegated agents, for users and maintainers provisioning, reviewing, and merging one worker's changes independently of its parent's checkout."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-worktree

English | [中文](README.zh.md)

## Summary

`dsh-subagent-worktree` gives each delegated worker a linked git worktree, branched from the base checkout's `HEAD`, so parallel workers cannot overwrite the parent or each other. Nothing a worker changes reaches the base checkout until `accept` is called: the service commits the worktree's changes, runs a configured check command, has an independent reviewer child check the exact commit, and merges only a passing change with `--no-ff`. A rejected or blocked accept leaves the worktree `open` for retry; `discard` deletes an abandoned worktree without merging. The service adds no tool or prompt; consumers expose this isolation to a model or an operator.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this service so a delegation consumer can offer worktree isolation. Loading it alone does nothing model-visible; a consumer calls its methods around a worker's lifecycle.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-subagent-worktree'
```

| Field | Default | Meaning |
|---|---|---|
| `root` | `<DSH_HOME>/worktrees` | Absolute directory holding worktrees, records, and review checkouts; a configured value must be absolute |
| `branchPrefix` | `dsh/worktree/` | Prefix of every worktree branch name |
| `maxWorktrees` | `16` | Maximum `open` or `reviewing` worktrees per repository |
| `reviewerProvider` / `reviewerModel` | — | Reviewer route, set together; omitted uses the route of the agent that accepts |
| `reviewerReasoningEffort` | — | Reviewer reasoning effort; requires `reviewerProvider` and `reviewerModel` |
| `requireDistinctReviewer` | `false` | When `true`, reject a reviewer route equal to the worker's route (provider and model only; reasoning effort is ignored) |
| `testCommand` | `[]` | Check command (argv) run in the review checkout before the reviewer; empty runs none |
| `checkTimeoutMs` | `900000` | Milliseconds the check command may run before it is terminated and `accept` reports `checks-failed` with a timeout notice; at least `1000` |
| `reviewDiffMaxBytes` | `49152` | Byte bound on the diff embedded in the reviewer prompt |
| `removeOnMerge` | `true` | Remove the worktree directory and branch after a successful merge |
| `commitAuthorName` / `commitAuthorEmail` | — | Author identity for harness commits, set together; omitted uses git's configured identity |

`reviewerProvider`/`reviewerModel` and `commitAuthorName`/`commitAuthorEmail` each fail loud at load if only one half of the pair is set, and `reviewerReasoningEffort` fails loud if set without both reviewer fields. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-worktree) is the exhaustive source for every accepted field and its JSDoc.

By default the reviewer runs on the route of the accepting agent, so a worker started on a cheaper route is reviewed on the accepting agent's route automatically. To enforce a reviewer on a different model than the worker, configure `reviewerProvider`/`reviewerModel` and set `requireDistinctReviewer: true`.

Worktree isolation is offered on delegation tools by registration, not configuration: `ctx.subagentWorktrees.offerIsolation()` counts one live offer and returns the idempotent disposer that withdraws it, and the read-only `offersIsolation` getter is true while at least one offer is live. A delegation tool whose provider has the `cwd` capability offers the `isolation: "worktree"` parameter while `offersIsolation` is true, in addition to its own `worktreeIsolation` row setting, and mounts again when `subagent-worktree/offer-changed` reports a flip; that event carries the new value, fires only when it flips, and logs a listener that throws or rejects instead of propagating it. `@deepseek-ai/dsh-tool-subagent-worktree` registers an offer for as long as its tools are mounted, so the offer comes and goes with them and reaches tools that agent presets mount, whose rows a bundle patch cannot change; a profile patch on this service's row cannot remove it.

### The service surface

Besides that offer registration, `ctx.subagentWorktrees` exposes six methods, each taking a single request object:

| Method | Effect |
|---|---|
| `create` | Provisions one linked worktree on a new branch from the base checkout's `HEAD`; returns the `open` record, the worker's directory, and any uncommitted base changes the worktree does not contain |
| `attach` | Records one worker session id and route on an `open` worktree; refused while an `accept` holds the worktree and once it is closed |
| `resolveReviewer` | Resolves the reviewer route — operator override, then `Config`, then the caller's own route — and throws if it would equal the worker's route while `requireDistinctReviewer` is set |
| `accept` | The only operation that commits or merges: see [Run flow](#run-flow) |
| `discard` | Deletes one worktree and its branch without merging. It claims the record under its lock before any git change, so it is refused while an `accept` holds the worktree or an attached worker's Agent is still running; a directory or branch that is already gone is skipped. On a `merged` or `discarded` record it changes nothing except to remove a leftover worktree or branch, so a `discard` that failed partway can be run again to finish. A stale `reviewing` record whose reviewed commit already landed is recorded `merged` first, as `accept` does |
| `list` | Lists one repository's worktrees, optionally filtered by owner and including closed records |

Every method authorizes its caller: a `session` owner may act only on its own worktrees, while an `operator` (the `dsh agents` CLI) may act on any worktree of the repository. `create` and `list` resolve the target repository from a `baseDir` inside it; `attach`, `accept`, and `discard` take only the worktree id and search every repository under `root`, in name order, for its record, because the record's own `repoRoot` then supplies the repository for every later git command. A directory entry that cannot be read as a repository, and a `.json` file in a records directory whose name is not a worktree id, are skipped with a logged warning; a record file for the requested id that exists but is unreadable, corrupt, or inconsistent still fails loud.

The `testCommand` and `reviewer` overrides of `accept` are operator-only: a `session` owner that sets either is refused before anything is committed. Every method that takes a worktree id checks it with the exported `assertWorktreeId` (`wt-` followed by eight lowercase hexadecimal digits) before any path is built from it, and every record read from disk is checked against its file name, its worktree directory, its branch, and full commit ids (40 hexadecimal digits, or 64 in a SHA-256 repository); a mismatch fails loud.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and where the behavior in [Use this package](#use-this-package) comes from.

### Design concept

Every worktree, its durable JSON record, and its disposable review checkouts live under one per-repository directory keyed by the repository's name and a hash of its git common directory, so two unrelated repositories never collide, every linked worktree of one repository shares one records directory, merge lock, and `maxWorktrees` count, and a worktree never lives inside a repository it isolates work from. Each record still keeps the checkout it was created from as its merge target. A record moves through `open → reviewing → open | merged` and `open → discarded`; the transitions into `reviewing` and `discarded`, and an `attach`, check the state and the running workers under that record's own writer lock rather than before acquiring it, because only the lock serializes concurrent operations. A `reviewing` record whose accepting process no longer exists is treated as `open` (crash recovery) the next time any operation reads it, unless its reviewed commit is already in the base checkout's history, in which case it is recorded `merged`. `merged` and `discarded` records are closed: `discard` may be repeated on them to remove leftovers, and nothing reopens them.

<a id="run-flow"></a>
### Run flow: `accept`

1. Refuse a `session` owner that sets `testCommand` or `reviewer`, then load the record and authorize the caller.
2. If the record is `reviewing` with a dead accepting process and its last verdict's commit is already an ancestor of the base checkout's `HEAD`, an earlier accept died after its merge landed: record it `merged` (with the first merge commit that brought the commit in, when there is one), remove the leftovers when `removeOnMerge` is set, and return `merged` without a second review or merge.
3. Under the record lock, check that the record is `open` (or `reviewing` with a dead accepting process) and that no attached worker's Agent is still running, then transition to `reviewing` and record the accepting process id. A review can run for minutes and a worker can restart meanwhile, so the running-worker check is repeated right before `git add` and right before `git merge`.
4. Commit: `git add -A`, then commit only if something was staged (`-c user.name=`/`-c user.email=` only when `commitAuthorName`/`commitAuthorEmail` are configured). If the resulting commit equals the worktree's base commit, the outcome is `empty` and the record returns to `open`.
5. If the last recorded verdict already passed for this exact commit, skip straight to the merge — a blocked or conflicted merge retried without new changes does not pay for a second review.
6. Otherwise, in one disposable detached checkout at the commit (stale checkouts of the same worktree are swept first): run the configured check command, if any, under `checkTimeoutMs` — a nonzero exit or a timeout is `checks-failed` and the reviewer never starts — then start the reviewer child through `ctx.subagents.start('spawn', …)` with the bounded diff and the worktree's task in its prompt, and validate its structured result against the verdict schema in host code. A missing or invalid result, or a run whose stop reason is not `completed`, is a `fail` verdict with the finding `the reviewer returned no structured verdict` — fail closed, never an exception and never a pass.
7. A `fail` verdict is `rejected`; the worktree returns to `open`. A `pass` verdict attempts `git merge --no-ff --no-edit` into the base checkout under a per-repository merge lock, waiting up to ten minutes for another accept's merge (parallel workers branch from the same base, so after the first merge no later branch can fast-forward). The attempt first refuses as `blocked`, without running `git merge`, when the base checkout already has a merge in progress (`MERGE_HEAD` exists) or a detached `HEAD`; a probe that was cancelled or failed throws instead of being read as an answer. When `git merge` fails, the base checkout's state decides, because git's exit codes cannot tell a refusal from an error: a merge whose `MERGE_HEAD` is this accept's commit and that stopped on conflicts is aborted and reported as `conflict` with the conflicted paths, keeping the branch; conflicts or a `MERGE_HEAD` this accept did not create are `blocked` and left untouched; a merge that never started (for example because local changes would be overwritten) is `blocked` with the bounded git message; a merge that was killed, or failed after starting without conflicts, is aborted — only ever this accept's own merge — and thrown. Conflict and blocked leave the record `open` with the verdict kept.
8. The lock is released as soon as the merge attempt ends. A successful merge is recorded — state `merged`, the merge commit id — and only then does `removeOnMerge` delete the worktree and branch. From the moment `git merge` exits 0 the record is never reopened. Reading the merge commit id is retried once; if it still cannot be read, the record is recorded `merged` without an id and an error says the merge landed. A failed write of the `merged` state releases the accept claim on a best-effort basis, so the next `accept` or `discard` recognizes the stale record as landed, and throws an error saying the merge landed. A failed removal is logged and returns `merged` with `removed: false`, which `discard` then finishes.
9. Any error thrown before the merge landed, and every outcome that did not merge (`empty`, `checks-failed`, `rejected`, `conflict`, `blocked`), returns the record to `open`. Only a record still `reviewing` reopens, and its accept claim is dropped; a record that was discarded or recorded `merged` in the meantime is left as stored. A failure in the best-effort recovery after an error is logged, never masking the original error.

Cleanup that must run after the caller cancelled — aborting this accept's own merge, removing a review checkout, removing a merged worktree, and removing the worktree of a failed `create` — runs on its own 30-second signal instead of the request's, because a git command started on an aborted signal never runs.

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Public request, record, and outcome types (types-only) |
| [`src/text.ts`](src/text.ts) | Verbatim worker brief, reviewer prompt, and the reviewer's verdict schema |
| [`src/index.ts`](src/index.ts) | The `SubagentWorktrees` service: the `Config` interface and schema, thin method bodies, the exported `assertWorktreeId`, and the constructor, which resolves `root`, the reviewer route, and the commit author once at load (`create` and `list` resolve the repository through `repoIdentityOf` on each call) |
| [`src/config.ts`](src/config.ts) | Resolves and validates the flat reviewer-route and commit-author `Config` fields once at load; `Config` itself is declared in `src/index.ts` |
| [`src/worktree-id.ts`](src/worktree-id.ts) | The `wt-` id format: `assertWorktreeId`, applied at every public method and before any path is built from an id, and the non-throwing `isWorktreeId` that record listing uses to skip stray files |
| [`src/guards.ts`](src/guards.ts) | The structural type guards (`isPlainObject`, `isStringArray`) shared by stored-record validation and reviewer-result validation |
| [`src/git.ts`](src/git.ts) | Argv git commands through `ctx.subprocess`, with a scrubbed non-interactive environment, bounded output, and a lossy-capture check for output that is parsed |
| [`src/check-command.ts`](src/check-command.ts) | Runs the configured (non-git) check command under its deadline and collects its combined output |
| [`src/paths.ts`](src/paths.ts) | Pure directory-layout computation: the per-repository key and every path under it |
| [`src/records.ts`](src/records.ts) | Durable per-worktree JSON records: schema and integrity validation, atomic locked writes, cross-repository lookup by id and per-repository listing (both skip stray entries with a warning), and the owner/state assertions |
| [`src/workers.ts`](src/workers.ts) | The running-attached-worker refusal shared by `accept` and `discard` |
| [`src/repo.ts`](src/repo.ts) | `repoIdentityOf`: repository identity (top-level checkout and shared git common directory), which `create` and `list` resolve on each call |
| [`src/create.ts`](src/create.ts) | The `create` flow: repository resolution, `maxWorktrees`, provisioning with cleanup on failure, the base checkout's dirty summary |
| [`src/review.ts`](src/review.ts) | The reviewer child: bounding the diff, starting it, and validating its structured result |
| [`src/merge.ts`](src/merge.ts) | The `--no-ff` merge attempt: up-front refusals, classification of a failed merge from the base checkout's state, and aborting only this accept's own merge |
| [`src/landed.ts`](src/landed.ts) | Recovery of a stale `reviewing` record whose reviewed commit already landed, and the sweep of a worktree's directory, registration, and branch shared by `accept` and `discard` |
| [`src/accept.ts`](src/accept.ts) | The `accept` orchestration described in [Run flow](#run-flow) |
| — | No runtime invariant companion is published; every state transition is already reachable only through this package's own record-lock and owner-check enforcement, so no independent observation of the same relation exists to diverge. |

<a id="host-realm-git"></a>
### Host-realm git

Every git and check-command invocation in this package runs through `ctx.subprocess` with explicit argv and cwd — never a shell — in the **host realm**, not inside any session sandbox: the deployment's confinement policy for a delegated worker's own tool calls does not apply to this service's own git plumbing. Argv for these commands comes only from `Config` or operator (CLI) input, never from model input, which is what makes running them unsandboxed acceptable.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the shared subagent model to the consumers that put worktree isolation in front of a model or an operator.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — start requests, results, provider contract, and in-process depth and seed.
- [dsh-subagent](../subagent/README.md) — the delegation service (`ctx.subagents`) this package's reviewer child runs through.
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.md) — the fresh-child backend the reviewer runs on (provider name `spawn`).
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-worktree) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Worker brief and reviewer prompt (indirectly, through consumers)

#### What the model sees

This service adds no tool and no system-prompt section of its own; it never runs inside a model's own turn. It owns two pieces of verbatim, model-facing text that a consumer sends on its behalf: `renderWorkerBrief` states the worktree's path, branch, and base commit and asks the worker not to run git commands that write, prepended to the delegating consumer's own first message to the worker; `renderReviewerPrompt` states the review checkout, the commit range, the task, and a byte-bounded `git diff` of the change, and asks the reviewer child to call the `structured_output` tool with a `pass`-or-`fail` verdict, a summary, the checks it ran, and one finding per problem. While an isolation offer is live, the `isolation: "worktree"` parameter also appears in the `subagent` tool of every delegation provider with the `cwd` capability, including tools mounted inside agent presets; the parameter's own wording belongs to that tool's documentation.

#### Token effect

The worker brief adds a fixed prose block plus the worktree's own path, branch, and commit id to the worker's very first message. The reviewer prompt is a new, independent agent run per `accept` that needs a review: its main variable cost is the diff, capped at `Config.reviewDiffMaxBytes` (default 48 KiB) with a trailing truncation notice when cut. A commit whose last verdict already passed skips the reviewer entirely, at zero additional token cost. While an isolation offer is live, each affected `subagent` tool definition carries the added `isolation` parameter on every request; with no offer live, nothing is added.

#### KV Cache effect

Independent model requests: the worker's first message and the reviewer child's prompt each start a fresh conversation with no shared prefix with the delegating agent's own history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Git and check commands run in the host realm, unsandboxed** — this package's own git plumbing and the configured check command run outside any session sandbox (see [Host-realm git](#host-realm-git)); a deployment that needs every subprocess confined must not point `testCommand` at anything it would not also run directly on the host.
- **Windows is unverified** — git worktree layout, path handling, and the file-lock takeover in `@deepseek-ai/dsh-atomic-write` are exercised only on macOS and Linux in this package's own tests.
- **A worker installs its own dependencies** — the worktree is a plain linked checkout with no shared `node_modules`; the worker brief asks a worker to install from the local cache when needed, but nothing in this service does so on its behalf.
- **Uncommitted base changes are not carried into a new worktree** — `create` reports them (bounded to 20 entries plus the total) as `baseDirty` so a caller can warn about them, but a worktree only ever branches from the base checkout's committed `HEAD`.
- **`maxWorktrees` is advisory under concurrency** — `create` counts open worktrees and then persists its record without a lock in between, so two simultaneous `create` calls for one repository can both pass the check.
- **A recycled process id can pin a worktree** — an accept that crashed leaves its record `reviewing` with its process id, and a record whose id an unrelated later process reused reads as a live accept: the worktree stays refused as "already being accepted" until an operator clears the record. `withFileLock` documents the same limit for its own lock takeover.
- **A change whose diff exceeds 8 MiB cannot be reviewed** — `accept` fails loud instead of embedding a partial diff, and returns the worktree to `open`.
- **An interrupted discard leaves its leftovers** — `discard` claims the record before it removes anything, so a failure partway leaves the record `discarded` with the worktree or branch still present; run `discard` on it again once the cause is fixed, and it removes what is left.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
