# Agent Note: Peer activity sharing between top-level sessions

Status: implemented

English | [中文](2026-09-30-peer-activity.zh.md)

## Problem

Two top-level sessions editing one repository can overwrite each other's work without either knowing the other is there. The file tools already stop one class of overwrite: `FS_STALE_VERSION` rejects a file-tool write whenever the file changed after the session read it, whoever changed it. That rejection says neither who changed the file nor why, it fires only after the session tried to write, and it says nothing about a session in another worktree of the same repository, whose edits conflict at merge time instead. The [peer sessions](2026-09-29-peer-sessions.md) tools let a session find and message a peer, but only when the model decides to call `list_peers` first, and advice to do so before touching a shared ref cannot cover the moment two models start on the same file.

The user asked for coordination that needs no such decision: sessions that work at the same time tell each other what they are working on and doing, so they avoid clobbering each other's work. This happens in the background for the user and is separate from the team rooms feature.

## Decision

Each top-level session publishes an activity row, `PeerService.activitySnapshot` renders the caller's peers into one context message, and `tool-peer-sessions` appends that message at `agent/pre-step`. No tool, `SessionEventMap` member, or agent-loop change is added. The model-visible carrier is an existing `user/message` with the new qualified source kind `peer-activity`, which the [persistence record](../../../../docs/persistence-changes/2026-09-30-peer-activity-source.md) acknowledges. The [subsystem page](../../../../docs/subsystems/peer-sessions.md#activity) carries the row, snapshot, and source forms.

**A third file family, not a new presence version.** Rows live at `$DSH_HOME/peers/activity/<sha256(sessionId)>.json` beside presence and mail. The presence schema is strict, so extra fields would make a build without activity reject a changed row and drop that session from `list_peers`. A separate family keeps a mixed fleet readable: every build keeps its presence rows valid, and only the snapshot omits a session that has no activity row. Rows carry their own `version`, and a reader skips a row of another version without deleting it, because that build's session may still be live.

**Injection at `agent/pre-step`, deduplicated from the log.** The listener follows the pattern that `time-context` uses: it registers on the agent's own context with `prepend: true`, awaits `next()`, returns a rejected decision unchanged, and appends its message after the decision's own messages. The turn's prompt therefore stays first, the cached system-prompt prefix is untouched, and the loop logs the message as an ordinary `user/message`, so everything the model reads is reconstructable from the log. The listener asks only at a step that already calls the model, by the condition the model-selection listener uses: an empty first step spends no call, and a snapshot must not create one. The snapshot therefore never begins a turn, which is why the client's turn triggers need no `peer-activity` entry.

Deduplication is a host-only `peerActivity` projection over the logged messages (last text, last overlap text, and listed peer ids), not in-process memory, so a resumed or forked session does not repeat a block it already holds. Step 1 shows a changed block. A later step shows one only for a new overlap or a peer that the last block did not list. A completed compaction clears the projection, because the summary replaces the earlier message in the request; a failed compaction keeps it.

**A new peer is announced mid-turn, and attempted writes count.** Two findings of the real-model check produced these rules. In every real pair, the session that started first never learned that a second session had begun, so the source carries `peerIds` and a later step lists a peer that the last message did not list. In the one real collision, the file tools rejected the first session's stale write to a file the second session had written, and no snapshot followed, because only successful writes counted. Every mutating tool call goes on an in-process attempts list whatever its result, and the caller's overlap set is its fresh successful writes plus its attempts. Rows still carry only successful writes, so a peer never learns of a rejected attempt.

**Warn only, with no claims tools.** The snapshot warns and does not block, and no tool lets a session claim a resource. `fs/write-intent` and `fs/edit-intent` are single-slot decisions that `fs-observation-policy` occupies without calling `next()`, so both slots are owned and do not delegate, and no claim could deny a write. A claims board (`claim_resource`, `release_resource`, and `list_claims` over one board per repository) would be unenforceable bookkeeping that adds permanent prompt tokens for behavior the user asked to happen in the background. Declared intent stays a `send_peer_message`, and observed intent is the activity row. `overlap: 'off'` removes the warnings and keeps the block.

**Descendant writes are credited to the top-level session.** Subagents, forks with `origin: 'subagent'`, and Team teammates do most file writing. The service follows `parentSession` through this process's live agents, for at most the `delegationDepth` that the descendant's header records, to the first agent that publishes a row, and records the path there. When the chain leaves this process, nothing is recorded, because this process cannot write the ancestor's row. A descendant's todo list and title never reach the root's row, and a descendant publishes no row of its own: every row write checks that the row's owner is a live top-level peer.

