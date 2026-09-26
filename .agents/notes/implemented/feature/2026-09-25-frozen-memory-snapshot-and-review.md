# Agent Note: Frozen memory snapshot and unattended review

Status: implemented

English | [中文](2026-09-25-frozen-memory-snapshot-and-review.zh.md)

## Problem

First-party durable memory already kept preferences, feedback, project facts, and references as JSON under the harness home. Refreshing the injected list at every turn start, and again when the rendered text changed, appended a new copy after the reusable request prefix, so later turns paid for that suffix and could not reuse a warm KV Cache for it. A system-prompt section would rebuild node 0 on models without `systemPromptUpdate` and would interpolate `{{cwd}}` through the persona. An unattended reviewer that changed tools, persona, or model would miss the parent's cached prefix. Injection text stored in a memory body would reach a later session's model request.

## Decision

One snapshot of visible memories is added as a sourced `user/message` at the first step of a surface generation and again after compaction. The `memoryCatalog` projection is `stateVersion: 3` with `{ taken: boolean; stepPending: boolean }`. `step/start` logs before `agent/request`/`prepareCall` resolve the route, and cancellation during that async phase commits neither the system prompt nor the step's messages, so it folds only to `stepPending: true`; a committed `user/message` while pending folds to `{ taken: true, stepPending: false }`, this plugin's own snapshot message folds to the same state unconditionally, `step/end` folds pending back to `false`, and `compaction/summary` folds both `taken` and `stepPending` to `false`. `taken` is set whether or not anything was injected, so a conversation whose store was empty at its first step gets no snapshot until compaction; tool results confirm writes in between. The prepended `agent/pre-step` listener awaits `next()` first, then appends the snapshot after the claimed user message and runtime context. Resume refolds `taken` and `stepPending` from the log. A fork child that inherits the parent's snapshot message folds `taken === true` and does not inject a second copy.

The snapshot header is `Saved memories (snapshot):`. Visible records flatten in type order `user`, `feedback`, `project`, `reference`, then name, then global before project. Each record inlines its recall block when that block's UTF-8 bytes fit remaining `injectMaxBytes`, otherwise an index line, otherwise it is omitted; a record larger than the remaining budget is index-only. Description or content that fails `scan` becomes `- [<type>, <scope>] <name> — [blocked]` and is never inlined. Shipped `injectMaxBytes` is 8192; `0` disables injection; a positive value below `SNAPSHOT_MIN_BYTES` fails load.

`scanMemoryText` and `MemoryStore.scan` are a security invariant, not a Config field. Raw text rejects C0 controls other than tab and newline, every C1 control, and the invisible and bidirectional set U+200B, U+200C, U+200D, U+2060, U+2062–U+2064, U+FEFF, U+202A–U+202E, U+2066–U+2069. A copy is NFKC-normalized for matching only, truncated to 65,536 UTF-16 code units, and tested against the shipped threat-pattern array. `write` scans description then content after trim and size checks. A finding is `blocked-content`. A newline in a write description is `invalid-description`. A project key occupied by another project's record is `project-key-collision`. Snapshot render and `memory_recall` use the same scan for placeholders and never `backup-and-skip` on a scan finding.

`@deepseek-ai/dsh-memory-review` starts an in-process fork from the parent's `agent/status` idle notification after `reviewEveryUserTurns` user-kind messages (shipped 10; `0` disables). The start omits `toolFilter`, `persona`, and `agentOptions`. Restrictions install on `created.agent.ctx` during the serial `agent/created` that `agents.create` awaits before `start()` returns: allow `memory_recall`; allow `memory_write` only for a name and scope that are not already visible; deny `memory_forget` and every other tool; reject `step > maxReviewSteps` (shipped 8). The parent model sees nothing. The base bundle and TUI enable the plugin; headless, ACP, and SDK disable it; Web remounts it on the `standard`, `cordis`, and `ptc` presets.

