# Agent Note: Peer sessions over one shared Harness home

Status: implemented

English | [中文](2026-09-29-peer-sessions.zh.md)

## Problem

Top-level sessions working one repository could not reach each other. `ctx.agentTeams` coordinates the teammates of one Lead Session, and the [adjacent-agent steer decision](../architecture/2026-08-27-adjacent-agent-steer-messaging.md) covers agents live in one process, so neither crosses a process boundary: two Harness processes in the same checkout — the ordinary layout of a person driving two terminals — had no way to discover each other, ask a question, or learn that a peer went idle.

A session log belongs to the process holding that session. The [cross-process session write lease](2026-08-31-cross-process-session-write-lease.md) makes a second writer an error rather than a race, so a sender cannot deliver into another process's session even if it tried.

## Decision

`@deepseek-ai/dsh-experimental-peer-sessions` owns `ctx.peers`: discovery, message delivery, idle watches, and the durable files behind them. A peer is another top-level session of the same Harness home whose repository key equals the caller's; the key comes from `peerRepoKey`, and presence is one file per session under `$DSH_HOME/peers/presence/`. `@deepseek-ai/dsh-experimental-tool-peer-sessions` owns the three model tools and their framing, and the [`dsh-experimental-peer-sessions-profile`](../../../../packages/experimental/peer-sessions-profile/README.md) bundle mounts both packages, which the shipped composition leaves unmounted. The [peer sessions subsystem page](../../../../docs/subsystems/peer-sessions.md) carries the durable and client-visible forms.

**A file mailbox under the Harness home, drained only by the process that holds the target live.** `send` commits one envelope into the target's shard and returns `queued` unless this process holds the target; the holding process drains the shard, re-applies the peer and repository checks, and steers the frame. The home directory is the one thing two unrelated processes already share, so coordination needs no shared parent process, no listening socket, and no registration step, and a message outlives a sender that exits before it delivers. Draining only where the session is live keeps single-writer ownership intact: an envelope file is a queue entry, never a substitute log.

**No foreign resume of another process's session.** A process that does not hold the target never write-opens its log, appends no durable row to it, and starts no turn for it. The shipped resume path in the receiving process is the only way a queued envelope is delivered, which is what makes the queue durable across restarts without violating the write lease.

**Deferred mode is timing, not approval.** `peerInbound: 'deferred'` holds a message while the target is idle instead of admitting a turn, and the message is delivered the next time that target runs. A receiving user never reviews the body first, so the mode must not read as a review or consent step: it exists so a deployment can keep idle sessions idle, and both modes carry the same harness frame stating that the sender is another agent and not the user.

**A host-only delivery projection.** Delivery is proven by folding the logged `user/message` whose source carries the envelope's `source.messageId`, in the `peerDelivery` projection beside the per-peer relay depth and the idle-turn bit. That state is host-side bookkeeping, not a durable event and not a tool-result field, so a target's log holds no peer rows and no model-visible schema promises delivery details the sender cannot verify.

**The in-flight steer set.** A drain pass records the envelope ids it steered in a per-target in-flight set until the delivery appears in the log, and a concurrent pass skips those ids. Reading acceptance from the log alone would let the second pass steer again an envelope whose frame is already spliced but not yet flushed, so the set separates "not accepted yet" from "not attempted yet".

**The three-attempt drop.** Each idle settlement that neither finds the delivery applied nor the envelope still pending spends one attempt, and the third attempt deletes the envelope with one warning naming the id and the reason. A target whose session refuses the frame would otherwise be woken forever by the same file, so the bound keeps one legitimate retry after a crash while ending a permanent loop.

**Repository grouping by git common dir, read with plain file reads and no git subprocess.** Two worktrees of one checkout are one peer group because they share git references, which is the boundary where coordination matters. `peerRepoKey` reads `.git` markers directly — a directory, or a gitfile's `gitdir` and optional `commondir` — so discovery is one bounded walk per session, works when `git` is absent or shadowed, and cannot be slowed or broken by hooks, configuration, or a hostile `PATH`. Without a usable marker the key is `dir:` plus the canonical directory, which keeps sessions outside a checkout reachable by exact path, and `GIT_DIR` is ignored because the key names the repository holding the session's own directory.