**`doing` is the in-progress todo item.** The row carries the first `in_progress` item of the session's own latest `todo_write` list, cut to 120 characters. Publishing the user's request, a plan, or a goal is rejected, because that would carry one session's prompt text into another provider's model. A todo item is the model's own statement of what it is doing now, and the `todo/write` event is already logged, so the row needs no new signal. `doing` lags when the model updates its list late: in one real pair, the block still named the first item after the session had written the file.

**Paths are keyed against the checkout root.** A `rel:` key is relative to the checkout root that `peerCheckout` finds with the same walk as `peerRepoKey`, not to the working directory. A session started in `<worktree>/packages/x` would otherwise record `rel:a.ts` and never match a peer rooted at the worktree top. Two worktrees of one repository compare the same key, and a path outside the root is `abs:`. The root also drives the `checkout` label: `shared` marks a peer that can overwrite the caller's working tree directly, and a directory name marks one that can conflict only at merge time.

**Shared-checkout git guidance in the prompt.** `peer:coordination` tells a session that shares a checkout with a peer not to discard, stash, reset, check out, or clean the working tree, and not to stage everything, because those commands remove or commit the peer's uncommitted work. The stale-version check does not see git commands run through Bash, so the guidance is the only protection for that case. It is text and binds no one; the file tools remain the only enforcement.

**Peer text is encoded, and the frame comes first.** A peer's title, `doing` line, and paths are text that another model chose. The block follows a fixed header that says it is data about other agents, grants no permission, and asks for nothing. Every peer-chosen string is JSON-encoded with `<` written as `\u003c` in the block and in the overlap sentence, so a title that spells the closing tag cannot end the block.

**A read failure does not fail the step.** `activitySnapshot` runs inside the pre-step of every qualifying agent. A Harness-home read failure, such as a file in place of `peers/activity`, logs one warning and yields no snapshot, because peer activity is advisory.

**Shipped values.** `activityTtlMs` is 30 minutes, because a peer's uncommitted edits stay relevant past 15 minutes. `maxActivityFiles` is 12, because 6 misses overlaps in a normal multi-file change. `maxActivityPeers` is 4, `maxActivityBytes` is 4096, and `overlap` is `warn`. Each is a validated configuration field, and the load error for an invalid value names the field.

**No UI change.** The client renders every logged context message as one collapsed row titled "Context injection", followed by the producer's label, which is the durable kind for a producer with no special case, as `time-context` rows already read. A `peer-activity` row therefore reads "Context injection · peer-activity". Localizing producer labels would change how every producer is labeled, so it waits for Portal feedback that this label reads badly.

## Alternatives considered

**Activity fields on the presence row.** Rejected for the mixed-fleet reason above.

**Publishing the user's request, a plan, or a goal.** Rejected: it crosses prompt text between providers, is unbounded, and has no stable exported projection to read. Reconsider it only with such a projection and a decision about crossing prompts.

**A claims board.** Rejected as unenforceable bookkeeping, above.

**Blocking a write on overlap.** Deferred until the file tools consult a write-authority service that may deny a write; today both intent slots are owned and do not delegate.

**A second fold at `tools/post-execute` for overlaps.** Rejected: its context also lands in the next request, so the extra hook, source kind, and per-turn rate limit would buy no model-visible latency over the one `agent/pre-step` injection.

**Waking the peer on an overlap through `steer` or the mailbox.** Rejected: the peer's rendering changes when this session's paths arrive, so the peer learns at its own next step. A wake would spend that peer's turn budget and relay depth.

**A once-per-turn latch, or an unconditional step-1 injection.** Rejected in favor of content deduplication from the durable projection, which resume safety needs in either design, plus the overlap and new-peer rules for later steps.

**A branch field.** Dropped: no consumer could use it as a trigger, it costs a gitfile read on every publish, and git refuses one branch checked out in two worktrees, so the signal would be mostly noise.

**A configurable list of mutating tool names.** Rejected: which tool names mutate a file is a fixed rule that `workspace-changes` already owns. A copy would drift and fail `pnpm run duplication`, so `@deepseek-ai/dsh-workspace-changes` exports `mutationPath` and this service reuses it. A configurable list would silently publish nothing for a name the rule does not know.

