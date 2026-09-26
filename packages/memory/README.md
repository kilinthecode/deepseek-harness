---
description: "The memory group map: the durable cross-session memory store, its model-facing tools and catalog, and a cache-parity background review, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/memory

English | [中文](README.zh.md)

## Summary

The memory group lets an agent keep facts across sessions: who the user is and how they like to work, feedback on how to do the work, durable facts about a project, and pointers to external resources. One package owns the store, one JSON document per memory under the harness home; one gives the model three tools and a snapshot of saved memories at conversation start and after compaction; the third starts a cache-parity background review on the base/TUI profile and Web `standard`, `cordis`, and `ptc` presets. Nothing here talks to a vendor memory service or needs an embedding model.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The store and tools are joined by an unattended cache-parity review, enabled on the base/TUI composition and the Web `standard`, `cordis`, and `ptc` presets.

| Package | Role | ctx key |
|---|---|---|
| [`memory`](memory/README.md) | Durable global and per-project memory records over the storage domain form: write, recall, forget, and the records visible from a working directory | `ctx.memory` |
| [`tool-memory`](tool-memory/README.md) | Model tools `memory_write`, `memory_recall`, `memory_forget`, the injected memory catalog, and the prompt section that says when to remember | registers on `ctx.tools` |
| [`memory-review`](memory-review/README.md) | Unattended cache-parity fork that may only add new memories; starts when the parent is idle after enough user-kind turns | registers on `ctx.sessionProjections` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Memory subsystem](../../docs/subsystems/memory.md) — the store's request and result types, the record layout on disk, and the generated service API.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-memory) — the three tool schemas the model receives.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-memory) — every accepted config field of the store and of the tools.
- [First-party durable memory Agent Note](../../.agents/notes/implemented/feature/2026-09-19-first-party-durable-memory.md) — the design decisions and the alternatives they beat.
- [Third-party memory MCP guide](../../docs/user/guide/mcp-memory.md) — the default-off vendor memory overlays this group coexists with.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
