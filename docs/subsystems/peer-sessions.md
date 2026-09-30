# Peer Sessions

English | [中文](peer-sessions.zh.md)

Types shared by the experimental peer-session service, its model tools, and the optional bundle that mounts them. The [peer sessions Agent Note](../../.agents/notes/implemented/feature/2026-09-29-peer-sessions.md) owns the mailbox, grouping, and safety decisions; this page records the durable and client-visible forms from [`packages/experimental/peer-sessions/src/types.ts`](../../packages/experimental/peer-sessions/src/types.ts).

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

## Relay limit and safety

Relay depth records the deepest relay this session has received from each peer over the whole log; one send adds one hop, and a send that would exceed `PEER_RELAY_DEPTH_LIMIT`, four hops, is rejected with `PEER_RELAY_LIMIT` instead of enqueued. The budget restarts when the session logs a `user/message` whose source kind is `user`, which is a person re-engaging; a schedule, webhook, Team, or peer producer never restarts it.

A peer message carries no user authority. The harness frames every delivery ahead of the sender's own words, states that the sender is another agent in this repository and not the user, and tells the target to refuse an action its own tools already refused; the sender's text can never alter those lines. Authorization reads the calling session's identity and repository key, never a display name, because a peer chooses its own display name.

Nothing here locks a file or a git ref. The mailbox lock serializes the cap check and one write of one shard and nothing else, so coordination with a peer that never announced itself stays unenforced.

## Optional bundle

[`dsh-experimental-peer-sessions-profile`](../../packages/experimental/peer-sessions-profile/README.md) is the shipped way to mount both packages, and the shipped composition leaves it unmounted: a session whose profile omits it publishes no presence row and lists no peer. The bundle inserts this service and [`dsh-experimental-tool-peer-sessions`](../../packages/experimental/tool-peer-sessions/README.md) with the shipped limits, and the generated [configuration catalog](../config-catalog.md#deepseek-aidsh-experimental-peer-sessions) carries every accepted field with its JSDoc.

## Known limitations

Repository grouping needs a usable `.git` marker, so a symlinked `.git`, a malformed gitfile, or an unreadable marker falls back to `dir:` plus the exact directory and that session groups with none of its checkout's worktrees. Presence has no heartbeat, so a crashed peer can stay listed until its session id is published again, and on Windows a recycled pid keeps a stale row while its mail stays `queued`. Mail for a session that no process holds live stays in its shard until some process holds that session, and the poll interval bounds that wait instead of losing the message. The package [README](../../packages/experimental/peer-sessions/README.md#known-limitations-and-deferred-work) owns the complete limit list.

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
 * Resolve once every listener-owned operation this service started before the
 * call has settled: coalesced presence writes, drain passes, and status
 * reactions.
 *
 * Test seam, not part of the peer-sessions contract. A test that removes or
 * rewrites a presence row awaits this so its own write is the final writer
 * instead of racing the coalesced publication queued behind it, and one that
 * waits for a reaction the listeners own gets the completion signal the
 * disposer itself awaits. Production callers never need it: publications
 * coalesce, and any later state change heals the row again.
 * @internal
 * @returns fulfillment after the tracked work settles.
 */
async whenSettled(): Promise<void>
```

Types: [Agent](core.md)

Source: [`packages/experimental/peer-sessions/src/index.ts`](../../packages/experimental/peer-sessions/src/index.ts)
<!-- END GENERATED cordis-surface -->
