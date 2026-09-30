# Peer Sessions

English | [中文](peer-sessions.zh.md)

Types shared by the experimental peer-session service, its model tools, and the optional bundle that mounts them. The [peer sessions Agent Note](../../.agents/notes/implemented/feature/2026-09-29-peer-sessions.md) owns the mailbox, grouping, and safety decisions, and the [peer activity Agent Note](../../.agents/notes/implemented/feature/2026-09-30-peer-activity.md) owns the activity decisions; this page records the durable and client-visible forms from [`packages/experimental/peer-sessions/src/types.ts`](../../packages/experimental/peer-sessions/src/types.ts) and [`repo.ts`](../../packages/experimental/peer-sessions/src/repo.ts).

## Peer identity

A peer is another top-level session of the same Harness home. A session is top-level when its runtime root has no `subagent` origin and a delegation depth of zero, so a subagent never lists a peer and is never listed as one.

Peers group by repository rather than by exact working directory: every worktree of one checkout is one group, and a directory outside any checkout is a group of its own. `peerRepoKey` derives the key from `.git` markers on disk with plain file reads and no `git` subprocess: a `.git` directory keys the checkout by its canonical path, a `.git` gitfile keys the repository its `gitdir` line and optional `commondir` name, and a marker that exists but names no usable repository ends the walk. Without a usable marker the key is `dir:` plus the canonical working directory, and `GIT_DIR` is ignored because the key names the repository holding the session's own directory.

`list(agent)` reads the presence rows under `$DSH_HOME/peers/presence/`, keeps the rows whose repository key equals the caller's, drops the caller, and orders the rest by name and then session id. One row is one file named `<sha256(sessionId)>.json`, rewritten on every lifecycle change this process observes and on a title or approval change, and unlinked when the agent is disposed. A reader retires a row only when its recorded pid fails a `process.kill(pid, 0)` probe with `ESRCH`, so no heartbeat and no age threshold unlists a live session.

`status` is the liveness of that session's agent loop as the process holding it last published it. `awaiting-user` means a running turn has an open approval question or an in-flight `user-questions/request`, and it is a presence value rather than a third agent status.

```ts type-equiv
/** One other top-level session in the calling session's repository. */
interface PeerEntry {
  /** Discriminant reserved for later peer kinds; every current entry is a session. */
  readonly kind: 'session'
  /** Session identity to address in `send` and `notifyIdle`. */
  readonly id: SessionId
  /** Display name the session chose, or its session id while the log records no title. */
  readonly name: string
  /** Liveness of that session's agent loop. */
  readonly status: PeerStatus
  /** Working directory that session was created in, so the model sees which worktree it occupies. */
  readonly cwd: string
  /** Provider route of that session, when its agent options set one. */
  readonly provider?: string
  /** Model id of that session, when its agent options set one. */
  readonly model?: string
}
```

## The file mailbox

`send(agent, request)` commits one envelope into the target's shard at `$DSH_HOME/peers/mail/<sha256(targetId)>/`, where the writer lock covers the cap checks and the write alone. Only the process that holds the target as a live agent drains that shard: it re-applies the top-level and repository checks, steers the frame, and flushes the session. A process that does not hold the target writes the file and returns `queued`, so peers in different processes coordinate without a shared parent process and without resuming another process's session.

Delivery is `Agent.steer()` of one `user/message` whose source carries the envelope identity, followed by a session flush. The envelope file is deleted only once that delivery is applied in the target's log, which the host-only `peerDelivery` projection proves by folding the logged `user/message`; an envelope the log does not record stays on disk for a later pass. A drain pass holds the ids it steered in a per-target in-flight set, so a concurrent pass leaves an envelope whose splice is still pending alone instead of steering it twice.

When a target turns idle, every in-flight envelope that the log does not record as delivered and the inbox no longer holds spends one attempt; the third attempt deletes the envelope and logs one warning naming the id and the reason, so a target that rejects every step wakes at most three times per process. Every other dropped file — a schema failure, a target that is not a top-level peer, another session, another repository — is deleted in the same pass with one warning that never quotes the sender's body.

