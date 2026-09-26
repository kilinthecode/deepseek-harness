---
description: "The model-facing memory tools over the durable memory store: memory_write, memory_recall, memory_forget, the memory snapshot injected at conversation start and after compaction, and the prompt section that says when to remember, for users and maintainers choosing, configuring, or debugging the tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

## Summary

`dsh-tool-memory` lets the agent remember across sessions. It gives the model three tools over [`dsh-memory`](../memory/README.md): `memory_write` saves or replaces one memory, `memory_recall` reads the live store, and `memory_forget` deletes one. When saved memories exist, one snapshot is added at conversation start and again after compaction: some entries with full content, the rest as a one-line index, capped by `injectMaxBytes`. Writes and forgets are confirmed in tool results and appear in the next snapshot. A short prompt section says when to save and when not to.

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

Mount it where a model should read and write durable memories: the shipped headless profile mounts it on the host plane, and the `standard`, `ptc`, and `cordis` agent presets mount it per session on Web. It needs `ctx.memory` from [`dsh-memory`](../memory/README.md) plus the tool, system-prompt, and session-projection registries.

### When to choose it

Choose it when an agent should carry user preferences, working-style feedback, project facts, and references from one session to the next and decide for itself what is worth keeping. Leave it out of compositions whose persona is the complete system prompt (the `minimal` preset), and of automation that never wants a model to write to the harness home. It coexists with a vendor memory MCP overlay: the tool names are distinct and the prompt section tells the model not to mirror facts.

### Minimal configuration

Both fields are required with no default; a composition that omits either fails at load.

```yaml
- name: '@deepseek-ai/dsh-tool-memory'
  config:
    injectMaxBytes: 8192
    maxRecallResults: 8
```

| Field | Default | Meaning |
|---|---|---|
| `injectMaxBytes` | required | UTF-8 byte budget of the injected snapshot; shipped compositions use `8192`; `0` disables injection while the tools stay available; a positive value below `SNAPSHOT_MIN_BYTES` fails load |
| `maxRecallResults` | required | Most records one `memory_recall` call returns |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-memory) is the exhaustive source for the accepted fields.

### What each tool does

`memory_write` takes a name, a type, a scope, a one-line description, and the content, and saves the memory or replaces the one with the same name in the same scope; it answers `Saved global memory "<name>".` or `Updated project memory "<name>".` `memory_recall` reads the live store, including memories saved after the snapshot: it takes an optional query, matches it as a case-insensitive substring of name, description, or content across the global memories and the current project's memories, and returns up to `maxRecallResults` of the newest matches; each match is rendered as a headed block, or as the blocked form when description or content fails `scan` (the file is not renamed `.bak`); with no match it answers `No saved memories match.` `memory_forget` takes a name and a scope and answers `Forgot <scope> memory "<name>".` A store rejection reaches the model as a tool error with the store's message, for example a project-scoped write from a session with no project root, an oversize content, a blocked description or content, or a scope that reached its cap. Every tool needs an owning agent session, because the session's working directory selects the project scope.

### The snapshot

The snapshot is a durable user-role message from this plugin. It is taken at the first step of a conversation and again after compaction, whether or not anything was injected, and is appended after the user's message and the runtime context. Visible records flatten and sort by type (`user`, `feedback`, `project`, `reference`), then name, then global before project; there are no `Global:` / `Project:` headers. For each record, if `scan` fails on description or content the snapshot emits `- [<type>, <scope>] <name> — [blocked]` and never inlines the body; otherwise it emits the recall block when that block's UTF-8 bytes fit the remaining budget, else the index line `- [<type>, <scope>] <name> — <description>` when that fits, else it omits the record. A record larger than the remaining budget is index-only, never truncated. When any record is omitted, `… N more; use memory_recall` is appended and trailing index lines are dropped until the complete text is within `injectMaxBytes`. A store that is empty at the first step injects nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tools and points at the code that realizes them; the observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

