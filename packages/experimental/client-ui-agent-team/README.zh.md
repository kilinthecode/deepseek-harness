---
description: "使用并排查实验性 Web Agent Teams roster、共享任务板、room 与 teammate 导航面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

[English](README.md) | 中文

## 概述

本包向 Web 会话页头添加 Agent Teams action，让用户检查 roster 与共享任务板、在启用 room 时跟随并引导该 Team 的 room，并打开 teammate 会话。它从 Session store 读取 Lead Session 的 `agentTeam` 投影，Host 投影 frame 使其保持最新；它通过生成式 `agentTeams/room*` Remote method 读取 room，并让 child history 导航继续使用稳定的 addressed-subagent 路径。通过实验性的 Agent Teams 或 room bundle 选择本包。这个面板不扩展稳定 API Proxy、不存储 Team 状态，也不注册面向模型的输入。

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

通过 [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.zh.md) 启用本包。这个组合包同时提供团队服务、工具与 Web 界面。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 检查并导航 roster

面板从共享 Session store 展示 Lead Session 的 roster 与任务板。面板保持打开时，任务和成员更新会直接出现。打开面板不发起投影请求。会话或 Session 列表正在加载时，面板显示加载提示；加载结束后仍无 Team 值时，显示不可用提示。

Roster 行展示持久名称与阶段。provisioning 和 running 成员使用共享 ongoing loading，inactive 成员使用人物图标，failed 成员使用 error 红点。实时 Session 状态提供运行活动；共享 `modelSelection` 投影在可用时提供模型。当前会话带有“当前会话”标签且不可选择。在 teammate 会话中选择 Lead 会直接打开 Lead Session。选择 active teammate 会打开其普通 continuable 子会话地址。Host 在打开历史时校验 parent、child 与 mode；后续人类提示词使用同一 addressed-subagent 会话。

### 读取 room

打开面板时会通过 `agentTeams/room` 读取一次 room。当组合拥有 room 时，面板会新增控件来把发言权交给某个参与者、开启决策，或把未决决策交给人类，并显示共享 transcript 与每个集体决策：其 phase、proposer、确切的 statement，以及投票两侧记录在案的参与者。transcript 指出谁说了什么；决策板指出谁批准、谁反对、谁弃权，以及在决策仍未结清时谁尚未记录立场，而 room 区块会点名每个在该 room 窗口内没有产生任何工作的在线参与者。已结清的决策不显示等待中的参与者，因为没有人能改变 quorum 已经达成的结果；每条已记录的立场都会连同该 reviewer 给出的理由一并显示。面板打开期间会跟随 room：某个参与者正在流式输出的文本会随到达而显示，而该参与者已提交的 transcript 条目会用持久记录替换它的实时文本。room 读取或操作失败时，错误显示在 room 区块内，与正常的 roster 和任务并列。

### 查看任务板

可开始的 pending 任务使用 idle 灰点，被依赖阻塞的 pending 任务使用 warning 橙点，in-progress 与 verifying 任务使用 ongoing loading，completed 任务使用 done 绿点。

只读任务板展示任务标识、负责人、依赖、就绪状态、提示性写入范围与重叠警告。等待同行裁决的任务显示“待验证”，已记录裁决的任务显示验证者、裁决与理由。超过两行的描述提供展开按钮。分区标题显示成员与任务数量；空任务板显示简短描述，只有一名成员且无任务时采用单列面板。Team agent 通过工具创建、提交和验证任务；面板不提供任务修改控件。当投影报告某条持久 Team 记录被拒绝时，面板在最后有效的 roster 与任务上方显示该失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 先挂载生成式 `agentTeams` room Remote contribution，再通过 Cordis effect 注册 locale dictionary 与一个 conversation-header slot。Dispose plugin fiber 会移除这两项 registration 并卸载该 Remote namespace；registration 失败时，会先卸载该 namespace，再传播错误。