```ts type-equiv
/** One message to deliver to another top-level session. */
interface SendPeerMessageRequest {
  /** Target session id, or a name that matches exactly one peer in the caller's repository. */
  readonly to: string
  /** Complete message text; the target sees this and the harness frame around it, never the sender's transcript. */
  readonly message: string
}
```

```ts type-equiv
/** Outcome of one {@link SendPeerMessageRequest}. */
interface SendPeerMessageResult {
  /** Envelope identity, matched on the target's log by `source.messageId`. */
  readonly messageId: PeerMessageId
  /**
   * `delivered` when this process steered the message, `queued` while it waits
   * for a process holding a live target, `deferred` while a deferring target is
   * idle.
   */
  readonly status: 'delivered' | 'queued' | 'deferred'
}
```

`delivered` means this process steered the envelope, `queued` means it waits for a process that holds a live target, and `deferred` means the configured `peerInbound: 'deferred'` held it while the target was idle. `deferred` is a timing delay and not a review step: the message enters the model context when the target next runs, and the receiving user does not approve it first.

## Idle watches

`notifyIdle(agent, request)` writes one watch file per watcher and target under `$DSH_HOME/peers/watches/<sha256(targetId)>/<sha256(watcherId)>.json`. The watched process enqueues one notice envelope into each watcher's own mailbox on the target's next idle transition and deletes every watch it consumed; a target that is disposed or reaped deletes its watches without notifying, so a watcher whose peer disappears receives nothing. A watch requested while the caller's own open turn was opened by an idle notice is rejected with `PEER_IDLE_TURN`, so one notice cannot start a chain of subscriptions.

A target that is already idle produces the notice immediately, and the caller's own process delivers it because the envelope lands in the caller's shard. `watching` means the subscription is recorded and no notice is due yet.

```ts type-equiv
/** One subscription to a peer's next idle transition. */
interface NotifyPeerIdleRequest {
  /** Target session id, or a name that matches exactly one peer in the caller's repository. */
  readonly to: string
}
```

```ts type-equiv
/** Outcome of one {@link NotifyPeerIdleRequest}. */
interface NotifyPeerIdleResult {
  /**
   * `watching` when this call added or found a subscription, `delivered` when
   * the target was already idle, `queued` while the notice waits for a process
   * holding the calling session.
   */
  readonly status: 'watching' | 'delivered' | 'queued'
}
```

<a id="activity"></a>
## Activity

Each top-level session with a usable working directory publishes one activity row, so peers working in one repository can avoid overwriting each other's files. The row is `$DSH_HOME/peers/activity/<sha256(sessionId)>.json`, beside the presence row. It holds the repository key, working directory, checkout `root`, title as `name`, `status`, `doing`, `files`, pid, and the time of the last publish. The service rewrites the row when the status, the title, an approval question, the todo list, or the file list changes, and removes it when the agent is disposed. A reader removes a row whose pid fails the `process.kill(pid, 0)` probe with `ESRCH`, and skips a row that fails validation, including a row of another `version`, without deleting it.

`doing` is the first `in_progress` item of the session's own latest `todo_write` list, cut to 120 characters. A path enters `files` only when a `write`, `edit`, or mutating `str_replace_editor` call reports success, newest first, at most `maxActivityFiles`. A subagent's writes are recorded on its top-level ancestor when this process holds each parent up to that ancestor, within the `delegationDepth` of the subagent's header. Each path is keyed `rel:` against the checkout root, or `abs:` when it lies outside the root.

`peerCheckout` supplies the root. It walks up as `peerRepoKey` does, and `root` is the directory that holds the `.git` entry the walk stopped at, so a linked worktree reports its own top; a `dir:` fallback reports the canonical working directory. Keying against the root, not the working directory, makes a session started in `packages/x` and a session started at the checkout top record one key for one file.

```ts type-equiv
/** One working directory's checkout: the repository key that groups its peers, and the directory the walk stopped at. */
interface PeerCheckout {
  /** Repository key of the checkout; exactly what {@link peerRepoKey} returns for the same directory. */
  readonly key: string
  /**
   * Directory holding the `.git` entry the walk found: the checkout the working
   * directory belongs to, so a linked worktree reports its own top. Every `dir:`
   * fallback reports `canonicalCwd` instead, because a directory whose marker is
   * unusable is its own root.
   */
  readonly root: string
}
```

