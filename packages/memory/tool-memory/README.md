---
description: "The model-facing memory tools over the durable memory store: memory_write, memory_recall, memory_forget, the memory catalog injected into each session, and the prompt section that says when to remember, for users and maintainers choosing, configuring, or debugging the tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

## Summary

`dsh-tool-memory` lets the agent remember across sessions. It gives the model three tools over [`dsh-memory`](../memory/README.md): `memory_write` saves or replaces one memory, `memory_recall` reads matching memories, and `memory_forget` deletes one. Once a session has saved memories to show, the model receives a catalog, one line per memory with its type, name, and description; a changed store sends a new catalog at the next turn, and compaction sends it again. A short prompt section says when to save and when not to. Two configuration values bound the catalog bytes and the recall count.

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
    injectMaxBytes: 4096
    maxRecallResults: 8
```

| Field | Default | Meaning |
|---|---|---|
| `injectMaxBytes` | required | UTF-8 byte budget of the injected catalog; `0` disables injection while the tools stay available |
| `maxRecallResults` | required | Most records one `memory_recall` call returns |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-memory) is the exhaustive source for the accepted fields.

### What each tool does

`memory_write` takes a name, a type, a scope, a one-line description, and the content, and saves the memory or replaces the one with the same name in the same scope; it answers `Saved global memory "<name>".` or `Updated project memory "<name>".` `memory_recall` takes an optional query, matches it as a case-insensitive substring of name, description, or content across the global memories and the current project's memories, and returns up to `maxRecallResults` of the newest matches rendered as headed blocks; with no match it answers `No saved memories match.` `memory_forget` takes a name and a scope and answers `Forgot <scope> memory "<name>".` A store rejection reaches the model as a tool error with the store's message, for example a project-scoped write from a session with no project root, an oversize content, or a scope that reached its cap. Every tool needs an owning agent session, because the session's working directory selects the project scope.

### The catalog

The catalog is a durable user-role message from this plugin. It lists global memories, then the current project's memories; within a section, entries sort by type (`user`, `feedback`, `project`, `reference`) then name. When the budget cuts entries, a final line says how many were omitted and points at `memory_recall`. The model sees it at the first step that has visible memories (the first step of a session whose store already holds some, otherwise the first step after one is saved), again at the first step of a later turn when the store's visible contents changed, and again at the next step after compaction shadowed the previous catalog. A store that was empty all along injects nothing; a store emptied after a catalog reached the model injects, at the next turn, a catalog whose only entry line is `No saved memories.`, so the model stops relying on forgotten entries.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tools and points at the code that realizes them; the observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

- **Catalog, not bodies.** The injected context is an index; bodies come through `memory_recall`, so the per-session cost is bounded by `injectMaxBytes` no matter how many memories exist.
- **Model-visible means logged.** The catalog is an ordinary `user/message` and every write is a `tool/call` with its `tool/result`, so replay reconstructs every model request from the session log without reading the store.
- **A projection decides when to inject.** The `memoryCatalog` projection folds this plugin's own catalog messages and `compaction/summary`; the pre-step listener compares the freshly rendered catalog against the projected last one, so the decision is a function of the log plus the store's current contents.
- **No new session events.** The store is cross-session state, not session state; the tool calls already record every mutation, so the package declares no `SessionEventMap` member. No invariant companion is published because the package owns no session events and no durable data of its own; the catalog projection folds existing event types only.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, prompt section, tool and catalog registration |
| [`src/tools.ts`](src/tools.ts) | The three `defineTool` definitions, their result rendering, and their generic call cards |
| [`src/catalog.ts`](src/catalog.ts) | Catalog rendering, the `memoryCatalog` projection unit, and the `agent/pre-step` listener |
| [`src/prompt.ts`](src/prompt.ts) | The static prompt section text |

### Export shape

The plugin is a function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and no default export, so the Loader keeps its injection metadata ([postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

### Injection mechanics

The listener is prepended on `agent/pre-step`, awaits the rest of the chain, and appends the catalog to an `enter` decision. It runs once per step, not per retry. While nothing has been injected yet it checks the store at every step, so the first write in a fresh session is followed by the catalog on the next step; once a catalog is on the surface, only a turn's first step re-checks. A `compaction/summary` resets the projected catalog to `null`, so the next step re-injects. The catalog message carries `source: { kind: 'tool-memory', form: 'snapshot', sections: [{ name: 'memory-catalog', text }] }`; the sections carry the text the projection folds. The `tool-memory` kind is attribution-only: a reader without this plugin keeps the message and its source fields.

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
You have durable memory that persists across sessions. When saved memories exist, a catalog of them (type, name, one-line description) is added to the conversation; the most recent catalog is current, and changes appear in a new catalog at the start of a later turn. Call memory_recall to read a memory's content before relying on it. Save a memory with memory_write when you learn something worth keeping beyond this session; do not save task progress, transient state, secrets, or anything the repository already records. Remove a memory that is wrong or no longer applies with memory_forget.
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

### Memory catalog

#### What the model sees

A user-role message listing the visible memories. `<type>` is one of `user`, `feedback`, `project`, `reference`; the `Project:` section appears only when the session has a project root with memories; the last line appears only when `injectMaxBytes` cut entries. When every memory the session had seen has been forgotten, the next turn's catalog is the same header followed by the single line `No saved memories.`.

##### Verbatim text for this field

```markdown
Saved memories (catalog; call memory_recall to read one):
Global:
- [<type>] <name> — <description>
Project:
- [<type>] <name> — <description>
… <omitted> more; use memory_recall
```

#### Token effect

Capped by `injectMaxBytes`; added at the first step with visible memories, at the first step of a turn whose visible memories changed, and at the next step after compaction. A store that was always empty adds nothing; one emptied after a catalog adds the two-line empty catalog once.

#### KV Cache effect

Append-only; a catalog lands after the reusable request prefix and does not invalidate existing entries.

### Tool-call history and result

#### What the model sees

Each call retains its arguments. `memory_write` returns `Saved <scope> memory "<name>".` or `Updated <scope> memory "<name>".`; `memory_forget` returns `Forgot <scope> memory "<name>".`; `memory_recall` returns `No saved memories match.` or one block per memory in the form below. Stable failures are `Error: <tool> requires an owning agent session`, the store's `MemoryError` messages (an invalid name, an empty or oversize description or content, a scope at its cap, `project scope is unavailable …; use scope "global"`, and `no <scope> memory named "<name>"`), and the registry's schema rejections.

##### Verbatim text for this field

```markdown
## <name> [<type>, <scope>]
<description>

<content>
```

#### Token effect

Write and forget results are one short line. A recall result grows with the returned memories, at most `maxRecallResults` bodies of at most the store's `maxRecordBytes` each, and stays until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tools are a poor fit. They are current package constraints, not a task backlog.

- **Per-step store check until the first catalog** — while a session has no catalog on its surface, every step renders the catalog from the store's in-memory records; the work is bounded by the store caps but is not free.
- **Bytes, not tokens** — `injectMaxBytes` counts UTF-8 bytes, so a catalog of multibyte descriptions holds fewer entries per token than the budget suggests.
- **No specialized Web card** — calls and results render through the generic tool rows; there is no memory panel and no command to list or edit memories from the UI.
- **No cross-process refresh** — the catalog refreshes from the process's own store view, so memories written by another process appear only after the store reopens.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: a memory panel

A Web panel that lists, edits, and deletes memories would read the store through a host controller rather than the session log. No design exists yet; the trigger is generic tool rows proving insufficient for curation.

</details>