面板渲染在会话容器外，并保持在视口范围内。成员卡片在静止、选中和悬停状态下均使用共享 elevation 描边绘制轮廓。悬停触发按钮 150ms 后打开面板；指针离开触发按钮和面板后，经过 120ms 宽限关闭。点击触发按钮会固定面板并将焦点移入其中。点击外部或按 Escape 可关闭面板；仅当焦点原本位于面板内时，Escape 才将焦点返回触发按钮。页头较窄时触发按钮折叠为图标，只响应点击打开。组件从 `useSessions`、`useSessionStatus` 与 `useSession` 座位派生每一个 roster 行与任务行：Lead 身份来自当前 Session 的 subagent address，Team 视图来自 `projectionsBySession[lead].values.agentTeam`，成员活动来自 Session 状态并以列表摘要为后备，model 来自 `projectionsBySession[member].values.modelSelection.next`。每个 roster 行只选择自己的运行状态。一个注入回调通过当前与目标 Session 的 id 打开 roster Session；room 回调在每次调用 `agentTeams/room*` 之前把当前会话解析为其 Lead。room 区块只在挂载期间跟随 `agentTeams/roomStream`，并在面板关闭时中止该 stream。切换会话会关闭面板并清除导航失败。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | room Remote 挂载、locale、导航与 slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | 由投影派生的 roster 与任务板、由 Remote 支撑的 room 区块及面板交互状态 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文 panel 文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Teams bundle](../agent-team-profile/README.zh.md)——挂载本 Client plugin 的公开 opt-in bundle。
- [Agent Teams service](../agent-team/README.zh.md)——权威 roster、task、room 与投影行为。
- [会话 UI](../../client/ui-conversation/README.zh.md)——稳定 header slot 与 addressed-subagent 导航表层。
- [实验性包](../README.zh.md)——孵化状态与发布规则。

-----

<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器面板不注册面向模型的输入。其 room 控件调用 Host 的 room 操作；由此产生的每条参与者提示词都由这些操作负责，并记录在 `room/*` 与 mailbox 事件中；面板绝不记录立场。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有 mailbox timeline**——投影视图只承载 roster 与任务；不显示 peer 消息。
- **晚启用插件** — 在已经打开的会话中启用 Agent Teams 后，需要刷新页面才能接收其 Team 投影。
- **模型可用性** — 仅当共享 store 包含该成员的持久选择或请求时才显示模型。冷缓存中缺少的值会保持缺失，直到正常 Session 加载或实时更新提供它们。
- **实时跟随需要 panel 处于打开状态**——panel 只在打开期间订阅 room，并在已提交变化取代实时文本时丢弃它；关闭的 panel 会在下次打开时重新读取 room。
- **被放弃的实时文本会保留**——跟随只携带 text chunk，不携带参与者流的结束，因此被中止或失败的 turn 的文本会保持实时显示，该参与者下一次流式输出的文本会接在其后，直到它提交下一条发言。
- **没有 room 的组合不显示 room 区块**——面板会省略它，而不是渲染一个空的区块，因为「没有 room」与「空闲的 room」是不同状态。
- **room 面板只写三件事**——它可以用一条指示把发言权交给某个参与者、用一条 statement 开启决策，并连同理由把未决决策交给人类，各自经由对应的 `agentTeams/room*` Remote 调用。它绝不记录立场：review 是参与者自己的裁决，由该参与者或其模型记录。
- **room 读取器只有一个组装浏览器用例**——`apps/web/tests/agent-room-panel.e2e.ts` 固定渲染出的 transcript 与决策板，然后在 panel 挂载之后再开启一个决策，要求它无需刷新就通过实时跟随出现；roster 与任务板路径保留各自的用例。
- **普通 child continuation**——导航后发送的人类消息使用稳定 addressed-subagent 提示词路径，而不是 Team peer mailbox。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Host 投影与 room service 是权威来源，本包只持有一个可释放的 slot 注册和一个 Remote 挂载。
