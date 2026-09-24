---
description: "The memory group map: the durable cross-session memory store and its model-facing tools and catalog, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/memory

English | [中文](README.zh.md)

## Summary

The memory group lets an agent keep facts across sessions: who the user is and how they like to work, feedback on how to do the work, durable facts about a project, and pointers to external resources. One package owns the store, one JSON document per memory under the harness home; the other gives the model three tools and a catalog of saved memories at the start of every session. Nothing here talks to a vendor memory service, needs an embedding model, or runs in the background.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`memory`](memory/README.md) | Durable global and per-project memory records over the storage domain form: write, recall, forget, and the records visible from a working directory | `ctx.memory` |
| [`tool-memory`](tool-memory/README.md) | Model tools `memory_write`, `memory_recall`, `memory_forget`, the injected memory catalog, and the prompt section that says when to remember | registers on `ctx.tools` |

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
