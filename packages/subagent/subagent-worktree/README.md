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
| `discard` | Deletes one worktree and its branch without merging. It claims the record under its lock before any git change, so it is refused while an `accept` holds the worktree or an attached worker's Agent is still running; a directory or branch that is already gone is skipped, and a branch probe that was cancelled or exited with anything but its documented answers throws, so a sweep that could not check the branch never reports success with that branch left behind. On a `merged` or `discarded` record it changes nothing except to remove a leftover worktree or branch, so a `discard` that failed partway can be run again to finish. A stale `reviewing` record whose reviewed commit already landed is recorded `merged` first, as `accept` does |
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

Every worktree, its durable JSON record, and its disposable review checkouts live under one per-repository directory keyed by the repository's name and a hash of its git common directory, so two unrelated repositories never collide, every linked worktree of one repository shares one records directory, merge lock, and `maxWorktrees` count, and a worktree never lives inside a repository it isolates work from. Each record still keeps the checkout it was created from as its merge target. A record moves through `open → reviewing → open | merged` and `open → discarded`; the transitions into `reviewing` and `discarded`, and an `attach`, check the state and the running workers under that record's own writer lock rather than before acquiring it, because only the lock serializes concurrent operations. A `reviewing` record whose accepting process no longer exists is treated as `open` (crash recovery) the next time any operation reads it, unless its worktree still holds exactly the reviewed commit and that commit is already in the base checkout's history, in which case it is recorded `merged`. `merged` and `discarded` records are closed: `discard` may be repeated on them to remove leftovers, and nothing reopens them.

<a id="run-flow"></a>
### Run flow: `accept`

