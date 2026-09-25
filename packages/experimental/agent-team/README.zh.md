---
description: "在一个会话中运行一个小型具名 agent（智能体）团队：成员之间的持久消息与共享任务板，用于组合实验性 Team 插件的部署。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-team` 把一个编码会话变成一个小型工作团队：会话中的 agent 成为 Lead，创建具名 teammate 处理委派的工作，与它们交换持久消息，并在公共任务板上跟踪共享任务。消息与任务状态能挺过崩溃、reload 与中断，因此离线的 teammate 会在恢复后收到排队的消息。开启 `roomEnabled` 后，同一个 roster 还会作为审慎的 room 运行：所有发言汇入一份带署名 transcript，集体决策只由记录在案的 quorum 结清，任何成员都无法独自决定。它本身不提供任何工具——请挂载兄弟包 `dsh-experimental-tool-agent-team`。它以实验性名称公开发布、不承诺稳定性。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当一个 agent 应该在自己的工作目录中运行一支小型具名助手团队、且消息与任务状态需要挺过崩溃与重启时，把本包加入组合。它本身不带工具：请与 `@deepseek-ai/dsh-experimental-tool-agent-team` 一起挂载，让模型能够创建 teammate、给它们发消息并使用任务板。

### 何时选择

当多个 agent 必须在同一个共享工作区协作、且 roster、消息与任务状态需要挺过崩溃与重启时，选择它。当 teammate 需要独立工作目录、多个进程需要协调同一支团队、或任务 owner 需要自动释放时，请不要选择——这些都不受支持。团队功能需要持久会话存储才能激活。

### 最小工作配置

<a id="smallest-working-setup"></a>

对现有组合的最小增量是持久会话存储加两个 Team 包：

```yaml
# smallest team setup — durable storage plus both Team packages
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

工具安装后，模型会按请求完成其余工作——例如先「创建一个名为 reviewer 的 teammate 检查 diff」，再「把变更摘要发给 reviewer」。所有限制都是可选的，并在启动时校验：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxMembers` | `16` | 一支团队最多可创建的 teammate 数，包括失败的 |
| `maxTasks` | `256` | 任务板上最多的活动任务数 |
| `maxPendingMessagesPerMember` | `64` | 单个成员最多可排队的消息数 |
| `maxMessageBytes` | `65,536` | 单条发送消息的最大尺寸 |
| `disposalTimeoutMs` | `5,000` | 关闭清理允许的时间 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。

### Teammate

请 Lead 创建 teammate：给它一个唯一的小写名字（例如 `reviewer`）并描述其职责。teammate 可以 fresh 启动（不携带 Lead 对话的任何记忆），也可以作为 fork 启动（继承 Lead 已完成的轮次）；创建请求决定用哪种。teammate 名字是永久的——即使创建失败的 teammate 也保留其名字，任何名字都不会被复用。

roster 显示每个成员的职责（`lead` 或 `teammate`）与当前状态：`running`、`inactive`（当前没有执行轮次，包括已加载和仅存储的成员）、`provisioning` 或 `failed`。未加载的成员会在唤醒后收到其消息。每行还会报告该成员运行的模型：即其 `team/member` 记录中记录的路由，因此 inactive teammate 仍会报告它就座时使用的模型。

只有 Lead 可以创建 teammate 或中断它们。

### teammate 之间的消息

任何成员都可以向任何其他成员或 Lead 发送消息。live 成员会立即收到；离线成员的消息会排队，并在其恢复后到达。消息不会丢失，也不会重复投递。

每条消息都使用 Steer：running target 在最近的步骤边界收到消息，inactive target 在已加载时启动一个轮次，否则冷恢复。发送方始终能看到结果——target inbox 已接受，或在投递暂时不可用时保留为 queued。排队的消息已经安全存储，因此绝不能重发。

### 共享任务板

任何成员都可以添加任务，包含标题、详情、对其他任务的可选依赖，以及可选的文件触及提示。只有其全部依赖完成后，任务才可 claim。

