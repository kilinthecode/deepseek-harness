---
description: "The dsh agents bundle: a CLI that splits a task across worker agents in their own git worktrees, with an independent reviewer checking every change before it merges, for people and external agents scripting dsh."
kind: "package-bundle"
---

# @deepseek-ai/dsh-agents

English | [中文](README.zh.md)

## Summary

`dsh-agents` runs `dsh agents run "<task>"` from the command line: it creates a worker agent in its own git worktree, has an independent reviewer check the exact commit, and merges only a passing change into your checkout. `dsh agents list`, `accept`, and `discard` manage the worktrees that produces. It ships as the `agents` profile template, so `dsh agents ...` works with no install step. The boundary: the process drives one worktree lifecycle per `run`, then exits.

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

### Splitting a task across a worker and a reviewer

```sh
dsh agents run "add the parser and its tests"
```

This creates a fresh git worktree branched from your checkout's `HEAD`, starts a worker agent in it with the task, commits the worker's changes, has an independent reviewer check the exact commit against the task, and merges the change into your checkout once it passes. A merge reports whether the worktree and its branch were removed — removal usually accompanies a merge, but it is a separate step that can fail on its own, so the outcome always says which happened rather than assuming both did. A run that does not merge leaves the worktree `open`, printing the reviewer's findings, the failing check output, or the merge conflict so you can retry.

| Flag | Meaning |
|---|---|
| `--name <label>` | Short display label for the worktree; defaults to the first line of the task |
| `--model <provider>/<model>` | Route the worker runs on; defaults to the current default-model selection |
| `--effort <e>` | Reasoning effort; applies to `--model` when given, otherwise to the default-model selection |
| `--reviewer <provider>/<model>` | Route the reviewer runs on; defaults to the configured reviewer or your own route |
| `--reviewer-effort <e>` | Reasoning effort for `--reviewer`; rejected at parse time when `--reviewer` is absent |
| `--test "<cmd>"` | Check command run in the review checkout before the reviewer, split on whitespace |
| `--worktree <id>` | Reuse an existing `open` worktree instead of creating one |
| `--fix-rounds <n>` | Automatic fix attempts after a rejected review or a failing check; defaults to `0` |
| `--json` | Write newline-delimited run events to stdout instead of human-readable text |

`--test`'s command is split on runs of whitespace, not tokenized like a shell: it never sees quotes, globs, pipes, redirection, or environment expansion, and a value with none of these characters behaves as expected only by coincidence. A check that needs any of that belongs in a wrapper script, invoked as plain `--test ./check.sh`.

The task is the positional argument; a lone `-` reads it from stdin instead. Exit code `0` means the change merged; `2` means the run settled without merging (rejected, a failing check, a conflict, a block, or no change); `1` means the run itself failed (for example an unreviewable route pairing, or a missing worktree). On a rejected review or a failing check with fix rounds left, a fresh worker starts in the same worktree with the findings and the original task, then the cycle accepts again.

### Managing worktrees

```sh
dsh agents list [--all]
dsh agents accept <id> [--reviewer <provider>/<model>] [--reviewer-effort <e>] [--test "<cmd>"]
dsh agents discard <id>
```

`list` shows every worktree in the current repository, open ones by default and every state with `--all`. `accept` repeats the commit/check/review/merge cycle for an existing worktree, for example after you fixed a rejected worker's change yourself. `discard` deletes a worktree and its branch without merging; it refuses while an attached worker is still running. All three act as the operator: they reach every worktree of the invoking repository, not only ones a given `run` invocation itself created.

`list --json` writes one `worktree`-typed row per worktree: `id`, `path`, `branch`, `baseCommit`, `state` (`open`/`reviewing`/`merged`/`discarded`), `label`, and `verdict` (`"pass"` or `"fail"`, present only once a review has run against it). This is a narrower, differently-shaped `worktree` row than the one `run --json` emits below for the worktree it just created or reused.

### Machine-readable output

`--json` replaces the human-readable text with one JSON object per line: `worktree` (created or reused, with its id, path, branch, and base commit), `worker` (a settled worker or fixer child's session id, route, stop reason, and, when it stopped with an error, its diagnostic), `review` (the reviewer's verdict, commit, route, summary, and findings), `outcome` (the settled accept result), and `error` (a run-level failure). Event fields carry the complete 40-character commit id; only the human-readable text abbreviates a commit to 7 characters.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Run flow

