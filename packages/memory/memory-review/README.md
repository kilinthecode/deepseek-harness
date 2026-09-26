---
description: "Cache-parity unattended memory review: a fork child that may only add new memories, started from the parent idle notification, for users and maintainers choosing, configuring, or debugging the review."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-review

English | [中文](README.zh.md)

## Summary

`dsh-memory-review` starts an unattended in-process fork after enough user-kind turns so the child can save durable memories from the conversation the parent already has. The parent model sees nothing; the child inherits the parent's completed turns, then a review task, and may only add new names. The base bundle and the TUI profile enable it every ten user turns with an eight-step cap; headless, ACP, and SDK disable it; Web remounts it on the `standard`, `cordis`, and `ptc` presets. Choose it when a live process should save memories without changing the parent's request prefix.

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

Mount it after [`dsh-tool-memory`](../tool-memory/README.md) whenever the `fork` provider is present and a live process should review the conversation for durable memories. Both config fields are required; a composition that omits either fails at load.

### When to choose it

Choose it when a live interactive process should save durable memories from a conversation without changing the parent's request prefix or waiting for a new session. Leave it disabled for headless, ACP, and SDK automation, whose process may exit as soon as the parent is idle, and for compositions that omit `dsh-tool-memory` or the `fork` provider. `reviewEveryUserTurns: 0` keeps the plugin mounted but never starts a child.

### Minimal configuration

Both fields are required with no default; a composition that omits either, sets `reviewEveryUserTurns` below `0`, or sets `maxReviewSteps` below `1` fails at load. A review that becomes due while `memory_write` or the `fork` provider is missing logs an error naming the missing piece and does not start; sibling plugins activate concurrently, so their registrations cannot be checked at load.

```yaml
- name: '@deepseek-ai/dsh-memory-review'
  config:
    reviewEveryUserTurns: 10
    maxReviewSteps: 8
```

| Field | Default | Meaning |
|---|---|---|
| `reviewEveryUserTurns` | required | User-kind parent messages between reviews; shipped compositions use `10`; `0` disables reviews while the plugin stays mounted |
| `maxReviewSteps` | required | Inclusive cap on the review child's `agent/pre-step` `step`; shipped compositions use `8`; step `maxReviewSteps + 1` is rejected |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-memory-review) is the exhaustive source for the accepted fields.

### What the parent and the child see

The parent model receives no extra prompt, tool result, or snapshot from this plugin. The child's writes are confirmed in the child's tool results and appear in a later snapshot (after compaction or in a new session). On Web, the parent header catalog shows an ordinary subagent row labelled `memory-review`. The child inherits the parent's completed turns, then the review task as its first new user-role message, and may call `memory_recall` and `memory_write` only to add a name that is not already visible.

### Where it is mounted

The base bundle enables it immediately after `tool-memory` with `reviewEveryUserTurns: 10` and `maxReviewSteps: 8`, so the TUI profile (which uses only that bundle) has it. Headless, ACP, and SDK patches disable `id: memory-review`. The Web host plane disables it beside `tool-memory`; the `standard`, `cordis`, and `ptc` presets remount it per session with both fields. The `minimal` preset omits it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the review and points at the code that realizes them; the observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

- **Idle trigger, not a tool.** A global `agent/status` listener starts a review when `status` is `idle` and does not await the child. It skips the start when `reviewEveryUserTurns` is `0`, when `agent.session.header.parentSession` is set (no nested reviews of any child), when a review is already in flight for that parent, or when `turnsSinceReset` is below the interval.
- **Count user-kind turns on the parent log.** The `memoryReview` projection is `stateVersion: 1` with `{ turnsSinceReset: number }` and `init: () => ({ turnsSinceReset: 0 })`. It folds `user/message` with `source.kind === 'user'` by adding one, and folds `tool/call` named `memory_write`, `memory_recall`, or `memory_forget`, and `subagent/catalog` with `label === 'memory-review'`, to `{ turnsSinceReset: 0 }`. Messages with `source.kind === 'goal'` do not count. Resume rebuilds the count from the parent log.
- **Cache-parity fork.** The start is `ctx.agents.withInitiator(parent, () => ctx.subagents.start('fork', { parent, prompt: [{ type: 'text', text: REVIEW_PROMPT }], label: 'memory-review', signal }))` and omits `toolFilter`, `persona`, and `agentOptions`, so the child's first request keeps the parent's route, tools, and persona. The start requires `run.localAgent`; otherwise it logs a warning, disposes the run, and does not keep the parent pending.
- **Race-free restriction.** A global `agent/created` listener, while that parent is pending review and `created.agent.session.header.parentSession` is that parent, calls `installReviewRestrictions` on `created.agent.ctx` during the serial `agent/created` that `agents.create` awaits before `start()` returns, so the child's first tool call is already guarded. `tools/pre-execute` awaits `next()`, then allows `memory_recall`, allows `memory_write` only when no visible record has that `name` and `scope`, and denies `memory_forget` and every other name with `{ kind: 'deny', reason }`. `agent/pre-step` returns `{ kind: 'reject' }` when `step > maxReviewSteps`.
- **Disposal.** An in-flight review is aborted on `agent/disposed` for that parent and when the plugin fiber disposes (`ctx.effect`). After a successful start, `void run.result.finally(() => run.dispose())` deletes the pending mark and disposes the child.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, idle trigger, fork start, `agent/created` restriction install |
| [`src/projection.ts`](src/projection.ts) | `memoryReview` projection unit and `dueForReview` |
| [`src/restrict.ts`](src/restrict.ts) | Add-only `tools/pre-execute` policy and the child step cap |
| [`src/prompt.ts`](src/prompt.ts) | Review task, catalog label, and deny reasons |