## Testing

`activity.spec.ts` covers row creation and removal, successful versus failed writes, checkout-root keys across worktrees and nested directories, descendant attribution and its limits, `doing`, the file cap, rows of dead and other-version processes, and every configuration rejection. `activity-snapshot.spec.ts` covers the listing filters, ordering, the peer cap, checkout labels, verbatim rendering, encoding of hostile names, overlap including attempted writes and freshness, and each truncation step. `activity-dedupe.spec.ts` covers the step-1 and later-step rules, new peers, compaction resets, and resume. `activity-queue.spec.ts` covers the removal that rides the publish queue and the absence of a row for a disposed root. `tools.spec.ts` covers the injection: one message in the right agent's session, none for a subagent, none once the agent is disposed or the plugin unloads, a rejected or aborted step left alone, an emptied first step and an emptied continuation left alone, and a continuation step that carries a new overlap. `peer.e2e.ts` boots two shipped `dsh` processes, one in the main checkout and one in a linked worktree, writes the same repository-relative path through the real file tools in both, and asserts that each side's next turn logs one `peer-activity` message that names the other and the overlap. The keyless snapshot `snapshots/session/peer-activity/` records the model-visible header, block, and overlap sentence.

## Real-model check

Two headless sessions on different models ran in one shared git checkout, sharing one scratch Harness home with the bundle enabled. Three live pairs used MiMo v2.6 pro and flash, the flash session at reasoning `high` twice and off once. Two further runs paired one real session with a scripted peer row, published under a live pid with the schema of a real row, to force the overlap path. The tasks were a JSDoc pass over every export of one file and a rename of one function and its call sites.

- The later-starting session received the peer's block at step 1 in all three real pairs (one message of 380 to 461 characters). The first-starting session received none, which produced the new-peer rule.
- No real pair produced an overlap section, because the two sessions never both wrote the contested file while both processes were alive. In two pairs the second session waited for the first to send a go-ahead and wrote after the first had exited. In the third, the first session's early writes were rejected, and its first successful write came after the second session had exited.
- The scripted-peer runs produced overlap sections mid-turn (753 and 759 characters). Both models then re-read the contested file within one or two steps and did not write it again.
- In the third pair, the file tools rejected the first session's stale whole-file write after the second session's rename, and no snapshot followed. That finding produced the attempted-writes rule. The first session then re-read the file and kept the rename.
- No model ran a git command, and both changes survived in all five runs. In four of the five runs the session that saw a peer block sent the peer a message before it wrote, which narrows the window in which an overlap can occur; the exception was the flash run at reasoning off in the third pair.
- A step-1 block cost roughly 95 to 155 tokens and a message with an overlap sentence 190 to 250, estimated from character counts at 3 to 4 characters per token.

Sample sizes are one or two per configuration, so the model reactions are observations, not rates. The logs carry no provider usage, and the per-step file reads were not measured.

## Deferred

Each item waits for its trigger. Enforced blocking waits for a write-authority service that the file tools consult and that may deny a write. Overlap on a branch or a shared git ref waits for a verified ref reader in `repo.ts`, which reads `.git` markers only. Waking a peer on an activity change waits for an explicit user setting, because it would spend that peer's turn budget. Write coverage for Bash, PTC, and other non-file tools waits for those tools to report the paths they changed after they run. A localized producer label waits for Portal feedback. Contention on a Harness-home file between repositories waits for a grouping wider than the repository key.

## Consequences

Activity sharing is automatic for every session that mounts the bundle: no tool call, no configuration beyond the bundle, and nothing for the user to arrange. Its costs are bounded. Each model-calling step of a qualifying session reads the activity directory, a changed snapshot adds 60 to 250 tokens once and never more than `maxActivityBytes`, and the two activity paragraphs of the `peer:coordination` section carry about 200 words that every session with the bundle pays whether or not a peer exists.

What it buys is bounded too. The information covers file-tool writes only, can be one step out of date, and reaches the second writer after its write, not before it, so it warns and cannot prevent. The stale-version check stays the only enforcement, and git commands run through Bash are covered by prompt text alone. A separate file family means rows of an exited process stay on disk until a reader probes the pid, and a session of a build without activity is visible to `list_peers` but not to the snapshot. `doing` depends on the model's own `todo_write` habit.