`run` resolves the worker route (`--model`/`--effort`, else the shared [`agentDefaultModel`](../../core/agent-default-model/README.md) selection) and the reviewer override (`--reviewer`/`--reviewer-effort`), then calls `ctx.subagentWorktrees.resolveReviewer` before creating anything — a route pairing the independence check would reject fails before a worktree or a worker is created. It then creates an operator root Agent: a Session in the invoking directory, created the same way [`dsh-headless`](../headless/README.md) creates its Agent, that never takes a model turn — its only uses are as the delegating `parent` for the worker, fixer, and reviewer children, and as the caller route `resolveReviewer` falls back to. It creates a worktree (or reuses the `open` one named by `--worktree` — the operator view of every worktree of the invoking repository, not only ones a `run` itself created, the same reach `accept`/`discard` have), starts the worker as a one-shot foreground `spawn` child with its `cwd` set to the worktree and the worker brief prepended to the task, attaches it, and accepts. Each fix round starts a fresh child in the same worktree with the same worker brief, followed by this package's own fixer template — `Fix these problems in this worktree:` plus the reviewer's summary and findings, or the failing check command and its output, then `Original task:` and the original task text — attaches it, and accepts again. Every child's run is settled in a `finally`: the worktree service learns about it once it is published regardless of how its turn settles, its run is always disposed, and a `run.result` rejection (an infrastructure fault, not a model-level stop reason) aborts that child's own signal before propagating. The operator Agent itself is flushed and released the same way, once every child for the invocation has settled, on the success path and on every failure path.

### Patch surface over base

The patch rides over `dsh-base`: it sets the same coding persona and cwd suffix on the base `system-prompt` row as `dsh-headless`, keeps the same temporary process-wide PTC mode opt-in (`DSH_TOOLS_MODE`), disables the shared HMR row, and mounts the startup provider and the runner. The startup provider ([`src/startup.ts`](src/startup.ts)) parses the `run`/`list`/`accept`/`discard` verbs from `ctx.cmdlineArgs`, prints this app's `--help` (and, for no verb or an unknown one, exits `1`), and provides `agentsStartup`; the runner ([`src/index.ts`](src/index.ts)) injects that service alongside `ctx.subagentWorktrees` and `ctx.subagents` and reads its verb and options from lazy config.

### Source map

| File | Role |
|---|---|
| [`src/startup.ts`](src/startup.ts) | The `agents-startup` provider: the four verbs, their flags, `--help`, and `--json` grammar-error reporting |
| [`src/index.ts`](src/index.ts) | The `agents-runner` plugin: service guards and verb dispatch |
| [`src/run.ts`](src/run.ts) | `run`: route resolution, the fail-fast `resolveReviewer` preflight, worktree create/reuse, the worker and fix-round children, and accept |
| [`src/accept.ts`](src/accept.ts), [`src/accept-cycle.ts`](src/accept-cycle.ts) | `accept` and the shared accept-and-report step `run`'s fix-round loop reuses |
| [`src/list.ts`](src/list.ts), [`src/discard.ts`](src/discard.ts) | `list` and `discard` |
| [`src/operator.ts`](src/operator.ts) | The operator root Agent and invoking-directory resolution |
| [`src/route.ts`](src/route.ts) | Route flag parsing, label derivation, check-command splitting, and the reused-worktree directory formula |
| [`src/render.ts`](src/render.ts), [`src/fixer.ts`](src/fixer.ts) | Human text, `--json` event payloads, and the fix-round prompt |
| [`cordis.patch.yml`](cordis.patch.yml) | The patch over `dsh-base` |
| — | No runtime invariant companion is published; the runner's observable contract (worktree lifecycle, exit code by settled outcome) is process-level and owned by the launcher e2e; it registers nothing and holds no mutable relation to audit inside the tree. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bundle package map](../README.md) — the surfaces built on the same core.
- [dsh-base](../base/README.md) — the shared core `dsh agents` runs on.
- [dsh-headless](../headless/README.md) — the sibling one-shot runner this bundle's patch surface mirrors.
- `dsh-subagent-worktree` (`packages/subagent/subagent-worktree`) — the worktree lifecycle, review, and merge service this runner drives.
- [dsh-cmdline](../../boot/cmdline/README.md) — how the launcher hands the command line to the app.

-----

<a id="model-experience"></a>
## Model Experience

### Fixer prompt template

#### What the model sees

The first worker's prompt is the worker brief `dsh-subagent-worktree` owns, prepended to the task verbatim; this package contributes no text of its own there. A fix round's child instead receives that same brief followed by this package's own fixed template: `Fix these problems in this worktree:`, then either the reviewer's summary together with its findings or the failing check command and its output, then `Original task:` and the original task text.

#### Token effect

Only a fix round pays for the template: its fixed wording is a few dozen tokens, plus whatever the reviewer's summary, findings, or check output add, once per fixer child's prompt. A `run` that merges on the first try, or that keeps `--fix-rounds` at its default of `0`, never starts a fixer and never pays this cost.

#### KV Cache effect

Each fixer child is a fresh one-shot request; the template becomes part of that child's own prompt prefix once, at the start of its single turn, and is never revised mid-run. The runner itself drives no model request of its own — every child it starts, worker or fixer, opens an independent request under its own composition.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One worktree lifecycle per `run`** — after the run settles (or a fix round is spent) the process exits; there is no interactive follow-up, so retrying a rejected run again is a new `dsh agents accept` or `dsh agents run --worktree <id>` invocation.
- **`--json` events carry unbounded reviewer and check text** — `review.findings` and `outcome.output`/`outcome.summary` are not capped by this package; a reviewer or check command that produces very large text produces a correspondingly large event line.
- **Requires `ctx.subagentWorktrees` and `ctx.subagents`** — composing the `agents` profile without a `dsh-base` layer that mounts both leaves the runner permanently pending; it never activates and never exits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