- **Snapshot with a greedy byte budget.** The injected context inlines a recall block when it fits remaining `injectMaxBytes`, otherwise an index line, otherwise omits the record, then drops trailing index lines until the complete text is within budget. The snapshot is taken once per surface generation and is not refreshed on later turns.
- **Model-visible means logged.** The snapshot is an ordinary `user/message` and every write is a `tool/call` with its `tool/result`, so replay reconstructs every model request from the session log without reading the store.
- **A projection records that the opportunity was taken, only once a message survives.** The `memoryCatalog` projection is `stateVersion: 3` with `{ taken: boolean; stepPending: boolean }`. `step/start` marks the step pending, not yet taken, because cancellation during `agent/request`/`prepareCall` commits neither the system prompt nor the step's messages; a committed `user/message` while pending, or this plugin's own snapshot message unconditionally, marks it taken, and `step/end` clears pending. `compaction/summary` clears both. After the first step of a surface generation the listener does not read the store.
- **No new session events.** The store is cross-session state, not session state; the tool calls already record every mutation, so the package declares no `SessionEventMap` member. No invariant companion is published because the package owns no session events and no durable data of its own; the snapshot projection folds existing event types only.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, prompt section, tool and snapshot registration |
| [`src/tools.ts`](src/tools.ts) | The three `defineTool` definitions, their result rendering, and their generic call cards |
| [`src/catalog.ts`](src/catalog.ts) | Snapshot rendering (`renderSnapshot`), `SNAPSHOT_HEADER`, `SNAPSHOT_MIN_BYTES`, the `memoryCatalog` projection unit, and the `agent/pre-step` listener |
| [`src/prompt.ts`](src/prompt.ts) | The static prompt section text |

### Export list

The plugin is a function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and no default export, so the Loader keeps its injection metadata ([postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)). Named exports `SNAPSHOT_HEADER`, `SNAPSHOT_MIN_BYTES`, and `renderSnapshot` are the snapshot first line, the smallest positive `injectMaxBytes` (UTF-8 bytes of that header plus the omission line with a seven-digit count), and the budgeted renderer.

### Injection mechanics

The listener is prepended on `agent/pre-step`, awaits the rest of the chain first (so a `compaction/summary` in that chain can fold `taken` back to `false` in the same step), and appends the snapshot to an `enter` decision. It runs once per step, not per retry. If `state.taken` is true or `injectMaxBytes` is `0`, it returns the decision unchanged and does not read the store. Otherwise it renders `visible(cwd)` with `renderSnapshot` and appends a user-role message after the claimed user batch and runtime context. The `memoryCatalog` projection is `stateVersion: 3` with `{ taken: boolean; stepPending: boolean }` and `init: () => ({ taken: false, stepPending: false })`. `step/start` logs before `agent/request`/`prepareCall` resolve the route, and cancellation during that async phase commits neither the system prompt nor the step's messages, so it folds to `stepPending: true` only, never `taken` directly. A committed `user/message` while pending folds to `{ taken: true, stepPending: false }`; this plugin's own `user/message` with `source.kind === 'tool-memory'` and `form === 'snapshot'` folds to the same state unconditionally, regardless of `stepPending` (a fork child's seed may carry the parent's snapshot without the parent's `step/start` rows); `step/end` folds pending back to `false`; `compaction/summary` folds both `taken` and `stepPending` to `false`. The snapshot message carries `source: { kind: 'tool-memory', form: 'snapshot', sections: [{ name: 'memory-catalog', text }] }`. The `tool-memory` kind is attribution-only: a reader without this plugin keeps the message and its source fields.

### Presentation

Each tool presents its call as a generic card (`Save memory`, `Recall memories`, `Forget memory`) with the arguments as raw input; the Web Client renders the logged call and result rows without a specialized card.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Memory subsystem](../../../docs/subsystems/memory.md) — the store's request and result types and the generated service API.
- [memory group map](../README.md) — the sibling group page and its package table.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory) — the three tool schemas the model receives.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-memory) — every accepted config field and its source declaration.
- [First-party durable memory Agent Note](../../../.agents/notes/implemented/feature/2026-09-19-first-party-durable-memory.md) — the design decisions and the alternatives they beat.
- [Third-party memory MCP guide](../../../docs/user/guide/mcp-memory.md) — the default-off vendor overlays these tools coexist with.

-----

<a id="model-experience"></a>
## Model Experience

### Prompt section

#### What the model sees

One static section at the `TOOL_MEMORY` position of the system prompt.

##### Verbatim text for this field

