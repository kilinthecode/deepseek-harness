# Agent Teams

[English](agent-team.md) | 中文

实验性隐式 Root Team 领域、模型工具与宿主适配器共享的类型。[Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、task 与共享 checkout 决策；本页记录 [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts) 中的持久与客户端可见形式。

## 身份与 roster

`TeamId` 是具有独立[品牌](core.zh.md#branded-ids)的 Root `SessionId`。`TeamTaskId` 在 Team 内按 `task-<n>` 单调分配；`TeamMessageId` 是全局随机值。teammate 的 Session id 始终是持久身份，而 `name` 是不可变的模型／UI 标签。

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

每个 member 都从 `provisioning` 开始，并且只到达一个终态 roster phase：`active` 或 `failed`。roster 的 `running`／`inactive` 状态单独派生，绝不会重写该记录。`agentProvider` 与 `agentModel` 记录该 teammate 解析后的路由，因此当该 teammate 的 Agent 不存活时，roster 行与房间参与者仍会报告它就座时使用的模型。

## 持久 mailbox

Lead Session 首先存储完整 queued message。只有 target 的 pending inbox 条目或已记录用户消息完成持久化，才会写入独立 acknowledgement event，queued-minus-delivered 因而构成恢复 mailbox。

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

每条消息都会尝试 Steer 投递。running target 在最近的步骤边界收到消息，inactive target 在已加载时启动一个轮次，否则冷恢复。调用方不能选择其他模式，因此持久记录不存储调度方式。

target Session 会在 pending inbox 条目和最终用户消息上保留消息身份与发送者归因。跨 inbox 与历史折叠该 source 构成 target 侧去重键；模型可见的 framing 会重复 id 和发送者。

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

## 共享任务 DAG

每条 task event 都存储完整快照。`revision` 是 compare-and-set 值，每次变更递增 1。`blockedBy` edge 必须指向未删除任务，并维持无环图。`writeScopes` 是规范化的提示性路径前缀，不是锁。

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

`pending` 表示尚未开始或已经释放，`in_progress` 携带 owner，`completed` 满足 blocker，`deleted` 是保留的 tombstone。view 会添加 owner name、readiness 和 write-scope 重叠警告，但不会改变持久快照。

<a id="web-projection"></a>

## Web 投影

Lead Session 通过 `SessionProjectionMap.agentTeam` 发布持久 roster 行与未删除任务视图。`failure` 在最后有效状态旁报告被拒绝的持久记录。成员活动来自 Session 状态；模型标签来自各成员的 `modelSelection` 投影。已提交但仍在等待裁决的 revision 在任务视图中报告为 `verifying`；同行记录裁决后，`verification` 给出验证者、裁决与理由。

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

该投影不携带任何 room 状态。room 视图依赖实时参与者状态、配置的 quorum 计算与流式文本，因此面板通过下文列出的 room Remote method 读取它们。

<a id="shared-room"></a>
## 共享 room

room 让同一个 Team 成为一场审慎的对话。Lead Session 保存所有参与者发言的带署名 transcript，每个集体决策只由记录在案的 quorum 结清，任何单个成员都无法独自决定。

room 行为是可选的：`roomEnabled` 默认为 `false`。关闭时服务不记录任何 room event，所有 room 操作都以 `TEAM_ROOM_DISABLED` 拒绝，Agent Teams 行为保持不变。

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

`RoomMessageId` 标识一条 transcript entry；`RoomProposalId` 属于 room 本地，按 `proposal-<n>` 分配。reviewer 改变立场会追加一条记录，因此 fold 对每个 reviewer 和 revision 保留最新 verdict。

参与者就是 Team roster 本身：Lead 加上每个尚未失败的成员。成员从 provisioning 记录它的那一刻起就是参与者，与 roster 解析在线成员 Team 身份所用规则一致。读取 room 是全函数：没有 room 的组合会报告 `enabled: false` 与空集合，而不是失败；而每个会写入的 room 操作仍然以 `TEAM_ROOM_DISABLED` 拒绝。`RoomView` 暴露该标志、roster、transcript、决策与轮转 chair；`RoomPromptRequest` 与 `RoomPromptResult` 描述把发言权交给某个参与者，`ProposeRoomDecisionRequest`、`ReviewRoomDecisionRequest`、`EscalateRoomDecisionRequest` 描述决策操作，`RoomStreamFrame` 在 `room/stream` event 上承载一个参与者的实时 frame。`RoomParticipantView.quiet` 报告某个在线参与者在 `roomReviewGraceMs` 内没有产生任何被观察到的工作，用的正是停滞巡检所读的同一个窗口；`roomStream` 通过 Remote face 跟随一个 room：先收到完整 view，随后在每次已提交变化后收到新的 view，并为参与者流式输出的每个 text chunk 收到一帧。`PanelRoomPromptRequest`、`PanelProposeRoomDecisionRequest` 与 `PanelEscalateRoomDecisionRequest` 承载浏览器面板对这些同一操作的调用。

接受需要每个有资格的 reviewer 都已投票、其中至少 `roomApprovalRatio` 比例批准，且没有任何反对成立。proposer 不能 review 自己的决策，已结清的决策是最终的，被拒绝的决策只能通过把修订后的 statement 重新提交给 room 来解决。chair 随 transcript 轮转，不携带任何决策权。reviewer 的沉默依据该参与者自身被观察到的工作衡量，绝不依据 room 自身的记录：请求会启动 `roomReviewGraceMs` 窗口，至多 `roomReviewReminders` 次提醒各自重启被提醒者的窗口，只有当所有仍欠 standing 的 reviewer 都用尽窗口后决策才升级，并把它们记入 `room/review-timeout`，绝不编造从未收到的 standing。每条已记录的立场都带有其 reviewer 的理由并对整个 room 可见。共享工作遵循同一规则：任务 owner 提交当前 revision，只有另一位成员带理由的 `verify` 裁决才会把它推进到 `completed`，而折叠会拒绝任何验证无法成立的记录。

## 回放

`agentTeam` Session 投影把一个 Root Session 回放成每个 Team 操作所读取的 roster、任务板、queued-minus-delivered mailbox 以及 room transcript 与决策。它按 `TeamId` 选取记录，因此普通 fork 继承的 event 保留 ancestor id，绝不会进入新 Root 的状态。Session event 的 `seq` 与 `time` 继续负责顺序和时间记录，Team snapshot 不再重复保存它们。roster 与 task 读取以 view 形式到达调用方，而 pending 邮件仅供投递与恢复内部使用。包 [README](../../packages/experimental/agent-team/README.zh.md)负责 operation、authorization、recovery 和限制行为。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

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