**The relay reset on a user message.** Relay depth is the deepest relay the whole log records from each peer, and a send that would exceed four hops is refused. Only a `user/message` whose source kind is `user` clears the recorded depths: a person re-engaging is the one sign the loop has an outside participant, while a schedule, webhook, Team, or peer producer is a machine prompting a machine, and letting those reset the budget would remove the cap exactly where it is needed.

**No locks.** The mailbox write lock covers one shard's cap checks and one write, and nothing else. Peer coordination is advisory, on the [Agent Teams note](2026-08-05-agent-teams.md) reasoning that rejected treating ownership or names as file locks: writers that do not consult the lock ignore it, crashed owners leave it behind, and false mutual exclusion is more dangerous than an explicit warning. Across processes the writers are even less observable, so the same conclusion holds with more force.

**The acceptance check derived from `messageAccepted` rather than imported.** The peer check asks the same question Agent Teams asks — has this message reached history, or is it still durably pending — but answers it over the peer envelope's own fields, with the delivery ids the in-flight set needs. Importing `messageAccepted` from `packages/experimental/agent-team/src/session-message.ts` would couple two experimental domains that must stay free to change independently, and would hand the peer package a predicate shaped for Team messages; deriving it keeps `source.messageId` as the only contract between them, and is also what the mailbox caps that already exist can be reviewed against.

## Alternatives considered

**A shared in-process registry, or a socket beside the log.** Rejected: an in-process registry cannot see another Harness process, and a socket needs a listener whose lifetime, port, and authentication the home directory does not define. A file mailbox is the smallest contract two unrelated processes can already honor, and it survives a process that is replaced rather than restarted.

**Delivering through the target's own scheduler from the sender's process.** Rejected: the write lease makes a foreign writer an error, and a delivery that bypasses the receiving process's turn admission would move durability and framing into the wrong process.

**A durable `peer/*` session event for mail.** Rejected: the log would then carry peer bookkeeping rows visible to every consumer and to forks, and the acceptance question would need a second, event-shaped answer beside the existing `user/message` one. The host-only projection answers it from rows the harness already writes.

**Importing `messageAccepted` from Agent Teams.** Rejected for the coupling reason above. The derived predicate stays small because the peer envelope carries its own id and version, which is what the drain needs and what a team message does not supply.

**Approval-gating deferred delivery.** Rejected: the mode exists to keep idle sessions idle, not to add a consent step. A gate would have to be rendered and answered somewhere, and every peer message would then depend on the receiving user returning, which is the opposite of the deployment that asked for deferred mode.

**Treating a peer's display name as its identity.** Rejected: names are chosen by the sending session and may repeat or change, so authorization and delivery resolution compare session ids and repository keys. A name is accepted in `to` only when it matches exactly one peer in the caller's repository.

## Testing

`repo.spec.ts` covers the repository key over directories, gitfiles, and fallbacks; `presence.spec.ts` covers row writes, replacement, and pid probes; `mailbox.spec.ts` covers the shard layout, versions, caps, and the write lock; `projection.spec.ts` covers the delivery fold, relay depth, and the idle-turn bit; `deferred.spec.ts` covers held messages and their later delivery; `relay.spec.ts` covers the hop cap and its reset; `watches.spec.ts` covers subscriptions, notices, and disposal; `authorize.spec.ts` and `framing.spec.ts` cover the peer checks and the harness frame; `tools.spec.ts` covers the model tools' schemas and results. `peer.e2e.ts` boots two shipped `dsh` processes over one Harness home, one of them in a linked worktree, and asserts the messages, the frame, and the log rows across a receiver restart.

## Consequences

Peer coordination is opt-in and file-based: a deployment that mounts the bundle gets discovery and delivery with no daemon, no port, and no shared parent process, and a deployment that omits it keeps the previous behavior exactly. The cost is a second durable surface under the Harness home that has its own caps, its own retention rules, and no liveness heartbeat, so limits and stale presence are visible to users and are documented rather than hidden. Delivery latency follows the poll interval for a target held by another process, and the relay cap makes sustained autonomous chatter between two sessions stop at four hops until a person speaks.