1. Refuse a `session` owner that sets `testCommand` or `reviewer`, then load the record and authorize the caller.
2. If the record is `reviewing` with a dead accepting process, its last verdict passed, its worktree still holds exactly the reviewed commit (its `HEAD` is that commit and nothing is modified, staged, or untracked), and that commit is already an ancestor of the base checkout's `HEAD`, an earlier accept died after its merge landed: record it `merged` with the commit that landed it, remove the leftovers when `removeOnMerge` is set, and return `merged` without a second review or merge. A worktree that holds anything more is not recovered, and its newer work is reviewed like any other. That landing-commit read is tried once on the caller's signal and retried once on a fresh signal, exactly as the merge path's own read is, because the caller's cancellation often is what failed it; when it fails twice, the record is still closed as `merged` — without a `mergedCommit`, with the failure in the host log — and an error says the merge landed, because a record left `reviewing` would fail every later `accept` on a read that may never succeed.
3. Under the record lock, check that the record is `open` (or `reviewing` with a dead accepting process) and that no attached worker's Agent is still running, then transition to `reviewing` and record the accepting process id. A review can run for minutes and a worker can restart meanwhile, so the running-worker check is repeated right before `git add` and right before `git merge`.
4. Commit: `git add -A`, then commit only if something was staged (`-c user.name=`/`-c user.email=` only when `commitAuthorName`/`commitAuthorEmail` are configured). If the resulting commit equals the worktree's base commit, the outcome is `empty` and the record returns to `open`.
5. If the last recorded verdict already passed for this exact commit, skip straight to the merge — a blocked or conflicted merge retried without new changes does not pay for a second review.
6. Otherwise, in one disposable detached checkout at the commit (stale checkouts of the same worktree are swept first): run the configured check command, if any, under `checkTimeoutMs` — a nonzero exit or a timeout is `checks-failed` and the reviewer never starts — then start the reviewer child through `ctx.subagents.start('spawn', …)` with the bounded diff and the worktree's task in its prompt, and validate its structured result against the verdict schema in host code. A missing or invalid result, or a run whose stop reason is not `completed`, is a `fail` verdict with the finding `the reviewer returned no structured verdict` — fail closed, never an exception and never a pass.
7. A `fail` verdict is `rejected`; the worktree returns to `open`. A `pass` verdict attempts `git merge --no-ff --no-edit` into the base checkout under a per-repository merge lock, waiting up to ten minutes for another accept's merge (parallel workers branch from the same base, so after the first merge no later branch can fast-forward). The attempt first refuses as `blocked`, without running `git merge`, when the base checkout already has a merge in progress (`MERGE_HEAD` exists) or a detached `HEAD`; a probe that was cancelled or failed throws instead of being read as an answer. When `git merge` fails, the base checkout's state decides, because git's exit codes cannot tell a refusal from an error. Exit 128 is how git reports a refusal that started nothing — another merge already in progress is the case in point — and also some failures after starting (`write_merge_state()` can die once `MERGE_HEAD` is written, and `finish()` after the merge was applied), so it is classified by the `MERGE_HEAD` it left: none, with a clean checkout, is `merged` when the reviewed commit is already in the base checkout's history (`git merge-base --is-ancestor`, which is where a `finish()` that died after applying the merge leaves it) and `blocked` otherwise, naming the conflicts another operation left when the checkout has unmerged paths and carrying the bounded git message otherwise, with a probe that cannot answer either question throwing instead of being read as an answer (as does a failed scan for those unmerged paths); one naming another commit is `blocked` with that merge left exactly as found; one naming the very commit this accept was merging is left in place and thrown, because nothing can tell it apart from another operation's merge of that same commit, which git refuses the same way without touching it — the error says the merge must be finished or aborted there with `git merge --abort`, and the absolute path and commit go to the host log only. Any other failed merge is classified by its state as before: a merge whose `MERGE_HEAD` is this accept's commit is aborted before any further probe runs, and one that stopped with the conflict exit code first reads its unmerged paths, which the abort discards, so it can be reported as `conflict` with them, keeping the branch; both that read and the exit-128 scan ask for submodules explicitly (`--ignore-submodules=none`), so no git config can make a conflicted submodule gitlink read as no conflicts, and neither a failed read nor a failed scan skips the abort — each throws ids and a fixed description, with git's message, which may name absolute paths, and the absolute path going to the host log only; conflicts or a `MERGE_HEAD` this accept did not create are `blocked` and left untouched; a merge that never started (for example because local changes would be overwritten) is `blocked` with the bounded git message; a merge that was killed, or failed after starting without conflicts, is aborted — only ever this accept's own merge — and thrown. When the abort does not clear `MERGE_HEAD`, or the abort or the check that it worked fails, or the `MERGE_HEAD` probe right after the failed merge fails, the attempt throws that the base checkout is left mid-merge (or may be) and must be aborted there with `git merge --abort`, and no outcome that says nothing was merged is returned; when the abort does clear this accept's merge but the check then finds a `MERGE_HEAD` naming another commit, the attempt throws that this accept's merge was aborted and another merge is now in progress, and it leaves that one alone rather than aborting it; the absolute path goes to the host log only. Conflict and blocked leave the record `open` with the verdict kept.
8. The lock is released as soon as the merge attempt ends. A successful merge is recorded in one write — state `merged` and `mergedCommit` — and only then does `removeOnMerge` delete the worktree and branch. `mergedCommit` is the merge commit that lists the reviewed commit as a parent, or the reviewed commit itself when none does (it was fast-forwarded in, or `git merge` found it already contained), never an unrelated later `HEAD`; those merge commits are listed newest-first in topological order, so a merge is never listed before a merge it descends from and the last line that lists the reviewed commit is its earliest landing in DAG order, whatever the commit dates say; a base checkout whose history is longer than that command's byte cap keeps the oldest ones — where the answer is — and the possibly partial first line of the truncated listing is dropped, with a truncated listing that holds no line listing the reviewed commit throwing instead of answering with the reviewed commit, whose id may well be in the part the cut dropped. From the moment `git merge` exits 0 the record is never reopened. Reading that commit is retried once; if it still cannot be read, the record is recorded `merged` without one and an error says the merge landed. A failed write of the `merged` state releases the accept claim on a best-effort basis, so the next `accept` or `discard` recognizes the stale record as landed, and throws an error saying the merge landed. A failed removal is logged and returns `merged` with `removed: false`, which `discard` then finishes.
9. Any error thrown before the merge landed, and every outcome that did not merge (`empty`, `checks-failed`, `rejected`, `conflict`, `blocked`), returns the record to `open`. Only a record still `reviewing` reopens, and its accept claim is dropped; a record that was discarded or recorded `merged` in the meantime is left as stored. A failure in the best-effort recovery after an error is logged, never masking the original error, and a failed reopen write releases the accept claim best effort, so a live process id does not pin the record.