任务有 owner：成员 claim 任务开始工作、把完成的成果提交验证、释放回板或重新打开；Lead 可以把任务分配给任意成员。没有任何成员能结清自己的工作：`submit` 把当前 revision 交给同行，视图随后报告 `verifying`，只有另一位成员的 `verify` 裁决及其理由才会把任务推进到 `completed`，或连同反对意见退回。提交等待裁决期间，任务不能被编辑、改动依赖、释放、重新分配或删除；owner 一旦变更，之前的裁决随之清除，下一位 owner 的提交需要新的裁决。每次变更都是 compare-and-set：基于过期副本的更新会被拒绝，因此两个成员不会悄悄覆盖彼此的成果。

任务板会唤醒下一步取决于该变更的成员：teammate 的 `submit` 会通知 Lead，以便它请一位同行验证；`verify` 会把裁决及其理由通知 owner。两类通知都是持久 mailbox 消息，因此处于轮次中的成员会在下一个步骤读到，而 inactive 的 owner 会在下次运行时读到。

当两个 in-progress 任务计划触及重叠路径时，文件提示会产生警告——它们绝不阻止任何操作。已删除任务保留在历史中，但从活动列表中消失。

### 等待与中断

成员可以等待下一次团队变化——teammate 的状态、新消息或任务更新——而不必反复轮询；等待只报告是否超时，调用方随后重新读取当前状态。

Lead 可以停止 teammate 的当前轮次，而不会删除其排队的消息；任务归属不变。

### 成功与失败的表现

成功的表现是：teammate 出现在 roster 中、消息报告 `accepted` 或 `queued`、任务 revision 随每次变更递增。可能的失败会以具体错误报告，而不会悄悄破坏状态：发给不存在的成员名字、claim 尚未就绪的任务、用过期 revision 编辑、或超出成员上限创建 teammate。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本服务建立在一个分离与三项承诺之上：

- **持久日志，派生状态。** Lead 会话日志是唯一真源；roster、mailbox 与任务状态每次读取都从中回放。
- **进程内归属。** 所有协作都位于单一进程；保证是重试加去重，绝不是跨进程共识。
- **显式权限。** 每个服务方法都接收确切的实时调用方 `Agent`；只有 Lead 可以 spawn、reassign 或 interrupt。
- **超出上限时明确失败。** 每个限制都是经过校验的部署值，耗尽时报告类型化错误，而不是复用 id 或名字。

[Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、任务与共享 checkout 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、服务注册、恢复调度 |
| [`src/roster.ts`](src/roster.ts) | Team 身份、成员关系解析、provisioning 与 roster 拆除 |
| [`src/mailbox.ts`](src/mailbox.ts) | 持久队列、目标本地投递、确认与恢复 |
| [`src/task-board.ts`](src/task-board.ts) | 任务 CAS 命令、DAG 校验与派生视图 |
| [`src/journal.ts`](src/journal.ts) | 串行化的 Lead 日志事务与提交通知 |
| [`src/projection.ts`](src/projection.ts) | 解码并校验 Team 事件、发布 `agentTeam` 客户端视图的严格回放投影 |
| [`src/task-view.ts`](src/task-view.ts) | 任务板与客户端视图共用的纯任务派生：就绪状态、owner 名称与写入范围重叠 |
| [`src/room.ts`](src/room.ts) | 共享 room transcript、集体决策、review 截止时间与 room 视图 |
| [`src/room-quorum.ts`](src/room-quorum.ts) | 集体 room 决策的纯 quorum 计算 |
| [`src/activity.ts`](src/activity.ts) | 一次性变更等待者与 dispose（资源释放）时的等待解除 |
| [`src/lifecycle.ts`](src/lifecycle.ts) | 共享准入截止与有界结算 |
| [`src/invariant.ts`](src/invariant.ts) | 在 append 前回放候选事件的不变式伴生插件 |

### Team 身份与 roster

每个普通运行时 root 都是一个隐式 Team 的 Lead，其 `TeamId` 等于 `SessionId`；不存在创建事件，持久状态从第一条成员、消息或任务记录开始。`spawnTeammate()` 先追加并 flush 一条 `provisioning` 成员记录，再要求配置的提供方创建预留 child；提供方失败会追加一条持久的 `failed` 成员。fresh child 不携带 Lead 历史；fork child 只捕获一次 Lead 的已完成 turn 前缀。恢复把未终结的 provisioning 记录对照 child 独立持久化的会话进行对账：直接 parent 与 continuable descriptor 匹配、且初始用户消息已记录则产生 `active`，其他任何情况都产生 `failed`。如果恢复在同进程竞争中先完成，creator 会接受终态，或报告 `TEAM_PROVISIONING_CONFLICT` 并 drain 该 child。名字由第一条 provisioning 记录保留，且永不复用。

### 持久 mailbox

`sendMessage()` 校验 peer 成员关系，追加 `team/message/queued` 并在尝试投递前 flush。目标消息以 `Team message <id> from <name>:` 开头，并在 `TeamMessageSource` 中保留同一 id 与发送者。只有目标会话在 pending inbox 或已记录历史中持久持有消息身份后，才会以 `team/message/delivered` 确认投递。即时准入按目标与持久队列顺序串行化；恢复按同一顺序重新投递 queued-minus-delivered 记录。重试前会同时折叠 live 与持久目标 inbox／历史状态，因此 inbox 已接受但模型尚未 claim 时发生崩溃不会复制消息。该保证是进程内重试加 target 会话去重，而不是跨进程 exactly-once 投递。

投递给 Lead 时直接调用 `Agent.steer()`。投递给 teammate 时使用 continuation owner 的 host-only Steer 路径；该路径会保留 Team 发送者 source，同时授权 Lead-to-child edge 并冷恢复 inactive target。sibling 消息绝不会通过公开的相邻 Agent 消息操作伪装成 Lead。

### 共享任务板

任务是完整版本化快照；每次变更都携带 `expectedRevision`，陈旧调用方会收到 `TEAM_TASK_STALE_REVISION`，而不会覆盖更新的值。数字 `task-<n>` id 的后缀必须是安全整数，id 空间耗尽时报告 `TEAM_TASK_LIMIT`，而不是复用最后一个 id。已删除任务作为 tombstone 保留以供回放与维持 id 稳定，但不占用 `maxTasks`，也不出现在 `listTasks()` 中。`writeScopes` 是规范化后的 workspace 相对前缀；视图会对与 in-progress 任务的重叠发出警告，但绝不阻止 claim 或授予写权限。

### 等待与中断

`waitForChange()` 等待注册之后发生的下一条 roster、task、mailbox 或实时状态边，时长从 10 秒到 1 小时，并且只报告是否超时；运行时 dispose 会释放当前等待。取消会保留 Error reason；非 Error reason 则通过 `TEAM_WAIT_ABORTED` 报告。`interrupt()` 仅限 Lead，委托 continuable-subagent 的 interrupt 路径，以 `keepInbox` 只取消 live teammate 的当前 turn；它既不释放任务 owner，也不删除持久 mail。

### 持久性模型

Team 事件追加到精确的 live Lead 会话，并在操作报告成功或唤醒等待者之前 flush。`team/member`、`team/task`、`team/message/queued` 与 `team/message/delivered` 仅存在于日志：它们从不进入会话表面，因此派生模型历史不受协作记录影响。顺序与时间由会话事件的 `seq` 与 `time` 负责，快照不重复保存。`./invariant` 伴生插件把每条候选 Team 事件对照已提交前缀回放，并在 append 前拒绝非法转换。

原生 V4 的 Team 事件及检查点准入会拒绝退役的 `tool-result` 内容，防止它进入邮箱或 room 状态。历史转换由 Session 格式迁移负责，Team 投影不转换旧包装。

Mailbox 投影与 checkpoint 准入保留本地声明的校验器之外获准内容中全部已解码 JSON 字段，包括自有 `__proto__` 键。本地字段检查覆盖 `text`、`reasoning`、`image` 和 `tool-call`；获准的未知标签保持不透明。Team 投影缓存版本 5 从 Session 日志重建较早缓存版本的 checkpoint；Session 格式版本保持不变。

### 共享 room

`TeamRoom` 读写的正是 roster 与 mailbox 使用的那个 Lead Session。它为每个参与者发言追加一条 `room/message` —— 取自该参与者自己已提交的 `assistant/message` —— 因此 transcript 自带署名、有序且可回放，无需第二个存储。记录与实时流都从 Team 的第一位 teammate 开始：在此之前 Lead 的 turn 只属于它自己的对话，因此从未组建 Team 的 Session 不写任何 room event，跟随其 room 的读取方在首个 view 之后也收不到任何帧。`room/proposal` 与 `room/review` 保存集体决策。这三者都是 log-only event，绝不会进入派生的模型历史。

参与者就是尚未失败的 roster 成员，包括仍处于 provisioning 的成员；这与 roster 解析在线成员 Team 身份所用的规则一致。`roomPrompt` 通过发送目标自己上次发言之后记录的 transcript 条目把发言权交给某个参与者，条目数量受 `roomTranscriptWindow` 限制。参与者不会因他人的发言而被唤醒，因此 room 只会在有人交出发言权时推进。

接受与否只由 `room-quorum.ts` 根据记录在案的 review 计算。每个有资格的 reviewer 都是 proposer 之外的参与者；只有当全部 reviewer 都已投票、其中至少 `roomApprovalRatio` 比例批准，且没有任何反对成立时，决策才会被接受。反对一旦达到 quorum，决策立即结清。proposer 不能 review 自己的决策，已结清的决策是最终的，被拒绝的决策只能通过携带修订后 statement 的新 revision 解决，其上限为 `roomMaxProposalRevisions`。没有任何操作可以强行给出结论；`roomEscalate` 会把未决决策交给人类。每条已记录的立场都带有理由，而每个参与者都能读到整块决策板，因此 proposer 能回应反对意见，而不是只知道有人反对。

每个 participant view 都会报告该在线参与者在 `roomReviewGraceMs` 内是否没有产生任何被观察到的工作，用的正是停滞巡检所读的同一个窗口，因此决策板点名的正是 room 正在等待的那个参与者。读取方通过 `roomStream` 这个 Remote stream 跟随一个 room：先收到完整的 room，随后在每次已提交变化后收到新的 view，并为参与者流式输出的每个 text chunk 收到一帧，因此 panel 无需轮询即可展示正在进行的审议。判定 reviewer 沉默的依据是该参与者自身被观察到的工作 —— 它自己 turn 的持久 Session event 与实时 `agent/assistant-stream` 帧 —— 而绝不是 room 自身的记录：Lead Session 保存着每个角色的记录。请求一次 standing 会启动该 reviewer 的 `roomReviewGraceMs` 窗口，至多 `roomReviewReminders` 次提醒各自会重启被提醒者的窗口；只有当所有仍欠 standing 的 reviewer 都用尽窗口后，决策才会升级，因此慢模型不会被误判为卡住。升级后的决策会把沉默的 reviewer 记入 `room/review-timeout`，绝不代替它们编造 standing。

### Dispose

dispose 会关闭准入、中止并等待已获准的创建与 mailbox dispatch 事务，再让 continuation owner 释放 roster 中确切的 live direct child 及其后代；Lead 的非 Team continuable child 不受影响。cleanup 失败会让 dispose 明确失败，并以 `disposalTimeoutMs` 为上限。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享子系统类型逐步进入工具表面与设计背后的决策。

- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与 `ctx.agentTeams` 服务 API。
- [tool-agent-team 包](../tool-agent-team/README.zh.md)——让模型创建 teammate、向其发送消息并进行协调的工具。
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)——身份、mailbox、任务与共享 checkout 决策。
- [实验包决策](../../../.agents/notes/implemented/architecture/2026-08-18-experimental-agent-teams-packages.zh.md)——位置、公开发布与依赖隔离。

