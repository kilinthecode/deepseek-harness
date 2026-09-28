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
| `reviewDiffMaxBytes` | `49152` | Byte bound on the diff embedded in the reviewer prompt |
| `removeOnMerge` | `true` | Remove the worktree directory and branch after a successful merge |
| `commitAuthorName` / `commitAuthorEmail` | — | Author identity for harness commits, set together; omitted uses git's configured identity |

`reviewerProvider`/`reviewerModel` and `commitAuthorName`/`commitAuthorEmail` each fail loud at load if only one half of the pair is set, and `reviewerReasoningEffort` fails loud if set without both reviewer fields. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-worktree) is the exhaustive source for every accepted field and its JSDoc.

By default the reviewer runs on the route of the accepting agent, so a worker started on a cheaper route is reviewed on the accepting agent's route automatically. To enforce a reviewer on a different model than the worker, configure `reviewerProvider`/`reviewerModel` and set `requireDistinctReviewer: true`.

### The service surface

`ctx.subagentWorktrees` exposes six methods, all taking a single request object:

| Method | Effect |
|---|---|
| `create` | Provisions one linked worktree on a new branch from the base checkout's `HEAD`; returns the `open` record, the worker's directory, and any uncommitted base changes the worktree does not contain |
| `attach` | Records one worker session id and route on an open (or terminal-refused) worktree |
| `resolveReviewer` | Resolves the reviewer route — operator override, then `Config`, then the caller's own route — and throws if it would equal the worker's route while `requireDistinctReviewer` is set |
| `accept` | The only operation that commits or merges: see [Run flow](#run-flow) |
| `discard` | Deletes one worktree and its branch without merging; refused while an attached worker's Agent is still running |
| `list` | Lists one repository's worktrees, optionally filtered by owner and including closed records |

Every method authorizes its caller: a `session` owner may act only on its own worktrees, while an `operator` (the `dsh agents` CLI) may act on any worktree of the repository. `create` and `list` resolve the target repository from a `baseDir` inside it; `attach`, `accept`, and `discard` take only the worktree id and search every repository under `root` for its record, because the record's own `repoRoot` then supplies the repository for every later git command.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and where the behavior in [Use this package](#use-this-package) comes from.

### Design concept

Every worktree, its durable JSON record, and its disposable review checkouts live under one per-repository directory keyed by a hash of the repository's canonical top-level path, so two checkouts of the same project never collide and a worktree never lives inside a repository it isolates work from. A record moves through `open → reviewing → open | merged` and `open → discarded`; the transition into `reviewing` happens under that record's own writer lock, re-checking the state there rather than before acquiring the lock, because only the lock actually serializes two concurrent `accept` calls. A `reviewing` record whose accepting process no longer exists is treated as `open` (crash recovery) the next time any operation reads it.

<a id="run-flow"></a>
### Run flow: `accept`

1. Load the record, authorize the caller, and refuse if an attached worker's Agent is still running.
2. Transition to `reviewing` under the record lock (re-checking `open`-or-stale-reviewing there).
3. Commit: `git add -A`, then commit only if something was staged (`-c user.name=`/`-c user.email=` only when `commitAuthorName`/`commitAuthorEmail` are configured). If the resulting commit equals the worktree's base commit, the outcome is `empty` and the record returns to `open`.
4. If the last recorded verdict already passed for this exact commit, skip straight to the merge — a blocked or conflicted merge retried without new changes does not pay for a second review.
5. Otherwise, in one disposable detached checkout at the commit (stale checkouts of the same worktree are swept first): run the configured check command, if any — a nonzero exit is `checks-failed` and the reviewer never starts — then start the reviewer child through `ctx.subagents.start('spawn', …)` with the bounded diff and the worktree's task in its prompt, and validate its structured result against the verdict schema in host code. A missing or invalid result, or a run that never completes, is a `fail` verdict with the finding `the reviewer returned no structured verdict` — fail closed, never an exception and never a pass.
6. A `fail` verdict is `rejected`; the worktree returns to `open`. A `pass` verdict attempts `git merge --no-ff --no-edit` into the base checkout under a per-repository merge lock (parallel workers branch from the same base, so after the first merge no later branch can fast-forward). A real conflict aborts the merge and reports the conflicted paths, keeping the branch; a merge that never starts (for example because local changes would be overwritten) reports the bounded git message. Both leave the record `open` with the verdict kept.
7. A successful merge is recorded — state `merged`, the merge commit id — before `removeOnMerge` deletes the worktree and branch, so a cleanup failure after a real merge cannot make the record contradict the base checkout's own history.
8. Any thrown error returns a still-`reviewing` record to `open` before rethrowing; a failure in that best-effort recovery is logged, never masking the original error.

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Public request, record, and outcome types (types-only) |
| [`src/text.ts`](src/text.ts) | Verbatim worker brief, reviewer prompt, and the reviewer's verdict schema |
| [`src/index.ts`](src/index.ts) | The `SubagentWorktrees` service: `Config` schema, root and identity resolution at load, thin method bodies |
| [`src/config.ts`](src/config.ts) | `Config` type and schema; resolves and validates the flat reviewer-route and commit-author fields once at load |
| [`src/git.ts`](src/git.ts) | Argv git commands through `ctx.subprocess`, with a scrubbed non-interactive environment and bounded output |
| [`src/check-command.ts`](src/check-command.ts) | Runs the configured (non-git) check command and collects its combined output |
| [`src/paths.ts`](src/paths.ts) | Pure directory-layout computation: the per-repository key and every path under it |
| [`src/records.ts`](src/records.ts) | Durable per-worktree JSON records: schema validation, atomic locked writes, cross-repository lookup by id, and the owner/state assertions |
| [`src/workers.ts`](src/workers.ts) | The running-attached-worker refusal shared by `accept` and `discard` |
| [`src/repo.ts`](src/repo.ts) | Repository top-level resolution shared by `create` and `list` |
| [`src/create.ts`](src/create.ts) | The `create` flow: repository resolution, `maxWorktrees`, provisioning, the base checkout's dirty summary |
| [`src/review.ts`](src/review.ts) | The reviewer child: bounding the diff, starting it, and validating its structured result |
| [`src/merge.ts`](src/merge.ts) | The `--no-ff` merge attempt and its conflict/blocked classification |
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

This service adds no tool and no system-prompt section of its own; it never runs inside a model's own turn. It owns two pieces of verbatim, model-facing text that a consumer sends on its behalf: `renderWorkerBrief` states the worktree's path, branch, and base commit and asks the worker not to run git commands that write, prepended to the delegating consumer's own first message to the worker; `renderReviewerPrompt` states the review checkout, the commit range, the task, and a byte-bounded `git diff` of the change, and asks the reviewer child to call the `structured_output` tool with a `pass`-or-`fail` verdict, a summary, the checks it ran, and one finding per problem.

#### Token effect

The worker brief adds a fixed prose block plus the worktree's own path, branch, and commit id to the worker's very first message. The reviewer prompt is a new, independent agent run per `accept` that needs a review: its main variable cost is the diff, capped at `Config.reviewDiffMaxBytes` (default 48 KiB) with a trailing truncation notice when cut. A commit whose last verdict already passed skips the reviewer entirely, at zero additional token cost.

#### KV Cache effect

Independent model requests: the worker's first message and the reviewer child's prompt each start a fresh conversation with no shared prefix with the delegating agent's own history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Git and check commands run in the host realm, unsandboxed** — this package's own git plumbing and the configured check command run outside any session sandbox (see [Host-realm git](#host-realm-git)); a deployment that needs every subprocess confined must not point `testCommand` at anything it would not also run directly on the host.
- **Windows is unverified** — git worktree layout, path handling, and the file-lock takeover in `@deepseek-ai/dsh-atomic-write` are exercised only on macOS and Linux in this package's own tests.
- **A worker installs its own dependencies** — the worktree is a plain linked checkout with no shared `node_modules`; the worker brief asks a worker to install from the local cache when needed, but nothing in this service does so on its behalf.
- **Uncommitted base changes are not carried into a new worktree** — `create` reports them (bounded to 20 entries plus the total) as `baseDirty` so a caller can warn about them, but a worktree only ever branches from the base checkout's committed `HEAD`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
