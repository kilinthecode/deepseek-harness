# Agent Teams

English | [中文](agent-team.zh.md)

Types shared by the experimental implicit-root Team domain, model tools, and host adapters. The [Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns identity, mailbox, task, and shared-checkout decisions; this page records the durable and client-visible forms from [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts).

## Identity and roster

`TeamId` is the root `SessionId` under a distinct [brand](core.md#branded-ids). `TeamTaskId` is Team-local and monotonically allocated as `task-<n>`; `TeamMessageId` is globally random. A teammate's Session id remains its persistent identity, while `name` is an immutable model/UI label.

```ts type-equiv
/** Whole durable value written on every teammate lifecycle change. */
interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  /**
   * Resolved child `agentOptions.provider` for this teammate. A teammate holds
   * no live Agent between turns, so the roster reads its route here instead of
   * reporting the Lead's route. Absent for a member recorded before this field
   * existed or resolved without a provider.
   */
  readonly agentProvider?: string
  /** Resolved child `agentOptions.model`, recorded on {@link agentProvider}'s terms. */
  readonly agentModel?: string
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

Every member starts in `provisioning` and reaches exactly one terminal roster phase, `active` or `failed`. Roster `running`/`inactive` status is derived separately and never rewrites this record. `agentProvider` and `agentModel` record the teammate's resolved route, so a roster row or room participant still reports the model it was seated on while that teammate's Agent is not live.

## Durable mailbox

The Lead Session first stores the complete queued message. A target receipt is acknowledged only after its pending inbox item or recorded user message is durable, leaving queued-minus-delivered as the recovery mailbox.

```ts type-equiv
/** One peer message retained until its target Session records it. */
interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}
```

Every message attempts Steer delivery. A running target receives it at the nearest step boundary; an inactive target starts a turn if loaded or cold-resumes otherwise. Scheduling is not stored in the durable record because callers cannot select another mode.

The target Session keeps message identity and sender attribution on both the pending inbox item and the eventual user message. Folding that source across inbox and history is the target-side de-duplication key; the model-visible framing repeats the id and sender.

```ts type-equiv
/** Source retained by the target Session for durable mailbox de-duplication. */
interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}
```

## Shared task DAG

Every task event stores a complete snapshot. `revision` is the compare-and-set value and increments by one per mutation. `blockedBy` edges must name non-deleted tasks and keep the graph acyclic. `writeScopes` are normalized advisory path prefixes rather than locks.

```ts type-equiv
/** Whole durable task snapshot; every mutation increments {@link revision}. */
interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  /** Submission and peer verdict, present once the task leaves its owner's hands. */
  readonly verification?: TeamTaskVerification
}
```

`pending` is unstarted or released, `in_progress` carries an owner, `completed` satisfies blockers, and `deleted` is a retained tombstone. Views add owner name, readiness, and write-scope overlap warnings without changing the durable snapshot.

<a id="web-projection"></a>

## Web projection

The Lead Session publishes `SessionProjectionMap.agentTeam` with durable roster rows and non-deleted task views. `failure` reports a rejected persisted record beside the last valid state. Member activity comes from Session status; model labels come from each member's `modelSelection` projection. A task view reports `verifying` for a submitted revision that awaits its verdict, and `verification` names the verifier, verdict, and reason once a peer records them.

```ts type-equiv
/** One durable roster row published through the `agentTeam` Session projection. */
interface TeamMemberProjection {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  /** Durable lifecycle; the Lead row is always `active`. Turn activity comes from Session status. */
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

```ts type-equiv
/** Runtime-enriched task view returned to tools and hosts. */
interface TeamTaskView {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskViewStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
  /** Submission and peer verdict, present once the task leaves its owner's hands. */
  readonly verification?: TeamTaskVerificationView
}
```

```ts type-equiv
/**
 * Durable Team state published to browser clients through the Lead Session's
 * `agentTeam` projection. `failure` names the first rejected persisted Team
 * record; members and tasks then stay at the last valid state.
 */
interface TeamProjection {
  readonly members: TeamMemberProjection[]
  readonly tasks: TeamTaskView[]
  readonly failure?: string
}
```

The projection carries no room state. Room views depend on live participant status, configured quorum arithmetic, and streamed text, so the panel reads them through the room Remote methods listed below.

<a id="shared-room"></a>
## Shared room

A room turns the same Team into a deliberative conversation. The Lead Session owns an attributed transcript of every participant utterance, and each collective decision is settled only by the recorded quorum, never by any single member.

Room behavior is opt-in: `roomEnabled` defaults to `false`. When it is off, the service records no room events and every room operation refuses with `TEAM_ROOM_DISABLED`, leaving Agent Teams behavior unchanged.

```ts type-equiv
/** One attributed utterance in the shared room transcript. */
interface RoomMessageSnapshot {
  readonly id: RoomMessageId
  readonly authorId: SessionId
  readonly content: ContentBlock[]
}
```

```ts type-equiv
/**
 * One collective decision. Every revision is a complete snapshot, so the fold
 * never reconstructs a proposal by replaying edits.
 */
interface RoomProposalSnapshot {
  readonly id: RoomProposalId
  /** Revision number, starting at one and incrementing per superseding statement. */
  readonly revision: number
  readonly proposerId: SessionId
  /** The exact statement every reviewer is asked to accept or reject. */
  readonly statement: string
  readonly phase: RoomProposalPhase
}
```

```ts type-equiv
/**
 * One participant's verdict on one proposal revision. A reviewer changing its
 * standing appends a new record; the fold keeps the latest per reviewer.
 */
interface RoomReviewSnapshot {
  readonly proposalId: RoomProposalId
  readonly proposalRevision: number
  readonly reviewerId: SessionId
  readonly verdict: RoomReviewVerdict
  /** Why the reviewer chose this verdict; shown to the proposer on settlement. */
  readonly reason: string
}
```

`RoomMessageId` identifies one transcript entry; `RoomProposalId` is room-local and allocated as `proposal-<n>`. A reviewer changing its standing appends another record, so the fold keeps the latest verdict per reviewer and revision.

Participants are the Team roster itself: the Lead plus every member that has not failed. A member is a participant from the moment provisioning records it, matching the rule the roster uses to resolve a live member's Team identity. Reading a room is total: a composition without rooms reports `enabled: false` and empty collections rather than failing, while every mutating room operation still refuses with `TEAM_ROOM_DISABLED`. `RoomView` exposes that flag, the roster, the transcript, the decisions, and the rotated chair; `RoomPromptRequest` and `RoomPromptResult` describe giving one participant the floor, `ProposeRoomDecisionRequest`, `ReviewRoomDecisionRequest`, and `EscalateRoomDecisionRequest` describe the decision operations, and `RoomStreamFrame` carries one live participant frame on the `room/stream` event. `RoomParticipantView.quiet` reports a live participant that produced no observed work within `roomReviewGraceMs`, the same window the stall sweep reads, and `roomStream` follows one room through the Remote face: the complete view first, then a view after every committed change and a frame for every text chunk a participant streams. `PanelRoomPromptRequest`, `PanelProposeRoomDecisionRequest`, and `PanelEscalateRoomDecisionRequest` carry the browser panel's own calls to those same operations.

Acceptance requires every eligible reviewer to have voted, at least `roomApprovalRatio` of them to approve, and no standing rejection. A proposer cannot review its own decision, a settled decision is final, and a rejected one is resolved only by carrying a revised statement back to the room. The chair rotates with the transcript and carries no decision authority. A reviewer's silence is measured from that participant's own observed work, never from the room's records: the ask starts a window of `roomReviewGraceMs`, each of at most `roomReviewReminders` reminders restarts the window of the reviewer it reaches, and a decision escalates only once every reviewer still owing a standing has exhausted its window, naming them in `room/review-timeout` without inventing the standing it never received. Every recorded standing carries its reviewer's reason and is visible to the whole room. Shared work follows the same rule: a task owner submits the current revision, only another member's `verify` verdict with a reason carries it to `completed`, and the fold refuses any record whose verification cannot be true.

## Replay

The `agentTeam` Session projection replays one root Session into the roster, task board, queued-minus-delivered mailbox, and room transcript and decisions that every Team operation reads. It selects records by `TeamId`, so events inherited by an ordinary fork retain the ancestor id and never enter the new root's state. Session event `seq` and `time` remain the ordering and timing record; Team snapshots do not duplicate them. Roster and task reads reach callers as views; pending mail stays internal to delivery and recovery. The package [README](../../packages/experimental/agent-team/README.md) owns operation, authorization, recovery, and limit behavior.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
/**
 * Resolve one exact live Agent's Team role.
 * @param agent - exact live Agent used as the authority credential.
 * @returns its root, Team identity, role, and model-facing name.
 */
membership(agent: Agent): TeamMembership

/**
 * List the runtime-enriched roster visible to one Team member.
 * @param agent - exact live Team member.
 * @returns Lead and teammate rows in creation order.
 */
listMembers(agent: Agent): TeamMemberView[]

/**
 * Create one named, continuable direct child of the Team Lead.
 * @param caller - exact live Lead Agent.
 * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
 * @returns the active roster row.
 */
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>

/**
 * Queue one durable peer message, then attempt immediate delivery.
 * @param caller - exact live sending Team member.
 * @param request - target name, content, and pre-queue cancellation.
 * @returns durable message identity and immediate-delivery observation.
 */
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>

/**
 * Create one unowned pending task in the Team Lead log.
 * @param caller - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task view.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Return one task, including a deleted tombstone.
 * @param caller - exact live Team member reading the task.
 * @param id - Team-local task identity.
 * @returns the latest task value and derived readiness diagnostics.
 */
getTask(caller: Agent, id: TeamTaskId): TeamTaskView

/**
 * List current non-deleted tasks in numeric creation order.
 * @param caller - exact live Team member reading the board.
 * @returns detached current task views.
 */
listTasks(caller: Agent): TeamTaskView[]

/**
 * Compare-and-set one authorized task transition.
 * @param caller - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns the committed next task revision.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Wait for the next Team-domain or member-status change.
 * @param caller - exact live Team member waiting for activity.
 * @param timeoutMs - bounded wait duration from ten seconds through one hour.
 * @param signal - caller cancellation for the wait only.
 * @returns one observed change or a timeout result.
 */
async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>

/**
 * Interrupt one live teammate turn without clearing its pending inbox.
 * @param caller - exact live Lead Agent.
 * @param targetName - durable teammate name.
 * @returns the target status sampled before cancellation.
 */
interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' }

/**
 * Resolve a caller without throwing, used by scoped-tool installation and observers.
 * @param agent - candidate exact live Agent.
 * @returns Team membership, or undefined for non-Team subagents and stale identities.
 */
tryMembership(agent: Agent): TeamMembership | undefined

/**
 * Give one room participant the floor, carrying the conversation it has not seen.
 * @param caller - exact live Team member granting the floor.
 * @param request - target name, instruction, and cancellation.
 * @returns durable message identity and immediate-delivery observation.
 */
async roomPrompt(caller: Agent, request: RoomPromptRequest): Promise<RoomPromptResult>

/**
 * Put one collective decision to the room and ask every eligible reviewer to settle it.
 * @param caller - exact live Team member proposing the decision.
 * @param request - statement, optional superseded decision, and cancellation.
 * @returns the new revision with its quorum arithmetic.
 */
async roomPropose(caller: Agent, request: ProposeRoomDecisionRequest): Promise<RoomProposalView>

/**
 * Record one participant's standing on one decision revision.
 * @param caller - exact live Team member reviewing the decision.
 * @param request - decision identity, revision, verdict, reason, and cancellation.
 * @returns the decision with its recomputed quorum arithmetic.
 */
async roomReview(caller: Agent, request: ReviewRoomDecisionRequest): Promise<RoomProposalView>

/**
 * Hand one unresolved decision to the human.
 * @param caller - exact live Team member escalating the decision.
 * @param request - decision identity, reason, and cancellation.
 * @returns the escalated decision.
 */
async roomEscalate(caller: Agent, request: EscalateRoomDecisionRequest): Promise<RoomProposalView>

/**
 * Read the room roster, transcript, and decision board.
 * @param caller - exact live Team member reading the room.
 * @returns detached current room views.
 */
roomView(caller: Agent): RoomView

/**
 * Read the current room through the generated Remote API.
 * @param agent - exact live Team member used as the authority credential.
 * @returns the room roster, rendered transcript, and decision board.
 */
@Remote('room') remoteRoom(agent: Agent): RoomRemoteView

/**
 * Follow one room through the generated Remote API.
 * @param agent - exact live Team member used as the authority credential.
 * @param signal - cancellation owned by the Remote stream carrier.
 * @returns a complete view first, then a view after every committed room
 *   change and a frame for every text chunk a participant streams.
 */
@Remote({ mode: 'stream' }) async *roomStream(agent: Agent, signal: AbortSignal): AsyncIterable<RoomFollowFrame>

/**
 * Give one participant the floor through the generated Remote API.
 * @param agent - exact live Team member granting the floor.
 * @param request - target name and the instruction to deliver.
 * @returns durable message identity and immediate-delivery observation.
 */
@Remote('roomPrompt') remoteRoomPrompt(agent: Agent, request: PanelRoomPromptRequest): Promise<RoomPromptResult>

/**
 * Put one decision to the room through the generated Remote API.
 * @param agent - exact live Team member proposing the decision.
 * @param request - the exact statement reviewers are asked to settle.
 * @returns the opened revision with its quorum arithmetic.
 */
@Remote('roomPropose') remoteRoomPropose(agent: Agent, request: PanelProposeRoomDecisionRequest): Promise<RoomProposalView>

/**
 * Hand one unresolved decision to the human through the generated Remote API.
 * @param agent - exact live Team member escalating the decision.
 * @param request - decision identity and why it cannot settle without a human.
 * @returns the escalated decision with its recorded votes.
 */
@Remote('roomEscalate') remoteRoomEscalate(agent: Agent, request: PanelEscalateRoomDecisionRequest): Promise<RoomProposalView>
```

Types: [Agent](core.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)

<a id="room-events"></a>

### `room/*` events

<a id="roomstream--emit"></a>

#### `room/stream` — emit

One room participant produced a live assistant stream frame. This is a process-local observation of an in-flight turn; the durable record is the participant's own `assistant/message` and the room transcript. A room opens with its Team's first teammate, so a Lead without one emits none.

```ts cordis-catalog
/**
 * One room participant produced a live assistant stream frame. This is a
 * process-local observation of an in-flight turn; the durable record is the
 * participant's own `assistant/message` and the room transcript. A room
 * opens with its Team's first teammate, so a Lead without one emits none.
 * @param payload.teamId - Team identity of the room the participant belongs to.
 * @param payload.participantId - Session identity of the speaking participant.
 * @param payload.participantName - Model-facing participant name.
 * @param payload.frame - The participant's live stream frame.
 * @mode emit
 */
'room/stream'(payload: RoomStreamFrame): void
```

Source: [`packages/experimental/agent-team/src/room.ts`](../../packages/experimental/agent-team/src/room.ts)

<a id="roomupdated--emit"></a>

#### `room/updated` — emit

One room committed a change to its own log: a transcript entry, a decision, a revision, a review, or a deadline record. A live reader re-reads the room after it, and the durable record is the appended event.

```ts cordis-catalog
/**
 * One room committed a change to its own log: a transcript entry, a
 * decision, a revision, a review, or a deadline record. A live reader
 * re-reads the room after it, and the durable record is the appended event.
 * @param payload.teamId - Team identity of the room that changed.
 * @mode emit
 */
'room/updated'(payload: { readonly teamId: TeamId }): void
```

Source: [`packages/experimental/agent-team/src/room.ts`](../../packages/experimental/agent-team/src/room.ts)
<!-- END GENERATED cordis-surface -->
