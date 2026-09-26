---
description: "The durable agent memory store (ctx.memory): global and per-project records as JSON documents over the storage domain form, with write, recall, forget, and visibility by working directory, for users and maintainers choosing, configuring, or debugging the store."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

## Summary

`dsh-memory` keeps an agent's memories across sessions. Each memory is one small record with a name, a type (`user`, `feedback`, `project`, or `reference`), a scope (`global` or `project`), a one-line description, and its content, stored as one readable JSON file under the harness home. The store validates every write, scans description and content for injection and secrets, caps how many memories each scope may hold, and resolves the current project from the session's working directory. Mount it wherever agents should remember things; `dsh-tool-memory` gives the model the tools and the catalog.

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

Use this package when a composition wants durable, cross-session memory without a vendor service: mount it once on the host plane over the storage stack (`dsh-storage`, a backend such as `dsh-storage-json`, and `dsh-storage-domain`), then mount [`dsh-tool-memory`](../tool-memory/README.md) wherever a model should read and write memories.

### When to choose it

Choose it for facts an agent should carry from one session to the next: preferences, working-style feedback, project constraints, and links. Avoid it for in-session working state (the session log and compaction own that) and for large documents (content is capped per record). If you want a vendor memory system with its own search, use one of the default-off [memory MCP overlays](../../../docs/user/guide/mcp-memory.md) instead; both can be mounted at once.

### Minimal configuration

Both caps are required with no default: a composition that omits either fails at load, as does a non-positive value.

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- name: '@deepseek-ai/dsh-memory'
  config:
    maxRecords: 200
    maxRecordBytes: 4096
