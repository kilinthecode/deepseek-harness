---
description: "The accept_worktree, discard_worktree, and list_worktrees tools for users and maintainers composing or debugging worktree-isolated delegation."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-worktree

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-worktree` adds the model-facing tools that land, discard, and list the isolated git worktrees `ctx.subagentWorktrees` provisions: `accept_worktree` commits a finished child's changes, runs any configured checks, and has an independent reviewer confirm the exact commit before merging it into the caller's checkout; `discard_worktree` deletes an abandoned worktree and its branch without merging; `list_worktrees` reports the open worktrees the caller started. Each tool resolves its owner, and for listing its repository, from the calling Session, so a caller sees and acts on only the worktrees it created. The tools are thin adapters: lifecycle authority, git work, and review belong to `ctx.subagentWorktrees`.

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

Mount this package wherever a `subagent` delegation tool offers `isolation: "worktree"`, whether through a tool row's `worktreeIsolation` config (see `@deepseek-ai/dsh-tool-subagent`) or through the service's `offerIsolation` setting, which the `@deepseek-ai/dsh-agent-crew` bundle sets. It requires `ctx.subagentWorktrees` (`@deepseek-ai/dsh-subagent-worktree`), already mounted, inert, in the shared `dsh-base` composition.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-subagent-worktree'
- name: '@deepseek-ai/dsh-tool-subagent-worktree'
```

This package takes no configuration: all three tools register unconditionally once `ctx.subagentWorktrees` is available.

### accept_worktree

Commits the named worktree's changes, runs any configured check command, and has an independent reviewer check the exact resulting commit; a passing verdict merges it into the caller's checkout. The render states the outcome precisely: merged (with the merge commit and reviewer route), rejected (with every finding), checks-failed (with the check command and its output), conflict (with the conflicting paths), blocked (with the git refusal reason), or empty (no changes to accept). Only a merged outcome changes the caller's checkout. A rejected result says how to fix and resubmit: a background child receives the findings through `send_message` and the caller accepts again once it settles, while a foreground child cannot receive messages, so the caller discards the worktree and starts a new background worker with the task and the findings.

### discard_worktree

Deletes the named worktree and its branch without merging; the discarded change is not recoverable through this tool.

### list_worktrees

Lists the caller's own still-open worktrees (`open` and `reviewing` states), each with its branch, path, state, latest worker agent id (`none` when no worker was recorded), and latest review verdict (`pass`, `fail`, or "not reviewed"). The worker id is the `agent_id` `send_message` takes, so a caller that lost its context to compaction can still message the worker that owns a rejected worktree. Scoped to the calling Session as owner and to the repository containing the Session's working directory; it never lists another Session's worktrees.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Each tool converts the calling Agent into the service's request shape and nothing more: owner is always `{ kind: 'session', sessionId: <calling Agent id> }`, `accept_worktree`'s parent is the calling Agent itself, and `list_worktrees`'s `baseDir` is the calling Session's `header.cwd`. The `worktree_id` argument of `accept_worktree` and `discard_worktree` is checked with the service's exported `assertWorktreeId` before the service is called, so a malformed id from the model is rejected at the tool boundary with the service's own message. The tools hold no state of their own; every id, state, and verdict comes from `ctx.subagentWorktrees`'s durable record.

### Declared results and rendered text

Each tool declares a complete canonical result schema — a discriminated union for `accept_worktree`, matching every outcome kind the service can settle with — so a PTC caller receives structured fields (commit ids, the reviewer route, findings, conflicted paths), not only prose. `output.render` turns that same value into the exact wording a model reads. [`src/values.ts`](src/values.ts) owns both the schemas and the verbatim templates, so a template change and its schema stay in one file.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Tool registration: `accept_worktree`, `discard_worktree`, `list_worktrees` |
| [`src/values.ts`](src/values.ts) | Declared result schemas, service-to-value projection, and verbatim render templates |
| — | No runtime invariant companion is published; this model-facing adapter holds no independent lifecycle stream of its own — worktree state and authority belong to `ctx.subagentWorktrees`. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from these tool schemas to the worktree service and workflow behind them.