`activitySnapshot(agent, step)` renders the caller's peers for one step. It lists each other peer of the caller's repository that is `running` or `awaiting-user` or has a file written within `activityTtlMs`, ordered `running`, `awaiting-user`, then `idle`, newest publish first, at most `maxActivityPeers`. A peer whose checkout root equals the caller's is `shared`; a peer in another worktree is named by the last segment of its root. With `overlap: 'warn'`, one `peer:overlap` section follows the `peer:activity` block for each listed peer that wrote a path the caller also wrote or tried to write. The caller's paths come from lists that this process keeps as its tool calls and results arrive, so an attempted write counts even when the file tool rejected it, and a write whose row publish is still queued counts at once.

A block over `maxActivityBytes` UTF-8 bytes loses peers from the end, then the last peer's files, then its `doing`, and carries `"truncated":true`; when even that does not fit, the snapshot is empty. Every peer-chosen string, meaning a name, a `doing` line, or a path, is JSON-encoded with `<` written as `\u003c` wherever it appears, so peer text cannot close the block.

```ts type-equiv
/** One rendered activity snapshot of the caller's peers, ready to become a `peer-activity` message. */
interface PeerActivitySnapshot {
  /** The section texts joined by a blank line — the complete text of the message that carries the snapshot. */
  readonly text: string
  /** The named sections {@link PeerActivitySnapshot.text} assembles, in order. */
  readonly sections: readonly ContextSnapshotSection[]
  /** Session ids of the peers the block lists, in block order; the message carries them as {@link PeerActivitySource.peerIds}. */
  readonly peerIds: readonly SessionId[]
}
```

The tool package appends the snapshot as a `user/message` whose source is `PeerActivitySource`, and the loop logs it. `peerIds` names the listed peers for the comparison at later steps, and the text never carries session ids. The kind is a qualified attribution kind: a build without this package keeps reading the log.

```ts type-equiv
/** Source of one activity snapshot this session was shown about its peers. */
interface PeerActivitySource {
  readonly kind: 'peer-activity'
  readonly form: 'snapshot'
  /** Named contributions in assembly order: the peer block, then one overlap warning per peer. */
  readonly sections: readonly ContextSnapshotSection[]
  /**
   * Session ids of the peers the block lists, in block order. The rendered text
   * never carries them: a later step compares them with the peers it would list
   * to tell whether one appeared since this message.
   */
  readonly peerIds: readonly SessionId[]
}
```

The host-only `peerActivity` projection folds the logged `peer-activity` messages into the last text, its overlap text, and the listed peer ids. At step 1 of a turn, a snapshot whose text differs from the last one is shown. At a later step, a snapshot is shown only for an overlap not yet warned about or for a listed peer that the last message did not list. A `compaction/end` event without `error` clears the projection, because the summary replaces the earlier message in the request; a failed compaction keeps it. The snapshot never begins a turn, and the tool package does not append it to a step that spends no model call. When `peers/activity` cannot be read, `activitySnapshot` logs one warning and returns nothing.