```

| Field | Default | Meaning |
|---|---|---|
| `maxRecords` | required | Most records in the global scope and, separately, in each project; a write past the cap fails |
| `maxRecordBytes` | required | UTF-8 byte cap on one record's content |
| `projectRootMarkers` | `['.git']` | Directory entries that identify a project root while walking up from the session working directory; an explicit empty list stays empty |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-memory) is the exhaustive source for the accepted fields. Route the `memory` domain to another backend with `dsh-storage-domain`'s `routes` (for example `memory: sqlite`); the store has no backend field of its own.

### Where memories live

With the JSON backend, every memory is one file: `<root>/memory/global/<name>.json` for global records and `<root>/memory/project/<slug>__<name>.json` for project records, where `<slug>` is the project directory's sanitized basename plus eight hex characters of the root path's hash. Each file holds `{ "version": 1, "record": { … } }` and is safe to read or edit by hand. When the store opens, a file that no longer parses or breaks a field bound is moved aside as `<name>.json.bak.<timestamp>`, and the other memories stay available. The bounds cover every field: the name pattern, the 256-character description, content within the current `maxRecordBytes` (so lowering the cap moves larger records aside), a project root of at most 32,767 characters, and ISO-8601 UTC timestamps. A write requires the description to be a single line; a hand-edited file that contains a line break still loads and is not quarantined.

### Scopes and the project root

A `global` memory is visible in every session under the same harness home. A `project` memory is visible only in sessions whose working directory lies inside the same project root, found by walking upward from the session's `cwd` to the first directory that contains one of `projectRootMarkers`. When a session has no working directory or no marker above it, project-scoped writes and forgets fail with `project-root-unavailable`, while `recall` and `visible` return global records only. The store never guesses a root.

### What each operation does

`write` validates the name (lowercase kebab-case, 1 to 64 characters), trims the description to a single line of 1 to 256 characters (U+000A, U+000D, U+2028, and U+2029 fail with `invalid-description` and `description must be a single line of 1 to 256 characters after trimming`), trims the content (at most `maxRecordBytes`), scans description then content and rejects a finding as `blocked-content`, enforces the scope's cap over the records this process has loaded or written (`over-cap` names the scope as `global` or `project` only: `the project scope already holds <count> memories (cap <max>); forget one before writing`), and inserts or replaces the record durably before returning whether it was `created` or `updated`. A project write whose key already holds a record with a different `projectRoot` fails with `project-key-collision` and `cannot write project memory "<name>": another project's record already occupies this key`, and leaves that record unchanged. `recall` matches a case-insensitive substring against name, description, and content across the visible records and returns the newest first, then by name, then global before project, capped by the caller's limit. `forget` deletes one record and fails with `not-found` when there is none; a project forget of a key occupied by another project's record fails with `project-key-collision` and `cannot forget project memory "<name>": another project's record occupies this key`, and leaves that record unchanged. `visible` returns every global record plus the current project's records. `scan` returns the same finding as `scanMemoryText`. Every rejection is a `MemoryError` with a stable `code` and a message written for the model.

### Write-time scan

Before a record is serialized, `write` runs `scan` on the trimmed description and then on the trimmed content. The checks are fixed in code, not a Config field. Raw text first: C0 controls other than tab and newline, every C1 control, and the invisible or bidirectional set U+200B, U+200C, U+200D, U+2060, U+2062–U+2064, U+FEFF, U+202A–U+202E, U+2066–U+2069 fail with `blocked-content` and `Blocked: content contains invisible unicode character U+XXXX (possible injection).` (uppercase hex, at least four digits). A copy is then NFKC-normalized (stored bytes stay unchanged), truncated to 65,536 UTF-16 code units, and tested against threat patterns adapted from [Hermes Agent `tools/threat_patterns.py`](https://github.com/NousResearch/hermes-agent/blob/4c286ae7a0dcb86e70a7ad8c23c0f05c89e33ec3/tools/threat_patterns.py) (classic injection, role hijack, system-prompt leak, exfiltration, persistence, hardcoded secrets; not C2/promptware or Hermes-specific groups); a match fails with `Blocked: content matches threat pattern <id>.` `MemoryStore.scan` is that same check for catalog and recall consumers. The durable zod schema does not reject line breaks in `description`, so a hand-edited multi-line file still loads.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the store and points at the code that realizes them; the observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

- **No new durability code.** The store is a consumer of `dsh-storage-domain`: atomic per-record publication, schema validation at open, and quarantine of malformed records are inherited, not reimplemented.
- **Human-editable records.** One pretty-printed JSON document per memory keeps the store inspectable with any editor and diffable by hand.
- **Explicit scope, never a guessed root.** Project identity comes only from the session working directory and the configured markers; a missing root is a loud error, not a silent fallback to global.
- **Timestamps stay in the store.** `createdAt` and `updatedAt` order recall results and never reach the model, so recorded sessions replay byte-for-byte.
- **Write-time scan is a security invariant.** Invisible unicode and threat-pattern checks live in `src/scan.ts`, not Config, so a composition cannot turn them off.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `MemoryStore` service (`ctx.memory`), `Config`, request and result types, `MemoryError` |
| [`src/domain.ts`](src/domain.ts) | The per-store builders of the zod record schema and the `memory` domain spec, and the branded name and key types |
| [`src/project.ts`](src/project.ts) | Project-root discovery and the path-safe project key |
| [`src/scan.ts`](src/scan.ts) | Invisible-unicode and threat-pattern scan (`scanMemoryText`, `MemoryStore.scan`) |

### Lifecycle

The service opens the `memory` domain during its init, so a consumer that injects `memory` always sees an open store, and closes the domain with its own fiber. A domain opens once per process; on the Web profile that is why the store sits on the host plane while the tools compose per agent preset.

### Concurrency

Distinct records are distinct files, so two processes writing different memories never collide. Two processes writing the same record resolve by last complete publication, never a torn file. Inside one process, every `write` and `forget` of the store runs, in call order, in one serialized section that holds the project-root lookup, the existence check, the cap check, and the durable put or delete, so overlapping calls from parallel tool calls or several agents never exceed `maxRecords`, a same-name overlap reports `created` for the earlier call and keeps its `createdAt`, and two overlapping forgets of one record report `not-found` for the second. A process loads the store once at open; memories written by another process become visible, and count toward the cap, only when the domain reopens, so two processes writing new names at once can together exceed `maxRecords`.

### No invariant companion

No invariant companion is published because the durable data is validated by the domain schema at open and by the store on every write, and the package owns no session events, so no independent observations can diverge.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Memory subsystem](../../../docs/subsystems/memory.md) — request and result types, the record layout, and the generated service API.
- [memory group map](../README.md) — the sibling group page and its package table.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-memory) — every accepted config field and its source declaration.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain form and backends the store builds on.
- [First-party durable memory Agent Note](../../../.agents/notes/implemented/feature/2026-09-19-first-party-durable-memory.md) — the design decisions and the alternatives they beat.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-memory`, which turns stored records into the injected catalog, the tool schemas, and the recall results the model reads.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the store is a poor fit. They are current package constraints, not a task backlog.

- **Cross-process writes appear on reopen** — a process reads the store once when the domain opens, so memories written by another process (a headless run beside a long-lived Web host) become visible, and count toward `maxRecords`, only after the domain reopens; the same record written from two processes resolves by last complete publication.
- **Substring recall only** — `recall` is a case-insensitive substring match; there is no ranking, no synonym handling, and no semantic search.
- **No in-repository store** — project memories live under the harness home keyed by the project root, so they are not committed with the repository or shared through git.
- **Project identity is the absolute root path** — a project record stores its root and is keyed by a slug derived from it, so moving or renaming the repository directory orphans its project memories; sessions inside the new path see none of them until they are written again.
- **Content caps are bytes** — `maxRecordBytes` counts UTF-8 bytes, so scripts with multibyte characters fit fewer characters than ASCII.
- **Scan false positives** — a legitimate sentence that looks like injection, exfiltration, or a quoted 20-character secret is rejected at write; the pattern set is fixed in code, so changing it is a source change, not a Config edit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: git-shared project memories

A `<project>/.dsh/memory/` store that teams commit would need a storage-domain root outside the harness home and a second domain. No design exists yet; the trigger is a team that must share facts through the repository.

</details>