Threat-pattern groups and the add-only unattended review follow Hermes Agent, licensed under MIT: the [Hermes memory guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) and the [Hermes Agent repository](https://github.com/NousResearch/hermes-agent). `packages/memory/memory/src/scan.ts` adapts regexes from [`tools/threat_patterns.py`](https://github.com/NousResearch/hermes-agent/blob/4c286ae7a0dcb86e70a7ad8c23c0f05c89e33ec3/tools/threat_patterns.py) and carries that MIT notice.

The store and tools split, JSON layout, and attribution-only `tool-memory` source kind remain as in the [first-party durable memory note](2026-09-19-first-party-durable-memory.md).

## Alternatives considered

### Why not refresh the catalog at every turn start?

A turn-start compare against the last injected text would pick up this process's writes, hand edits, and sibling-session writes without a stale copy in the same conversation. It would also append a new list after the reusable prefix on every turn that differed, so there is in-generation churn and no prefix reuse for that suffix. Freeze pays the sibling cost: a write appears in another conversation's snapshot after that conversation's compaction or in a new session.

### Why not put memory in the system prompt?

`deepseek-v4-pro` has no `systemPromptUpdate`, so a mid-session system-prompt rewrite rebuilds node 0. Personas interpolate `{{cwd}}`, so a system-prompt memory list would also break cross-cwd prefix reuse. Model-visible input must be reconstructable from the session log; a sourced `user/message` is an existing event type.

### Why not prepend the snapshot before the claimed user message?

`agent-instructions` documents claimed-first. Time-context already appends a per-session first-step message, so prepend would not buy a stable cross-session prefix. Prepend would also put attacker-planted user-role memory before the human turn.

### Why not group snapshots under Global and Project headers?

Type-first flatten puts a project `user` record before a global `reference`. Scope is already in the `[<type>, <scope>]` tag.

### Why not make threat patterns a Config field?

A composition could empty the list. The checks are a security invariant in `scan.ts` as one exported `readonly` array. False positives are a source change, not a Config edit, and do not refresh the prompt corpus.

### Why not quarantine a record when snapshot or recall scan fails?

`backup-and-skip` is for zod schema failure at open. Render-time quarantine would rename a hand-edited file that still parses. The `[blocked]` placeholder keeps the file and tells the model the body is not inlined.

### Why not pass toolFilter, persona, or a routed model to the review child?

Those options would change the child's first request relative to the parent and lose cache parity. The child is a durable in-process fork with the same route, tools, and persona. Add-only is Hermes Agent's unattended-review rule, enforced at `tools/pre-execute` on the child's `ctx` during `agent/created`.

### Why not a pre-compaction flush, a MemoryProvider ABC, a routed digest review, or LLM search summarization?

Hermes Agent removed the pre-compaction flush at [`ea01bdce`](https://github.com/NousResearch/hermes-agent/commit/ea01bdce). A provider ABC waits for a vendor that cannot be an MCP overlay. A cheaper routed digest review waits for a measured cost. LLM summarization in recall would break keyless replay.

## Consequences

Turns after the first step reuse the request prefix: the snapshot is append-only after the claimed user message and runtime context, and it is not refreshed until compaction. Sibling Web sessions see new writes in the next snapshot (after compaction or in a new session). A conversation that starts empty has no snapshot until compaction. Cross-process writes still appear only when the domain reopens.

Unattended review spends one cached-rate replay of the parent prefix every ten user-kind turns while the process lives. The child's first step may compact when the parent is near its threshold, which drops the warm cache read. Web shows an ordinary subagent row labelled `memory-review`.

## Deferred

Revisit `/memory` when JSON files prove insufficient and a recorded GIF exists; a Web memory panel when generic tool rows prove insufficient for curation; routed digest review after a measured dollar cost; write-approval via `ctx.approval.request` after a first unattended-loss incident; a MemoryProvider ABC for a vendor that cannot be MCP; prepend for cross-session sharing after measured same-cwd cold prefill once `{{cwd}}` and time-context stop diverging; a git-shared store when a team must commit facts; semantic recall after measured substring misses; a subagent memory-write ban when composition `toolFilter` is the chosen enforcement.

## Testing

Store scan, collision, and one-line description tests live in `packages/memory/memory/tests/`. Snapshot once-per-generation, append position, budget, and `[blocked]` tests live in `packages/memory/tool-memory/tests/`. Review interval, add-only, created-before-execute, and cache e2e tests live in `packages/memory/memory-review/tests/`. `snapshots/sdk/memory-catalog-refresh` pins re-injection after compaction and no turn-2 refresh. `snapshots/session/memory-review-fork` waits for the child turn. Prompt and tool-description freeze is one corpus refresh; a memory-review scenario must not rewrite those sidecars.