Cleanup that must run after the caller cancelled — aborting this accept's own merge, removing a review checkout, removing a merged worktree, `discard`'s sweep of the worktree and branch after its point of no return, and removing the worktree of a failed `create` — asks for a fresh 30-second signal for each git command instead of using the request's, because a git command started on an aborted signal never runs and one that runs out of time must not abort the next.

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Public request, record, and outcome types (types-only) |
| [`src/text.ts`](src/text.ts) | Verbatim worker brief, reviewer prompt, and the reviewer's verdict schema |
| [`src/bounds.ts`](src/bounds.ts) | Byte, character, and line bounds for durable and model-facing text: the reviewer diff prefix cut on a UTF-8 character boundary, the diagnostic tail of check and merge output, and the base checkout's dirty-status summary |
| [`src/index.ts`](src/index.ts) | The `SubagentWorktrees` service: the `Config` interface and schema, thin method bodies, the exported `assertWorktreeId`, and the constructor, which resolves `root`, the reviewer route, and the commit author once at load (`create` and `list` resolve the repository through `repoIdentityOf` on each call) |
| [`src/config.ts`](src/config.ts) | Resolves and validates the flat reviewer-route and commit-author `Config` fields once at load; `Config` itself is declared in `src/index.ts` |
| [`src/worktree-id.ts`](src/worktree-id.ts) | The `wt-` id format: `assertWorktreeId`, applied at every public method and before any path is built from an id, and the non-throwing `isWorktreeId` that record listing uses to skip stray files |
| [`src/guards.ts`](src/guards.ts) | The structural type guards (`isPlainObject`, `isStringArray`) shared by stored-record validation and reviewer-result validation |
| [`src/git.ts`](src/git.ts) | Argv git commands through `ctx.subprocess`, with a scrubbed non-interactive environment, bounded output, a lossy-capture check for output that is parsed, one read that accepts a listing truncated to the tail its byte cap kept, and `cleanupSignal`, the fresh bounded signal each cleanup command runs on |
| [`src/check-command.ts`](src/check-command.ts) | Runs the configured (non-git) check command under its deadline and collects its combined output |
| [`src/paths.ts`](src/paths.ts) | Pure directory-layout computation: the per-repository key and every path under it |
| [`src/fs-util.ts`](src/fs-util.ts) | `pathExists`, the existence probe shared by record and worktree-directory lookups: `true` when `stat` succeeds, `false` for `ENOENT`, and a throw for any other failure |
| [`src/records.ts`](src/records.ts) | Durable per-worktree JSON records: schema and integrity validation, atomic locked writes, cross-repository lookup by id and per-repository listing (both skip stray entries with a warning), and the owner/state assertions |
| [`src/workers.ts`](src/workers.ts) | The running-attached-worker refusal shared by `accept` and `discard` |
| [`src/repo.ts`](src/repo.ts) | `repoIdentityOf`: repository identity (top-level checkout and shared git common directory), which `create` and `list` resolve on each call |
| [`src/create.ts`](src/create.ts) | The `create` flow: repository resolution, `maxWorktrees`, provisioning with cleanup on failure, the base checkout's dirty summary, asked for one entry per untracked directory so a checkout holding tens of thousands of untracked files still summarizes inside the capture cap instead of failing `create` |
| [`src/review.ts`](src/review.ts) | The reviewer child: bounding the diff, starting it, and validating its structured result |
| [`src/merge.ts`](src/merge.ts) | The `--no-ff` merge attempt: up-front refusals, classification of a failed merge from the base checkout's state — exit 128 included, which can also follow a started merge, so a same-commit `MERGE_HEAD` is left in place and thrown and a commit already in the base checkout is `merged` by way of `git merge-base --is-ancestor` — the unmerged-path read and its `--ignore-submodules=none`, aborting only this accept's own merge, the cause of a failed read going to the host log instead of the error, and `landedCommitOf`, the commit that landed a reviewed commit, read newest-first in topological order from the oldest end of its listing so that neither a backdated re-landing nor a history longer than the output cap can hide the earliest landing, and refused when a truncated listing holds no line that lists the reviewed commit |
| [`src/landed.ts`](src/landed.ts) | Recovery of a stale `reviewing` record whose reviewed commit already landed, for a worktree that still holds exactly that commit — closed as `merged` even when the commit that landed it cannot be read, that read being retried once on a fresh signal and its failure logged — and the sweep of a worktree's directory, registration, and branch shared by `accept` and `discard`, whose branch probe throws unless it answers |
| [`src/accept.ts`](src/accept.ts) | The `accept` orchestration described in [Run flow](#run-flow) |
| — | No runtime invariant companion is published; every state transition is already reachable only through this package's own record-lock and owner-check enforcement, so no independent observation of the same relation exists to diverge. |

<a id="host-realm-git"></a>
### Host-realm git

Every git and check-command invocation in this package runs through `ctx.subprocess` with explicit argv and cwd — never a shell — in the **host realm**, not inside any session sandbox: the deployment's confinement policy for a delegated worker's own tool calls does not apply to this service's own git plumbing. Argv for these commands comes only from `Config` or operator (CLI) input, never from model input, which is what makes running them unsandboxed acceptable.

Two of these commands run in a directory the worker's sandbox can write: `accept` stages and commits in the worktree, and the recovery of an unrecorded merge reads the worktree's `HEAD` and status. Git would take its repository from the worktree's own `.git` entry, which the worker can rewrite to name a repository whose `core.fsmonitor` command then runs on the host. It would also resolve a relative `core.hooksPath` or `core.fsmonitor` from the base configuration inside the worker's tree, where the worker can plant the hook; `--no-verify` skips only `pre-commit` and `commit-msg`. These commands therefore run against the worktree's administrative directory, which the service finds in the shared git directory the worker cannot write, with `core.hooksPath=/dev/null` and `core.fsmonitor=false`. Commands in the base checkout are not confined this way, because the worker cannot write it. A merge runs the base repository's hooks, so when `core.hooksPath` names a tracked directory, a change to a hook there takes effect during the merge that lands it; the reviewer sees that change only as part of the diff.

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

- **Git and check commands run in the host realm, unsandboxed** — this package's own git plumbing and the configured check command run outside any session sandbox (see [Host-realm git](#host-realm-git)); a deployment that needs every subprocess confined must not point `testCommand` at anything it would not also run directly on the host. The check command runs in a checkout of the worker's commit, so a test script the worker wrote runs with host privileges.
- **Windows is unverified** — git worktree layout, path handling, and the file-lock takeover in `@deepseek-ai/dsh-atomic-write` are exercised only on macOS and Linux in this package's own tests.
- **A worker installs its own dependencies** — the worktree is a plain linked checkout with no shared `node_modules`; the worker brief asks a worker to install from the local cache when needed, but nothing in this service does so on its behalf.
- **Uncommitted base changes are not carried into a new worktree** — `create` reports them (bounded to 20 entries plus the total) as `baseDirty` so a caller can warn about them, but a worktree only ever branches from the base checkout's committed `HEAD`.
- **`maxWorktrees` is advisory under concurrency** — `create` counts open worktrees and then persists its record without a lock in between, so two simultaneous `create` calls for one repository can both pass the check.
- **A recycled process id can pin a worktree** — an accept that crashed leaves its record `reviewing` with its process id, and a record whose id an unrelated later process reused reads as a live accept: the worktree stays refused as "already being accepted" until an operator clears the record. `withFileLock` documents the same limit for its own lock takeover.
- **A change whose diff exceeds 8 MiB cannot be reviewed** — `accept` fails loud instead of embedding a partial diff, and returns the worktree to `open`.
- **An interrupted discard leaves its leftovers** — `discard` claims the record before it removes anything, so a failure partway leaves the record `discarded` with the worktree or branch still present; run `discard` on it again once the cause is fixed, and it removes what is left.
- **A merge that cannot be aborted needs an operator** — when `git merge --abort` fails or cannot be confirmed, `accept` throws that the base checkout is left mid-merge and reopens the worktree; the operator runs `git merge --abort` in the base checkout, because every later `accept` is blocked by the merge in progress until then.
- **A merge the harness did not start is never aborted** — exit 128 is how git reports a refusal that started nothing — most often because the base checkout already has another merge in progress — and also some failures after starting, so a `MERGE_HEAD` naming another commit at that exit code is `blocked` and left exactly as found, while one naming the commit this accept was merging is left in place and thrown: nothing can tell this accept's own half-applied merge apart from another operation's merge of that same commit, which git refuses the same way without touching it, and the error says the merge must be finished or aborted in the base checkout. Exit 128 with no `MERGE_HEAD` and no unmerged paths is settled by `git merge-base --is-ancestor`: a merge that died in `finish()` after applying its result counts as `merged` — through the same path, `onLanded` and all, as a merge that exited 0 — so a later `accept` does not attempt it a second time, and only a commit that is not in the base checkout's history is `blocked` with git's message. The check after this accept's own abort can likewise find a `MERGE_HEAD` for another commit in its place. Either way every later `accept` for the repository stays blocked by that merge until whoever started it is done.
- **A failed recovery probe blocks `accept` but not `discard`** — the probes that decide whether a stale `reviewing` record already landed (`git merge-base --is-ancestor`, `rev-parse HEAD`, `status --porcelain`) answer in documented exit codes, and a probe that was cancelled or exited with anything else throws with the worktree id (never a path) instead of being read as "not merged", including a verdict naming a commit git can no longer resolve, which is exit 128. `accept` cannot safely merge or mark state without an answer, so it leaves the record exactly as it was, with no claim taken on it, and fails the same way until an operator fixes the git state or clears the record. `discard` logs that failure with its path and goes on to mark the record `discarded` and sweep it: removal is `discard`'s whole purpose, and any merge that did land stays in the base checkout's history.
- **A status read is asked for what `git add -A` would stage** — the recovery clean check passes `--untracked-files=all --ignore-submodules=none`, `create`'s `baseDirty` read passes `--untracked-files=normal --ignore-submodules=none` (one entry per untracked directory is all a summary needs, and it keeps a base checkout whose untracked build output or virtualenv holds tens of thousands of files inside the capture cap instead of failing `create` outright), `accept`'s empty check passes `--ignore-submodules=none` (which `git diff` accepts; `--untracked-files` is a `git status` option), and the unmerged-path reads pass `--ignore-submodules=none` too, so `status.showUntrackedFiles=no`, `status.ignoreSubmodules=all`, `submodule.<name>.ignore=all`, and `diff.ignoreSubmodules=all` cannot hide work or a conflict from them. Where the ignore setting makes `git commit` itself refuse the staged change it hid, `accept` fails loud with `git commit failed` and keeps the worktree, rather than reporting `empty`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
