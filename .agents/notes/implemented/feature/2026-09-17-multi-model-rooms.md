# Agent Note: Quorum-authorized rooms over the Agent Teams roster

Status: implemented

English | [中文](2026-09-17-multi-model-rooms.zh.md)

## Problem

Agent Teams coordinates work: a Lead delegates to named teammates, a durable mailbox carries peer messages, and a shared task board tracks ownership. It has no concept of a shared conversation, and it settles nothing collectively. Every durable outcome is one member's decision: a task owner completes its own task, and the Lead alone assigns, reassigns, and interrupts.

A deployment that wants several models to reason about one question has the opposite requirement. Participants must read what the others said, and no participant may carry a conclusion alone. Two facts about the runtime shape the answer. A Session log holds exactly one derived message history, and the agent loop requires every request's messages to equal that history, so several models cannot write one conversation. A continuable child's Agent is live only while it runs, so a peer cannot be handed context by addressing a live Agent.

## Decision

`TeamRoom` extends the Agent Teams service with an attributed transcript and collective decisions over the same Lead Session log it already owns. Room behavior is opt-in through `roomEnabled`, which defaults to `false`; when it is off the service records no room events and every room operation refuses with `TEAM_ROOM_DISABLED`, so a composition that does not ask for a room keeps today's behavior and log.

The transcript is a derivation, not a second store. A `TeamRoom` observer reads each participant's committed `assistant/message` and appends one `room/message` carrying only the author identity and the assistant's text blocks. Names stay in the roster, so attribution has one home. `room/message`, `room/proposal`, and `room/review` are log-only events: they never enter derived model history, which keeps the loop's "model-visible means logged" invariant intact without widening the surface.

Participants are the roster itself. A member is a participant from the moment provisioning records it until it fails, which is the same rule `TeamRoster.tryMembership` already uses to resolve a live member's Team identity, so one rule decides who may act and who counts toward quorum.

Speaking does not wake peers. `roomPrompt` gives one participant the floor by sending it the transcript entries recorded after its own last utterance, bounded by `roomTranscriptWindow`, followed by the caller's instruction. Because a participant's own last utterance always follows everything it was shown, that boundary needs no extra bookkeeping, and an inactive participant needs no live Agent: the durable mailbox cold-resumes it. A room therefore advances only when the human or a participant grants the floor, which bounds cost by construction rather than by prompt discipline.

Work is verified by peers, not by its author. A task owner uses `submit` to hand the current revision over, the view derives `verifying` from a submission with no verdict, and only another member's `verify` verdict carries the work to `completed` or returns it with the objection recorded. The durable task union therefore keeps its committed variants and the awaiting state needs no stored transition.

A decision settles only by quorum. `room-quorum.ts` computes the outcome from recorded reviews alone: every eligible reviewer is a participant other than the proposer, and acceptance requires that all of them have voted, at least `roomApprovalRatio` of them approved, and no rejection stands. Rejections settle a decision as soon as they reach the same threshold. The service exposes no operation that forces an outcome, a proposer cannot review its own decision, a settled decision is final, and `roomEscalate` hands an unresolved decision to the human instead. `roomMaxProposalRevisions` bounds how many times a proposer may carry a revised statement back before the decision must escalate. The chair, which rotates with transcript length, grants no authority: it exists to name who the deployment should call on next, and every participant votes under the same rule. The human can do the same three things a participant can: `roomPrompt`, `roomPropose`, and `roomEscalate` let the browser panel grant the floor, put a statement to the room, and hand an unresolved decision to the human, each delegating to the same service operation the model-facing tool calls. The panel records no standing: a review belongs to the participant that owns the verdict, and each recorded standing carries its reviewer's reason and is visible to every participant, because accountability needs the objection itself rather than only the count against it. A process-local `room/updated` notification fires at every commit, and one Remote stream republishes the complete view after each one plus every live text chunk, so a reader shows deliberation as it happens while the durable log stays the single source of truth.

Silence is a per-reviewer observation, not one wall-clock deadline. Opening a revision asks every eligible reviewer and starts that reviewer's window of `roomReviewGraceMs`; the window is held by the reviewer's own work — a durable event from its own turn, including one committed while the room was already waiting, or a live `agent/assistant-stream` frame — and never by the room's records, which the Lead Session holds for every actor and which would otherwise credit the Lead with its peers' work. A reviewer whose window lapses is named in a durable `room/review-timeout` record and reminded at most `roomReviewReminders` times; each reminder restarts the window of the reviewer it reaches and never addresses the Lead, whose own silence is the human's to resolve. The decision escalates only once every reviewer still owing a standing has exhausted its window, and the escalation names them, so a slow model's decision reaches the human instead of a standing the room invented.

