# Remember across sessions

English | [中文](memory.zh.md)

DeepSeek Harness keeps durable memories for the agent: who you are and how you like to work, feedback you gave on how to do the work, durable facts about a project, and pointers to external resources such as a ticket or a dashboard. A memory written in one session is available in every later session under the same harness home, with no vendor service, embedding model, or background process. The shipped TUI (the base bundle), the `headless` profile, and the `standard`, `ptc`, and `cordis` Web agent presets include the store and tools; the `minimal` preset does not.

## How the agent uses memory

When saved memories exist, the model receives one snapshot of them: some entries with their full content, the rest as a one-line index, capped by `injectMaxBytes` (8192 bytes in shipped compositions). The snapshot is added when the conversation starts and again after context compaction. It is not refreshed when the model writes or forgets during the conversation; those changes are confirmed in the tool results and appear in the next snapshot. A conversation that starts with no saved memories gets no snapshot until compaction.

You can drive it directly:

> Remember that I prefer pnpm over npm.

> What do you remember about me?

> Forget the memory named prefers-pnpm.

The model reads a memory the snapshot listed only as an index line, or a memory saved after the snapshot, with `memory_recall`. It saves or replaces one with `memory_write`, and deletes one with `memory_forget`.

The model decides on its own what is worth keeping. Its instructions tell it to save preferences, feedback, project facts, and references, and never task progress, transient state, secrets, or anything the repository already records.

On the TUI and on the Web `standard`, `cordis`, and `ptc` presets, an unattended review fork runs after every 10 user messages (goal-round messages do not count). The parent conversation does not see the review; the child may only add a name that does not exist yet in that scope. The `headless`, ACP, and SDK profiles do not run this review. On Web, the review appears as an ordinary subagent row labelled `memory-review`.

## Types and scopes

Each memory has one of four types: `user` (who you are and your preferences), `feedback` (how to do the work, corrections), `project` (facts and constraints of a project), or `reference` (a pointer to an external resource).

Each memory also has a scope. A `global` memory is visible in every session under the same harness home. A `project` memory is visible only in sessions whose working directory lies inside the same project, found by walking up from the working directory to the first directory that contains a `.git` entry. A session outside any project can read and write global memories only.

## Inspect, edit, or delete memories

Every memory is one readable JSON file under the harness home (`~/.dsh`, or the directory `DSH_HOME` names):

```text
~/.dsh/storages/memory/global/<name>.json
~/.dsh/storages/memory/project/<slug>__<name>.json
```

The project `<slug>` is the project directory's name followed by eight hex characters derived from its full path. Edit a file with any editor or delete it to forget the memory. A file that no longer parses is moved aside as `<name>.json.bak.<timestamp>` when the store opens, and the other memories stay available. A write that contains hidden unicode, looks like prompt injection, or assigns a quoted secret of 20 or more characters is rejected. A stored file that fails that scan is not renamed `.bak`; the snapshot and recall show it as `[blocked]` instead of inlining the body. The [store package README](../../../packages/memory/memory/README.md) documents the record fields.

## Configure or turn it off

The store, the tools, and the review are composition rows `memory`, `tool-memory`, and `memory-review`, whose values the shipped [base bundle](../../../packages/bundle/base/cordis.patch.yml) sets. The store caps the number of memories per scope (`maxRecords`) and the bytes of one memory (`maxRecordBytes`); the tools cap the snapshot bytes (`injectMaxBytes`, shipped 8192) and the number of memories one recall returns (`maxRecallResults`); the review counts user-kind messages between forks (`reviewEveryUserTurns`, shipped 10) and caps the child's steps (`maxReviewSteps`, shipped 8). The generated [configuration catalog](../../config-catalog.md#deepseek-aidsh-memory) lists every field.

Override them in a user patch layer, `$DSH_HOME/profiles/<name>/cordis.patch.yml` for one profile or `$DSH_HOME/cordis.patch.yml` for every profile. A patch replaces the row's whole `config`, so state every required field. This keeps the tools but stops the snapshot:

```yaml
- id: tool-memory
  config:
    injectMaxBytes: 0
    maxRecallResults: 8
```

This keeps the plugin mounted but never starts a review:

```yaml
- id: memory-review
  config:
    reviewEveryUserTurns: 0
    maxReviewSteps: 8
```

This removes the tools and the snapshot from the headless profile while leaving stored memories untouched:

```yaml
- id: tool-memory
  disabled: true
```

On Web, the tools and the review belong to the agent preset; pick the `minimal` preset for a session without them.

Shipped profiles keep full-text session search and the session-query tools off. To let the model search prior sessions, apply the overlay in [Session search overlay](../../../apps/cli/config/examples/session-query/README.md). That overlay does not summarize sessions with an LLM.

## Limitations

- Moving or renaming a project directory orphans its project memories, because a project memory is keyed by the full path of its root; write them again from the new location.
- Sibling conversations in one Web host share the store but each takes its own snapshot; a write in one conversation appears in a sibling after that sibling's next compaction or in a new conversation. Memories written by another process, such as a headless run beside a long-running `dsh web` host, appear only after the store reopens (a restart).
- Recall matches one case-insensitive phrase against a memory's name, description, and content; there is no ranking or semantic search.
- Calls to the memory tools appear as generic tool rows in the Web UI; there is no memory panel yet. The review child is an ordinary subagent row labelled `memory-review`.

Third-party memory servers connected through MCP are a separate, default-off path described in [Connect a third-party memory MCP server](mcp-memory.md); both can be active at once.
