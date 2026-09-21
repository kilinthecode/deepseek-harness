# Agent Note: First-party durable memory

Status: implemented

English | [中文](2026-09-19-first-party-durable-memory.zh.md)

## Problem

An agent forgot everything between sessions. Preferences the user stated, feedback they gave on how to work, durable facts about a project, and links to external resources had to be restated every time or written into workspace instruction files by hand. The only memory path was a default-off MCP overlay for a third-party server, which the [third-party memory MCP examples note](../../archived/feature/2026-07-31-third-party-memory-mcp-examples.md) deliberately kept outside the product: no vendor adapter, no memory service, no installation surface. That decision left a gap for a memory that needs no vendor, no embedding model, and no background process, and that is durable enough to survive crashes, two concurrent processes, and hand edits.

## Decision

Two packages in a new `packages/memory/` group provide first-party memory.

`@deepseek-ai/dsh-memory` is a Service Definition and Provider on `ctx.memory`: one `memory` domain on the existing storage domain form, per-record layout, with a `global` table keyed by memory name and a `project` table keyed by `<project slug>__<name>`. A record carries `name`, `type` (`user`, `feedback`, `project`, `reference`), `scope` (`global`, `project`), a one-line `description` of at most 256 characters, `content` capped by `maxRecordBytes`, `projectRoot` for project records, and ISO timestamps that never reach the model. Records are validated by zod at open with `backup-and-skip`, so a hand edit that breaks one file moves that file aside and keeps the rest. The store enforces `maxRecords` per global scope and per project, resolves the project root by walking up from the session working directory to a `projectRootMarkers` entry, and fails project-scoped operations loudly when no root resolves.

`@deepseek-ai/dsh-tool-memory` is the Consumer: `memory_write`, `memory_recall`, and `memory_forget` on `ctx.tools`, a static prompt section at the `TOOL_MEMORY` position that says when to remember, and a catalog of the visible memories injected as a `user/message` with `source.form: 'snapshot'`. The `memoryCatalog` session projection folds the plugin's own catalog messages and resets on `compaction/summary`; the prepended `agent/pre-step` listener injects at any step while the projection is empty, at a turn's first step when the rendered catalog differs from the projected one, and after compaction; when a turn's first step finds the store empty after a catalog reached the model, it injects a catalog whose only entry line is `No saved memories.` so forgotten entries stop being relied on. Bodies reach the model only through `memory_recall`, bounded by `maxRecallResults` and the store's byte cap. The catalog is bounded by `injectMaxBytes`; `0` disables injection.

No session event is added. Every model-visible input is an existing event type: the catalog is a `user/message`, and every mutation is a `tool/call` with its `tool/result`. The package therefore publishes no invariant companion and records no persistence-type change.

The base bundle mounts the store on the host plane and the tools beside `tool-todo`; the Web bundle disables the tools on the host plane and the `standard`, `ptc`, and `cordis` presets mount them per session, because a domain opens once per process while presets mount tools per agent.

## Storage layout

With the JSON backend, a global memory is `<storages>/memory/global/<name>.json` and a project memory is `<storages>/memory/project/<slug>__<name>.json`, where the slug is the project directory's sanitized basename plus eight hex characters of the root's SHA-1. Each file holds `{ "version": 1, "record": … }`. Distinct records are distinct files; the same record written from two processes resolves by last complete atomic publication, inheriting the JSON backend's contract. SQLite is one `routes: { memory: sqlite }` line on the domain plugin.

## Alternatives considered

**Markdown files with front matter and an index file.** Human-friendly and git-friendly, but every durability property the storage domain already provides — atomic publication, schema validation, quarantine of malformed records, backend routing — would have to be hand-rolled, and the index file would become a second write path with its own concurrency story. Per-record JSON keeps files readable and editable and deletes that code. Deferred until hand-editing JSON proves a real blocker.

**One package holding store, tools, and injection.** Smaller on paper, but the Web profile mounts tools per agent preset and a storage domain opens once per process, so one package would either open the domain per preset (rejected by the domain facility) or force the tools onto the host plane for every preset including `minimal`. The goal/tool-goal split is the repository's template for exactly this shape.

**`memory/write` and `memory/forget` session events with an invariant companion.** The crew's merged plan proposed them for UI rendering and replay. They are unnecessary for reconstructability: the tool call and result already record each mutation, and the store is cross-session state rather than session state. Dropping them removed the invariant companion, the persistence-change record, and the catalog regeneration. A future memory panel reads the store through a host controller.

**Re-inject the catalog after every write, gated by a generation counter.** Re-sending the whole catalog after a write the model just made costs tokens for no information. Comparing the rendered catalog against the projected last one at a turn's first step covers this process's writes from any session, hand edits, and compaction with one nullable string of projection state.

**Per-type catalog caps.** A second knob to keep one type from starving the others. Ordering entries by type rank (`user`, `feedback`, `project`, `reference`) then name gives the same protection under a single byte budget.

**A `MessageSourceMap` member for memory.** The existing `plugin` source with `form: 'snapshot'` and named sections already carries the text and the supersession semantics; a new source kind would widen the union for no consumer.

**Semantic search or an LLM in the recall path.** Rejected for v1: it would break keyless replay determinism and add a model dependency to a read. Substring matching over name, description, and content ships first; the trigger for more is measured recall misses.

**An in-repository `<project>/.dsh/memory/` store.** Would let teams commit facts, but needs a storage root outside the harness home and a second domain. Deferred until a team must share memories through git.

## Consequences

Agents keep user preferences, feedback, project facts, and references across sessions and profiles under one harness home, with bounded per-session cost and no vendor, embedding, or daemon. Memories are plain JSON files a person can read, edit, or delete. Every injection and mutation replays from the session log.

The cost is that a process sees other processes' writes only when the domain reopens, recall is substring-only, the catalog budget counts bytes rather than tokens, and there is no UI for curation beyond the generic tool rows. Compositions that mount a vendor memory overlay alongside these tools rely on distinct tool names and the prompt section's instruction not to mirror facts.

## Testing

Unit suites cover the domain schema, project-root discovery, the store over the real JSON backend (caps, isolation, reopen, quarantine, two stores over one root), the tools through the real tool registry, catalog rendering and the injection gate through the real pre-step waterfall, and a real Loader composition for each package. An agent-loop integration suite drives the real tools with a scripted model and asserts the catalog's position in the log and in the model request. A keyless headless process test writes in one run and recalls in a second run over the same harness home. A keyless two-process test has two Node children publish distinct and shared records into one root at once and asserts that every file is one complete publication with nothing quarantined. A key-gated suite lets a real model write a memory in one session and, in a fresh session over the same store, receive the catalog before its first request, call `memory_recall`, and answer from it. Two keyless recorded scenarios run the shipped headless profile: `memory-catalog-recall` seeds a global record and has the model recall then write, and `memory-project-forget` has the model write a project memory through a committed `.dsh-project` root marker, receive the catalog's `Project:` section, and forget it. The recorded corpus under `snapshots/` quotes the prompt section and tool schemas in every shipped profile, so a change to that text is followed by one keyless refresh.