- `@deepseek-ai/dsh-subagent-worktree` (`packages/subagent/subagent-worktree/`) — the service these tools call: placement, the accept state machine, and review.
- [`@deepseek-ai/dsh-tool-subagent`](../tool-subagent/README.md) — the delegation tool whose `isolation: "worktree"` option creates the worktrees these tools act on.
- [`agent-crew` skill](../../skill/skill-agent-crew/README.md) — the bundled workflow that decomposes a goal into worktree-isolated workers and lands each part with these tools.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-worktree) — the three tool schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-worktree): `accept_worktree` and `discard_worktree` each take the required `worktree_id`; `list_worktrees` takes no parameters. These three schemas are added to a session's tool catalog only where the enabling bundle (`@deepseek-ai/dsh-agent-crew`) is switched on; a session without it never sees them.

#### Token effect

Fixed schema cost per parent request, present only while the enabling bundle is switched on.

#### KV Cache effect

Prefix-stable; the schemas do not change at runtime.

### accept_worktree result

#### What the model sees

One of six fixed templates below, chosen by the outcome the service settled on. A merged outcome appends ` The worktree was removed; start a new child for further work.` when the worktree was removed after merging. A checks-failed outcome says the command "was stopped before it exited" instead of naming an exit code when the check process left none (for example, killed by a signal), and quotes any argv element containing whitespace so the command can be reproduced. [`src/values.ts`](src/values.ts) owns the exact wording of each.

##### Merged

```markdown
Merged worktree <id> into <repoRoot>: commit <commit> as merge <mergeCommit>. Reviewer <provider>/<model> passed it: <summary>.
```

##### Rejected

```markdown
Review failed for worktree <id> at commit <commit> (reviewer <provider>/<model>): <summary>
Findings:
- <finding>
If the child is a background subagent, send these findings to it with send_message, wait for it to finish, then accept again. A foreground child cannot receive messages: discard the worktree and start a new background worker with the task and these findings.
```

##### Checks failed

```markdown
Checks failed for worktree <id> at commit <commit>: `<argv>` exited <code>.
<output>
```

##### Conflict

```markdown
Worktree <id> passed review at commit <commit> but conflicts with your checkout in: <files>. Nothing was merged. Merge branch <branch> yourself and resolve the conflicts, or discard the worktree.
```

##### Blocked

```markdown
Worktree <id> passed review at commit <commit>, but the merge could not start: <reason>. Commit or set aside the conflicting changes in your checkout, then accept again.
```

##### Empty

```markdown
Worktree <id> has no changes to accept.
```

#### Token effect

One short paragraph per call, bounded by the check output and the reviewer summary and findings the service already bounds.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### discard_worktree result

#### What the model sees

`Discarded worktree <id> and branch <branch>.`

#### Token effect

One short confirmation line per call.

#### KV Cache effect

Append-only; follows the reusable request prefix.

### list_worktrees result

#### What the model sees

One labeled line per open worktree, `<id>  state=<state>  branch=<branch>  path=<path>  worker=<agent-id-or-none>  review=<verdict-or-"not reviewed">  label="<label>"`, or `No open worktrees.` when none are open. A path containing whitespace is quoted.

#### Token effect

Grows linearly with the caller's own open worktrees; no cursor or cap.

#### KV Cache effect

Append-only; follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No cross-session review** — `accept_worktree` and `discard_worktree` accept only the record's own session owner or the CLI operator; a sibling or unrelated Session cannot act on a worktree it did not start, even to help finish a stalled one.
- **`list_worktrees` reports only open state** — it excludes `merged` and `discarded` records, so a caller cannot audit a worktree's full history through this tool; `ctx.subagentWorktrees.list()`'s `includeClosed` option has no model-facing tool exposing it.
- **No partial accept** — a rejected or checks-failed worktree must be fixed as a whole and resubmitted; there is no tool to merge part of a worktree's changes.
- **A rejected foreground child cannot be fixed in place** — a foreground child is disposed when it finishes and cannot receive `send_message`, so its rejected worktree is discarded and redone by a new background worker.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