```markdown
You have durable memory that persists across sessions. When saved memories exist, one snapshot of them is added to the conversation when it starts: some entries with their full content, the rest as a one-line index. The snapshot is not refreshed during the conversation; after context compaction a new snapshot is added. Memories you write or forget now are confirmed in the tool results and appear in the next snapshot. Call memory_recall to read an entry the snapshot lists only as an index line, or to find memories saved after the snapshot. Save a memory with memory_write when you learn a fact that stays true in every session. Write declarative statements, not imperatives: "The user prefers concise answers", not "Always answer concisely". Do not save task progress, transient state, secrets, or anything the repository already records. Remove a memory that is wrong or no longer applies with memory_forget.
```

#### Token effect

Fixed cost on every request where the plugin is mounted.

#### KV Cache effect

Prefix-stable while the plugin stays mounted; mounting or unmounting it changes the system prompt and invalidates the prefix.

### Tool schemas

#### What the model sees

The generated [`memory_write`, `memory_recall`, and `memory_forget` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory): `memory_write` requires `name`, `type`, `scope`, `description`, and `content` with `type` and `scope` as enums; `memory_recall` takes an optional `query`; `memory_forget` requires `name` and `scope`.

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged.

### Memory snapshot

#### What the model sees

A user-role message listing the visible memories, appended after the claimed user message and runtime context. `<type>` is one of `user`, `feedback`, `project`, `reference`; `<scope>` is `global` or `project`. Content blocks use the recall grammar; index lines and blocked index lines use the forms below. Content blocks are separated from each other and from the index-line group by one blank line; consecutive index lines are adjacent; the omission line follows the last entry with no extra blank line. The omission line appears only when at least one record was dropped. An empty store at the first step adds nothing.

##### Verbatim text for this field

```markdown
Saved memories (snapshot):
## <name> [<type>, <scope>]
<description>

<content>

- [<type>, <scope>] <name> — <description>
- [<type>, <scope>] <name> — [blocked]
… N more; use memory_recall
```

#### Token effect

One snapshot per surface generation, at most `injectMaxBytes` UTF-8 bytes. An empty store at the first step adds nothing until compaction.

#### KV Cache effect

Append-only after the reusable request prefix; never refreshed within a surface generation. Re-added only at the compaction series break. A fork child inherits the snapshot in its seed and does not add another.

### Tool-call history and result

#### What the model sees

Each call retains its arguments. `memory_write` returns `Saved <scope> memory "<name>".` or `Updated <scope> memory "<name>".`; `memory_forget` returns `Forgot <scope> memory "<name>".`; `memory_recall` returns `No saved memories match.` or one block per memory in the success form below; when description or content fails `scan`, that block is the blocked form instead. Stable failures are `Error: <tool> requires an owning agent session`, the store's `MemoryError` messages (an invalid name, an empty or oversize description or content, a blocked description or content, a scope at its cap, `project scope is unavailable …; use scope "global"`, and `no <scope> memory named "<name>"`), and the registry's schema rejections.

##### Verbatim text for this field

```markdown
## <name> [<type>, <scope>]
<description>

<content>
```

##### Verbatim text for blocked recall

```markdown
## <name> [<type>, <scope>]
[blocked]
```

#### Token effect

Write and forget results are one short line. A recall result grows with the returned memories, at most `maxRecallResults` bodies of at most the store's `maxRecordBytes` each, and stays until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tools are a poor fit. They are current package constraints, not a task backlog.

- **Empty store at first step** — a conversation whose store was empty at its first step gets no snapshot until compaction, even after it writes; the tool results confirm those writes.
- **Sibling sessions in one Web host** — sibling conversations share the store but each takes its own snapshot; a write in one conversation appears in a sibling's snapshot after that sibling's next compaction or in a new conversation.
- **Bytes, not tokens** — `injectMaxBytes` counts UTF-8 bytes, so a snapshot of multibyte descriptions holds fewer entries per token than the budget suggests.
- **No specialized Web card** — calls and results render through the generic tool rows; there is no memory panel and no command to list or edit memories from the UI.
- **No cross-process refresh** — recall and the next snapshot read this process's store view, so memories written by another process appear only after the store reopens.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: a memory panel

A Web panel that lists, edits, and deletes memories would read the store through a host controller rather than the session log. No design exists yet; the trigger is generic tool rows proving insufficient for curation.

</details>
