# Agent Note: Worktree-isolated delegation with independent review

Status: implemented

English | [中文](2026-09-27-worktree-isolated-delegation.zh.md)

## Problem

A lead agent can already split work across subagents, but every child shares the lead's checkout. Parallel writers collide: filesystem stale-version checks protect only the edit tools, while Bash, formatters, and generators overwrite each other silently, and the [Agent Teams note](2026-08-05-agent-teams.md) records advisory write scopes as the only mitigation. Nothing checks a child's work before it lands; a child's own report is the only evidence. People and external agents (Claude Code, Codex) that want to hand a task to cheaper Harness agents have no command for it.

## Decision

A delegated agent can work in its own linked git worktree, and a worktree's changes reach the base checkout only through one harness operation that has an independent reviewer check the exact commit first.

- **Seam.** `SubagentStartRequest.cwd` replaces the parent's working directory in the child's durable `SessionHeader.cwd`. File tools, the shell working directory, and the sandbox write root already derive from that header, so no sandbox change is needed. The one-shot path gates the field on the `cwd` capability, which only the fresh `spawn` provider declares; the continuation manager validates the directory and gates on the same capability. A continuable child whose cwd differs from its parent's is not told that the parent shares its workspace.
- **Service.** `@deepseek-ai/dsh-subagent-worktree` owns `ctx.subagentWorktrees`: it creates `git worktree add -b` branches from the base checkout's `HEAD` under `<DSH_HOME>/worktrees/<repository key>/`, keeps one schema-validated record per worktree, and runs git through `ctx.subprocess` in the host realm with argv from configuration or operator input only.
- **Accept.** The harness commits the worktree (a child confined to its worktree cannot write the index and objects in the base repository's `.git`), creates a disposable detached checkout of that commit, runs an optional configured check command, and starts a reviewer child there with a structured verdict schema. The reviewer route is an operator override, then configuration, then the accepting agent's route, and must differ from the worker's route only when `requireDistinctReviewer` is set. Only a `pass` bound to the exact commit is merged, with `--no-ff` under a cross-process lock; a conflict aborts the merge and keeps the branch.
- **Consumers.** The `subagent` tool gains an `isolation: "worktree"` parameter when its row sets `worktreeIsolation`, or while the worktree tools' row holds an offer on `ctx.subagentWorktrees` (`offerIsolation()`, live for as long as that row is mounted) and its provider has the `cwd` capability. The offer lives on the shared service because agent presets mount their own `subagent` rows, which a bundle patch cannot reach, and it is a registration rather than configuration because a profile patch that replaces the service row's config, for example to pin a reviewer route, would otherwise switch it off; a delegation tool reads `offersIsolation` when it mounts and mounts again on `subagent-worktree/offer-changed`, so load order and bundle toggles do not decide the answer. A background worker is recorded on its worktree under a reserved child id before it starts, so an accept never races a live worker it cannot see. `accept_worktree`, `discard_worktree`, and `list_worktrees` act only on worktrees the calling Session created and validate the worktree id at the model boundary; the `agent-crew` skill teaches decomposition, cheaper worker routes, and the review loop. The optional `Agent crew` bundle adds the tools and skill from the Plugins page, configuring no shared row. The `dsh agents` command is the shipped `agents` profile: an operator Session runs one worker per `run`, accepts it as the operator, and optionally starts fixers that receive the worker brief with the findings.
- **Lifecycle.** A continuable child whose working directory no longer exists, for example after its worktree was merged and removed, fails to resume with a typed error instead of resuming into a missing directory.

## Placement outside the checkout

Worktrees live under the Harness home, not inside the repository. The `glob` tool searches ignored and hidden files and sorts by modification time, so a nested worktree would put a fresh copy of the repository ahead of the lead's own files; `git status` and `git add -A` in the lead's checkout would also see it. A lead whose sandbox root is its checkout can still commit in and merge from an outside worktree, because every git write lands in the base repository's `.git`; only deleting the directory needs the harness.

## Alternatives considered

**Worktrees inside the repository (`.dsh/worktrees/`).** Rejected for the search and status pollution above.

**Local clones.** Rejected: they duplicate objects and refs, turn landing into a fetch from a child-writable repository, and let the child write the git configuration and hooks the lead later executes.

**Children commit their own work.** Rejected: under `workspace-write` a child cannot write the base repository's `.git`, and widening its roots to the shared object store would let it rewrite other branches.

**Skill-taught `git merge` by the lead.** Rejected as the landing path: validation described only in prompt text is not enforced. The lead can still merge a branch by hand; `accept_worktree` is the operation whose result means "reviewed".

**A mandatory harness mutation gate.** Rejected: reverting a whole change also removes its new tests, and separating implementation from test files is project-specific. The reviewer performs the revert check with judgment and reports it; a configured check command remains available as a deterministic gate.

**Fast-forward-only merges.** Rejected: parallel workers branch from the same base, so after the first merge no later branch fast-forwards.

**Isolation inside the Team domain.** Not adopted: the [Agent Teams note](2026-08-05-agent-teams.md) keeps its shared-checkout boundary. Isolation here is an explicit per-delegation request on the ordinary `subagent` tool, not Team inference.

## Consequences

Each worker and reviewer installs project dependencies inside its own checkout; an offline pnpm install of this repository takes seconds under the sandbox. Uncommitted lead changes are not carried into a worktree; creation reports them. Accept costs one reviewer run per attempt, skipped when the same commit already passed. Records and worktrees survive restarts until discarded or merged. Out-of-process providers, the workflow tool's `agent({ isolation })`, and a non-git backend remain deferred.

## Testing

Seam tests cover the cwd override, validation, and capability gates on both paths. Service tests use real temporary repositories for creation, parallel `--no-ff` merges, conflicts, blocked merges, the verdict gate, fail-closed verdict parsing, owner checks, and bounds. Tool, skill, bundle, and CLI tests pin model-visible text and exit codes; composition tests boot the bundles through the Loader; a real-model end-to-end run exercises worker, reviewer, and merge.