## Alternatives considered

**Extend `Agent.steer` into a broadcast.** Rejected because waking every peer on every utterance produces an unbounded autonomous loop whose cost no configuration can bound, and because the recipient's Agent may not be live. Handing each request the transcript it has not seen makes the recipient's own history the boundary.

**Relay peer output through the durable mailbox as it arrives.** Rejected as the primary mechanism: every utterance would be duplicated once per target in the Lead log, ordering would follow mailbox queue order rather than conversation order, and the proposer's own committed turn — which is not a mailbox send — would be missing from the transcript.

**Escalate on a fixed wall-clock deadline.** Rejected because elapsed time cannot tell a model that is thinking from one that is stuck: one slow provider would decide the outcome by discarding a participant that was still working. Observing each reviewer's own activity keeps a streaming or freshly committed turn inside its window, and the bounded reminders give a quiet reviewer a chance to answer before the human is asked.

**Settle decisions by a Lead or moderator.** Rejected because it reproduces the single-authority problem the room exists to solve. The chair rotates and carries no vote weight, and an unreachable quorum escalates instead of resolving.

**Store participants and roles as their own durable records.** Rejected because the roster already owns member identity, provisioning, and recovery. A second record would have to be reconciled with the first, and the room adds no property the roster does not already carry.

**Force a verdict with an explicit override.** Rejected: an override would make every acceptance claim unverifiable. A blocked decision reaches the human through `roomEscalate`, and the durable record keeps the split visible.

**Enable rooms in the default composition.** Rejected because a default-on transcript adds durable records to every Agent Teams session and would change log and snapshot expectations for deployments that never wanted a room.

## Testing

`room-quorum.spec.ts` covers the quorum arithmetic: the approval threshold across reviewer counts, latest-standing selection per reviewer and revision, the open state while a reviewer has not voted, acceptance, rejection at quorum, rejection once everyone has voted, and a unanimous quorum that a single rejection defeats.

`room.spec.ts` covers the engine through a real Loader composition with two model routes: attributed transcript entries, the unseen-transcript boundary in a delivered prompt, self-prompt refusal, refusal when rooms are disabled, `room/stream` attribution, a turn that produces no text, a provider-owned subagent that is not a participant, a prompt before anyone has spoken, an unknown target, deployment-limit validation, and the full decision path — quorum acceptance, quorum rejection, self-review, stale revision, unknown decision, revision reopening, the revision limit, escalation, the outcome notice, and chair rotation.

`room-projection.spec.ts` covers the fold: duplicate transcript identity, foreign room identity, first-revision rules, in-place settlement, refusal to change a final decision, proposer and statement immutability, reopening only through the next revision, review placement, and identity allocation including a saturated id.

Producing the Desktop `.app` needs release credentials: every macOS packaging path validates the notary environment, and `DSH_ADHOC_SIGN=1` selects an adhoc signing identity without excusing notarization, so the shipped pipeline cannot emit an unsigned local build. The room reaches the packaged application through `apps/cli`'s dependency closure rather than through any packaging-specific step, and no local packaging run verifies it.

The shipped CLI was also exercised end to end: `agent-room-profile` installed into a profile with `dsh plugin add`, then one task asked the Lead to seat two teammates on different models and put a decision to them. The binary composed the room, the models called the room tools, and the decision settled with two independently written rejections. A decision settled before every reviewer voted reports no `awaiting` names, because a reviewer that never voted cannot change an outcome quorum already reached.

`room.e2e.ts` certifies the live path against the shipped DeepSeek route. It seats one participant on `deepseek-v4-flash` and another on `deepseek-v4-pro`, asserts both streamed into the room on their own routes, puts a contestable statement to them, and waits for the peer model's own turn to settle the decision. It then re-reads the persisted log and requires a recorded verdict with a non-empty reason. It self-skips without a credential in the environment or the harness-home store.