-----

<a id="model-experience"></a>

### 浏览器投影

`agentTeam` Session 投影发布 Lead Session 的持久成员身份与阶段、成员错误、未删除任务视图，以及最后有效状态旁的 `failure`。其 `apply` 只替换被触及的集合；仅邮箱的变化保留客户端视图引用，不产生 frame。[子系统参考](../../../docs/subsystems/agent-team.zh.md#web-projection) 定义传输类型。

[Web UI](../client-ui-agent-team/README.zh.md) 读取共享 Session 投影，并从 Session 状态叠加活动信息。任务创建与更新由 Team agent 通过服务和模型工具完成。`./client` 导出可供浏览器使用的 roster、任务、投影与 room 类型。

room 不进入该投影，因为它的视图携带实时参与者状态、quorum 计算与流式文本。`TeamService` 负责生成式 `agentTeams/room`、`agentTeams/roomStream`、`agentTeams/roomPrompt`、`agentTeams/roomPropose` 与 `agentTeams/roomEscalate` Remote method，`./remote` 导出提供 Web UI 为其 room 区域挂载的 Client contribution。Typert 把传输失败保留在外层 `RemoteResult` 中；room 拒绝也以这类失败到达面板。

## 模型体验

### Peer 消息

#### 模型看到什么

每条已投递 peer 消息都是用户角色消息。第一个短文本块包含稳定消息 id 与发送者，之后原样附加发送者的内容块。roster、task 与 mailbox 记录仅存在于日志，绝不进入派生模型历史。

#### Token 影响

每次 peer 投递都会把发送者前缀与消息内容加入 target 历史。任务与 roster 变更不增加模型 token；其面向模型的呈现属于 `@deepseek-ai/dsh-experimental-tool-agent-team` 结果。

#### KV Cache 影响

Peer 消息追加在 target 可复用历史前缀之后。冷恢复会先复用持久对话，再追加尚未投递的消息。

### Room prompt 与结论

#### 模型看到什么

room prompt 是一条 user-role 消息。当 room 记录了目标尚未见过的发言时，一个前置 text block 会渲染为 `Room conversation so far:`，后接 `<name>: <text>` 行；调用方的 instruction 原样跟随。review 请求会给出决策 id、revision 与确切的 statement，并要求给出一个 verdict。结论通知会给出决策、其 phase，以及按名称列出的参与者。transcript 条目本身是 log-only 的：参与者只有在获得发言权时才会通过 prompt 读到它们。

#### Token 影响

一次 prompt 的代价是未读 transcript 窗口加上 instruction，受 `roomTranscriptWindow` 限制。开启一个决策会向每个有资格的 reviewer 发送一次 review 请求，因此 N 个参与者的 room 每个 revision 需要 N-1 次请求。结论通知是发给 proposer 的一条短消息；提醒会把同样的 review 请求重发给未产生任何工作的 reviewer，每个 revision 至多 `roomReviewReminders` 次，而升级通知是一条点名始终未作答者的短消息。

#### KV Cache 影响

transcript 条目与决策绝不触及参与者复用的前缀。每次 prompt 都追加在该参与者自身历史之后，因此未变的前缀在多次唤醒之间保持缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明一支团队目前不能做什么、或哪些方面需要特别的运维关注。它们是当前包约束，不是与其他协作机制的对比。

- **完整视图广播** — 每次 roster 或任务变化都会把完整 roster 和未删除任务板（含描述）发给所有已连接浏览器，即使它正在查看其他 Session。
- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间约定仍可自由变更。
- **单进程、共享 checkout**——成员共享 cwd，修改立即可见；本包不提供 worktree、远端成员、merge 或文件锁。
- **write scope 仅作提示**——Bash、formatter、代码生成器与直接外部写入可以绕过文件版本检查；Lead 必须协调 owner 并检查最终 diff。
- **扁平且不可变的 roster**——只有 Lead 可以创建直接 teammate；不支持嵌套 Team、重命名、删除或名字复用。
- **不会自动释放 owner**——成员不活动、interrupt、进程退出与工作失败都不会释放任务 owner。
- **mailbox 不保证跨进程 exactly-once**——不支持多个 harness 进程并发操作同一 Team。
- **多成员流程没有录制会话用例** — Lead 与其同行会在取决于墙钟的时刻被唤醒，因此 session replay 通道无法复现它们的顺序；Team 与 room 行为改由包测试、无密钥 vendor adapter 套件和实时 real-API e2e 运行覆盖，而不是 corpus snapshot 用例。
- **沉默只会升级，不会结清** — reviewer 用尽 `roomReviewGraceMs` 与 `roomReviewReminders` 后，决策会连同沉默者一并升级；没有任何操作会代替它们记录 standing，因此该决策仍在等待人类。
- **room 复用 Team roster** — 一个 room 只有一个 Lead Session、一份共享 checkout，没有独立成员资格，因此成员不可能只属于 room 而不属于 roster。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

#### Promotion

promotion 到产品角色组需要按[实验子树规则](../AGENTS.md)审查公共约定、限制、测试证据、发布载荷、运行时依赖与具名稳定 owner。

#### 未来方向

尚未决定的探索方向包括嵌套 Team、自动释放 owner 的策略、跨进程 mailbox 事务，以及通过 worktree 实现文件系统隔离；这些都没有承诺。

</details>