Activity is advisory. No tool consults a row before it writes, and a write made through Bash, a formatter, or another process is not published. The generated [configuration catalog](../config-catalog.md#deepseek-aidsh-experimental-peer-sessions) lists `activityTtlMs`, `maxActivityFiles`, `maxActivityPeers`, `maxActivityBytes`, and `overlap`. The package [README](../../packages/experimental/peer-sessions/README.md#model-experience) owns the model-visible text and its cost.

## Relay limit and safety

Relay depth records the deepest relay this session has received from each peer over the whole log; one send adds one hop, and a send that would exceed `PEER_RELAY_DEPTH_LIMIT`, four hops, is rejected with `PEER_RELAY_LIMIT` instead of enqueued. The budget restarts when the session logs a `user/message` whose source kind is `user`, which is a person re-engaging; a schedule, webhook, Team, or peer producer never restarts it.

A peer message carries no user authority. The harness frames every delivery ahead of the sender's own words, states that the sender is another agent in this repository and not the user, and tells the target to refuse an action its own tools already refused; the sender's text can never alter those lines. Authorization reads the calling session's identity and repository key, never a display name, because a peer chooses its own display name.

Nothing here locks a file or a git ref. The mailbox lock serializes the cap check and one write of one shard and nothing else, so coordination with a peer that never announced itself stays unenforced.

## Optional bundle

[`dsh-experimental-peer-sessions-profile`](../../packages/experimental/peer-sessions-profile/README.md) is the shipped way to mount both packages, and the shipped composition leaves it unmounted: a session whose profile omits it publishes no presence row and lists no peer. The bundle inserts this service and [`dsh-experimental-tool-peer-sessions`](../../packages/experimental/tool-peer-sessions/README.md) with the shipped limits, and the generated [configuration catalog](../config-catalog.md#deepseek-aidsh-experimental-peer-sessions) carries every accepted field with its JSDoc.

## Known limitations

Repository grouping needs a usable `.git` marker, so a symlinked `.git`, a malformed gitfile, or an unreadable marker falls back to `dir:` plus the exact directory and that session groups with none of its checkout's worktrees. Presence has no heartbeat, so a crashed peer can stay listed until its session id is published again, and on Windows a recycled pid keeps a stale row while its mail stays `queued`. Mail for a session that no process holds live stays in its shard until some process holds that session, and the poll interval bounds that wait instead of losing the message. Activity covers file-tool writes only, and a peer's row can be one step out of date. The package [README](../../packages/experimental/peer-sessions/README.md#known-limitations-and-deferred-work) owns the complete limit list.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpeers--peerservice"></a>

### `ctx.peers` — `PeerService`

`ctx.peers`: peer discovery, messaging, and idle watches for the top-level sessions one Host process holds.

One instance owns the file provider for every live agent in that process; peers in other processes coordinate only through the mailbox files under the Harness home. Methods take the calling agent explicitly, so authorization follows the caller rather than ambient context.

```ts cordis-catalog
/**
 * List the caller's peers: other top-level sessions in its repository with
 * peer coordination enabled, ordered by name and then session id.
 * @param agent - calling agent, whose cached repository key selects the listed peers.
 * @returns one entry per listed peer, excluding the caller.
 * @throws {PeerError} `PEER_NOT_TOP_LEVEL` for a caller that is not a peer, `PEER_NO_CWD` for a caller with no usable directory.
 */
async list(agent: Agent): Promise<readonly PeerEntry[]>

/**
 * Send one message to a peer, queueing it durably when no process holds a
 * live target.
 * @param agent - calling agent; the message is attributed to its session.
 * @param request - target and complete message text.
 * @returns the envelope identity and how far delivery got.
 * @throws {PeerError} for an unresolved, ambiguous, unauthorized, oversized, or relay-limited send.
 */
async send(agent: Agent, request: SendPeerMessageRequest): Promise<SendPeerMessageResult>

/**
 * Subscribe once to a peer's next idle transition.
 * @param agent - calling agent, which receives the notice in its own mailbox.
 * @param request - target to watch.
 * @returns whether this call added a subscription, or a notice was already due.
 * @throws {PeerError} for an unresolved, unauthorized, full, or idle-turn-limited watch.
 */
async notifyIdle(agent: Agent, request: NotifyPeerIdleRequest): Promise<NotifyPeerIdleResult>

/**
 * Render what the caller's peers published, when this step has something new
 * to show.
 *
 * The block is data about other agents: it is not a user request and grants
 * no authority, which is what the header says in as many words. A session
 * that owns no activity row — a subagent, or one without a working directory
 * — publishes no row, has no dedupe state of its own, and so is shown
 * nothing.
 * @param agent - calling agent, whose repository and checkout scope the listed peers.
 * @param step - step number inside the open turn. Step 1 shows a block whose
 * text changed since the last one this session logged; a later step shows a
 * block only to warn about an overlap it has not warned about yet, or to list
 * a peer the last logged block did not list.
 * @returns the rendered block, its sections, and the ids of the peers it
 * lists, or `undefined` when no peer qualifies, when nothing fits the byte
 * cap, or when this step already saw what it would say.
 */
async activitySnapshot(agent: Agent, step: number): Promise<PeerActivitySnapshot | undefined>
```

Types: [Agent](core.md)

Source: [`packages/experimental/peer-sessions/src/index.ts`](../../packages/experimental/peer-sessions/src/index.ts)
<!-- END GENERATED cordis-surface -->
