# Remember across sessions

English | [中文](memory.zh.md)

DeepSeek Harness keeps durable memories for the agent: who you are and how you like to work, feedback you gave on how to do the work, durable facts about a project, and pointers to external resources such as a ticket or a dashboard. A memory written in one session is available in every later session under the same harness home, with no vendor service, embedding model, or background process. The shipped `headless` profile and the `standard`, `ptc`, and `cordis` Web agent presets include it; the `minimal` preset does not.

## How the agent uses memory

When the agent can see saved memories, the model receives a catalog of them: one line per memory with its type, name, and one-line description. A session that starts with saved memories gets the catalog before its first model request; one that starts with none gets it right after the first memory is saved. When the saved memories change after that, a new catalog arrives at the start of the next turn, and the catalog is sent again after context compaction. The model reads a memory's full content with `memory_recall`, saves or replaces one with `memory_write`, and deletes one with `memory_forget`.

You can drive it directly:

> Remember that I prefer pnpm over npm.

> What do you remember about me?

> Forget the memory named prefers-pnpm.

The model decides on its own what is worth keeping. Its instructions tell it to save preferences, feedback, project facts, and references, and never task progress, transient state, secrets, or anything the repository already records.

## Types and scopes

Each memory has one of four types: `user` (who you are and your preferences), `feedback` (how to do the work, corrections), `project` (facts and constraints of a project), or `reference` (a pointer to an external resource).

Each memory also has a scope. A `global` memory is visible in every session under the same harness home. A `project` memory is visible only in sessions whose working directory lies inside the same project, found by walking up from the working directory to the first directory that contains a `.git` entry. A session outside any project can read and write global memories only.

## Inspect, edit, or delete memories

Every memory is one readable JSON file under the harness home (`~/.dsh`, or the directory `DSH_HOME` names):

```text
~/.dsh/storages/memory/global/<name>.json
~/.dsh/storages/memory/project/<slug>__<name>.json
```

The project `<slug>` is the project directory's name followed by eight hex characters derived from its full path. Edit a file with any editor or delete it to forget the memory. A file that no longer parses is moved aside as `<name>.json.bak.<timestamp>` when the store opens, and the other memories stay available. The [store package README](../../../packages/memory/memory/README.md) documents the record fields.

## Configure or turn it off

The store and the tools are two composition rows, `memory` and `tool-memory`, whose values the shipped [base bundle](../../../packages/bundle/base/cordis.patch.yml) sets. The store caps the number of memories per scope (`maxRecords`) and the bytes of one memory (`maxRecordBytes`); the tools cap the catalog bytes (`injectMaxBytes`) and the number of memories one recall returns (`maxRecallResults`). The generated [configuration catalog](../../config-catalog.md#deepseek-aidsh-memory) lists every field.

Override them in a user patch layer, `$DSH_HOME/profiles/<name>/cordis.patch.yml` for one profile or `$DSH_HOME/cordis.patch.yml` for every profile. A patch replaces the row's whole `config`, so state every required field. This keeps the tools but stops the catalog:

```yaml
- id: tool-memory
  config:
    injectMaxBytes: 0
    maxRecallResults: 8
```

This removes the tools and the catalog from the headless profile while leaving stored memories untouched:

```yaml
- id: tool-memory
  disabled: true
```

On Web, the tools belong to the agent preset; pick the `minimal` preset for a session without them.

## Limitations

- Moving or renaming a project directory orphans its project memories, because a project memory is keyed by the full path of its root; write them again from the new location.
- A long-running `dsh web` host reads the store when it starts, so hand edits and memories written by another process, such as a headless run beside it, appear only after a restart.
- Recall matches one case-insensitive phrase against a memory's name, description, and content; there is no ranking or semantic search.
- Calls to the memory tools appear as generic tool rows in the Web UI; there is no memory panel yet.

Third-party memory servers connected through MCP are a separate, default-off path described in [Connect a third-party memory MCP server](mcp-memory.md); both can be active at once.