### Export list

The plugin is a function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and no default export, so the Loader keeps its injection metadata ([postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)). Named exports `REVIEW_PROMPT`, `REVIEW_LABEL`, `REVIEW_DENY_OTHER_TOOL`, `REVIEW_DENY_OVERWRITE`, `dueForReview`, and `reviewWriteTarget` are the child task, the catalog label, the two deny reasons, the interval predicate, and the write-target parser.

### Trigger and restriction

When a review becomes due, `startReview` logs `ctx.logger.error` and skips it if `ctx.tools.get('memory_write')` is undefined or `'fork'` is absent from `ctx.subagents.list()`. Invalid `memory_write` arguments (a missing string `name` or a `scope` other than `global` or `project`) are denied with the overwrite reason. A downstream `tools/pre-execute` deny is returned unchanged.

### No invariant companion

No invariant companion is published because the package owns no session events and no durable data.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-tool-memory`](../tool-memory/README.md) — the tools, snapshot, and prompt section the review child uses.
- [memory group map](../README.md) — the sibling group page and its package table.
- [`dsh-subagent-fork-in-process`](../../subagent/subagent-fork-in-process/README.md) — the in-process fork provider that seeds the child with the parent's completed turns.
- [Hermes Agent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) — prior art for unattended memory review; the [Hermes Agent repository](https://github.com/NousResearch/hermes-agent) is licensed under MIT.

-----

<a id="model-experience"></a>
## Model Experience

### Review child task

#### What the model sees

The review child receives the inherited parent prefix, then this user-role task as its first new message. The parent model never sees this text.

##### Verbatim text for this field

```markdown
This is an unattended memory review of the conversation above. Save a fact only if it remains true in every future session: who the user is and how they like to work (type user), feedback or corrections on how to do the work (type feedback), a durable fact or constraint about the current project (type project), or a pointer to an external resource (type reference). Write declarative statements, not imperatives. Prefer project scope for project facts, global otherwise. You may only add new memories: memory_write with an existing name and memory_forget are denied. Call memory_recall before writing if the snapshot lists only an index line. Do not save task progress, transient state, secrets, or anything the repository already records. If nothing qualifies, reply with exactly: Nothing to save.
```

#### Token effect

One replay of the parent prefix at cached-token prices plus the review turn, every `reviewEveryUserTurns` user turns. When `reviewEveryUserTurns` is `0`, no child request runs.

#### KV Cache effect

Warm only when route, tools, and persona equal the parent's — this plugin passes none of `toolFilter`, `persona`, or `agentOptions`. The parent's prefix is never changed.

### Denied tool results

#### What the model sees

The child sees a denied `tool/result` for `memory_forget`, for `memory_write` of an existing name and scope, and for every tool other than `memory_write` and `memory_recall`. `memory_recall` is allowed.

##### Verbatim text for other tools

```markdown
Memory review may only call memory_write and memory_recall.
```

##### Verbatim text for forget or overwrite

```markdown
Unattended memory review may only add a new name.
```

#### Token effect

Each denied call adds one short error line on the child, retained until compaction.

#### KV Cache effect

Append-only on the child after the inherited prefix. The parent request is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when unattended review is a poor fit. They are current package constraints, not a task backlog.

- **First-step compaction** — the child's first step may compact when the parent is near its compaction threshold, so the inherited prefix is summarized and the warm cache read is lost.
- **Process-lifetime only** — reviews run only while the process lives, so the headless, ACP, and SDK bundles disable the plugin.
- **Ordinary Web row** — Web shows an ordinary subagent row labelled `memory-review`.
- **Parallel new-name writes** — two parallel `memory_write` calls with the same new name in one step can both pass the add-only check.
- **Parent-write race** — a parent `memory_write` that lands between the child's add-only check and the child's own `memory_write` of the same name can be overwritten by the child.
- **`memory_recall` and failed calls also reset the interval** — every parent `tool/call` named `memory_write`, `memory_recall`, or `memory_forget` resets `turnsSinceReset` to `0`, whether or not the call succeeds, so a parent that calls a memory tool every turn defers reviews indefinitely.
- **Routed digest reviews** — review on a cheaper routed model is deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked pages.

None.

</details>