`room-vendors.spec.ts` seats one room across three vendor adapters without credentials: the native DeepSeek adapter speaking chat-completions, a pi-ai `anthropic-messages` route, and a pi-ai `openai-completions` route, each behind its own local stand-in endpoint. It requires each peer's utterance in the shared transcript to be the text its own vendor returned, each peer's recorded standing to arrive through `room_review` on that peer's own route, both reasons to survive into the decision view, and the settling notice to wake the DeepSeek Lead on the third route. Real vendor endpoints remain unverified until credentials exist; the room's routing, attribution, and quorum are proven across adapters without them.

`agent-room-panel.e2e.ts` certifies the panel in an assembled browser: it boots the Host and Web application over the room profile layer, which also carries the Team browser UI, records a decision and a peer utterance in the Session, and asserts the rendered transcript, the decision phase, the named rejection, and the absence of awaiting reviewers, then compares a stable ARIA snapshot. That run is the only evidence that the panel renders through the real Remote flow rather than only against a stubbed one.

`team-action.client.spec.tsx` and `browser-plugin.client.spec.ts` cover the panel: rendered transcript and decisions, every decision phase label, an empty room, a room load failure reported beside a healthy roster, and the `agentTeams/room` call the mount lifecycle makes.

`tool-room.spec.ts` covers the model-facing surface over a real Loader composition: scoped installation and its removal across plugin HMR, rollback after a same-scope collision, direct-apply defaults, a decision settled by tool calls the proposer's own model turn made, refusal results for self-review, stale revisions, unknown decisions, self-prompts, a provider-owned subagent, floor grant carrying only the transcript the target has not seen, transcript window clamping, two participants streaming concurrently, and a transcript and decision replayed from the persisted log.

## Consequences

The Lead Session grows with whole transcript entries. Text blocks are copied rather than referenced, so a long room costs durable bytes proportional to what its participants said, and the model pays only for the unseen window each time it is given the floor.

Rooms reuse the Team roster, so they inherit its constraints: one process, one shared checkout, a flat immutable roster, and no cross-process exactly-once delivery. A member cannot be in a room without also being on the roster, and a failed member stops counting toward quorum, which can make a previously unreachable quorum reachable.

A room is only interesting when its participants actually differ, so `SpawnTeammateRequest` accepts the subagent seam's `agentOptions`, and `spawn_teammate` exposes `provider`, `model`, and `reasoning_effort`. The teammate's resulting route stays durable in its own Session header, which is where the route was already recorded; the roster's `model` column reports it while the participant is live. A route that does not declare the requested reasoning effort is refused before any child exists, against the teammate's effective route rather than only an explicitly named one. Validating late instead let the child fail its first request: that surfaced as a durability failure, named the wrong cause, and permanently consumed the teammate's name.

The room ships with the installation rather than only existing in the repository: `agent-room-profile` is named in the launcher's `OPTIONAL_BUNDLES` and is a runtime dependency of `apps/cli`, so the Plugins page offers it and the Desktop production closure contains it. No shipped profile enables it, because a room changes what its participants' turns mean, and the guard that keeps experimental packages out of the default product stays satisfied by that declaration pair.

Reading a room is total while writing one is guarded. A composition without rooms answers `roomView` with `enabled: false` and empty collections instead of refusing, because an unsupported surface is a state a panel renders, not a failure it reports. That distinction had to become explicit: mounting the room reader beside a plain Team composition otherwise showed a room error, and later an empty room section, where a deployment simply has no room. Every mutating operation still refuses with `TEAM_ROOM_DISABLED`, so nothing can be recorded into a room that is not mounted.

The room reaches a human through the existing Agent Teams panel rather than a new surface: `@deepseek-ai/dsh-experimental-client-ui-agent-team` reads `RoomRemoteView` through the generated Remote API and renders the transcript and the decision board beside the roster. One panel already owns Team state, and a second panel would have split one room's roster from its decisions.

A room is only useful once its participants can act on it, so the model-facing surface ships as its own package rather than inside `agent-team`. `@deepseek-ai/dsh-experimental-tool-agent-room` installs five scoped tools — view, prompt, propose, review, escalate — plus the co-accountability policy, following the scoped-installation lifecycle `@deepseek-ai/dsh-experimental-tool-agent-team` already established. Every tool delegates to the service, so the tool surface adds no authority the operations do not already carry.

One consequence of scoped installation is worth stating: installation follows membership at Agent creation, which precedes a provider-owned child's descriptor, so such a child can receive the tools before the roster stops recognizing it. The authority check inside each operation refuses it, which is the enforcement point; installation is not.
