---
description: "五个工具，让 room 参与者召唤同伴、提出决策并记录 quorum verdict，供挂载实验性 room 运行时的组合使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-room

[English](README.md) | 中文

## 概述

`dsh-experimental-tool-agent-room` 让实验性 room 中的每位参与者都拥有推进集体决策的工具：读取 transcript 与当前投票、把发言权交给某位参与者并附上它尚未见过的上下文、把一个 statement 提交给 room、带着理由记录 approve、reject 或 abstain 的立场，以及把未决决策交给人类。它还提供让 quorum 真正有意义的策略，因此参与者只批准自己愿意为之辩护的内容，并在拒绝时说明具体问题。它需要开启 `roomEnabled` 的 `@deepseek-ai/dsh-experimental-agent-team`，并以实验性名称发布，不附带稳定性承诺。

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

把本包与 `roomEnabled: true` 的 `@deepseek-ai/dsh-experimental-agent-team` 一起挂载。当参与者还需要创建 teammate 时，再挂载 `@deepseek-ai/dsh-experimental-tool-agent-team`；room 工具面向 roster 已经持有的参与者，因此它们本身不创建任何参与者。

```yaml
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
  config:
    roomEnabled: true

- id: tool-agent-room
  name: '@deepseek-ai/dsh-experimental-tool-agent-room'
```

### 何时选择

当一个问题应当由多个模型共同推理、并且它们必须彼此问责，而决策不能由任何单个参与者做出时，选择本包。当工作是委派、且 Lead 的判断本身就是预期权威时，只选择 `@deepseek-ai/dsh-experimental-tool-agent-team`。

<a id="understand-the-implementation"></a>
## 理解实现

`apply` 会安装到每个已存在或随后发布的 room 参与者的 Agent scope 中：一个承载共同问责策略的 system-prompt section，以及五个工具。安装依据 `ctx.agentTeams.tryMembership`，也就是 room 使用的同一条 roster 规则，因此成员从 provisioning 记录它的那一刻起就会收到这些工具。

每个工具包装一个 `ctx.agentTeams` 操作，并按其声明的 schema 把结果渲染为紧凑 JSON。每个结果都由服务而非工具决定：`room_review` 记录一个立场并返回 quorum 算术当时给出的结果，`room_propose` 无法接受任何东西，也没有任何工具可以强行给出结论。拒绝会以说明原因的 tool error result 抵达模型，因此参与者可以纠正过期 revision 或未知的决策 id 并重试。

`room_view` 最多返回 `maxTranscriptEntries` 条尾部 transcript 条目，并报告是否发生了截断。工具会把模型给出的 `entries` 收敛到该配置上限，因此窗口由部署决定，模型无法自行放宽。

<a id="further-exploration"></a>
## 进一步探索

- [`@deepseek-ai/dsh-experimental-agent-team`](../agent-team/README.zh.md) 负责这些工具所读取和修改的 roster、持久 mailbox、任务板与 room 状态。
- [Room 类型](../../../docs/subsystems/agent-team.zh.md#shared-room)定义了每一种持久记录与 view。

<a id="model-experience"></a>
## 模型体验

### Room 工具

#### 模型看到什么

每位参与者的 schema 中都会出现五个工具：`room_view`、`room_prompt`、`room_propose`、`room_review` 与 `room_escalate`。每个工具都按其声明的 schema 返回紧凑 JSON：一个 decision view 携带其 id、revision、proposer、statement、phase、所需批准数、三个投票列表、每条已记录立场及其理由，以及在决策仍未结清时立场缺失的参与者名单。一个 system-prompt section 陈述参与者何时可以发言以及 quorum 规则；每个工具的说明与参数承载各自的使用规则，而自我评审、已结清的决策或 revision 上限等拒绝会在调用结果中返回。

#### Token 影响

策略 section 是固定文本，出现在每位参与者的每个请求中。每个工具结果都是一条紧凑 JSON 记录；decision view 的上界由 roster 规模决定，因为它的投票列表列的是参与者名称。`room_view` 的 token 开销与部署配置的 transcript 窗口成正比。

#### KV Cache 影响

策略 section 与其他稳定 prompt section 放在一起，因此它扩展的是可复用前缀，而不会使其失效。工具结果像其他 turn 内容一样追加在该前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明 room 参与者目前不能做什么、或哪些方面需要特别的运维关注。它们是当前包约束，不是与其他协作机制的对比。

- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间约定仍可自由变更。
- **room 必须由组合启用**——若 `@deepseek-ai/dsh-experimental-agent-team` 未开启 `roomEnabled`，所有工具都会以 `TEAM_ROOM_DISABLED` 失败，而不是降级运行。
- **参与者只在获得发言权时发言**——没有任何工具让参与者自行取得 turn 或主动回应同伴，因此当参与者不再交出发言权时，room 会停滞。
- **scoped 安装可能触及 provider-owned subagent**——安装依据创建时的成员身份，早于 provider-owned child 的 descriptor 被记录；真正拒绝它的是每个操作内部的授权检查。
- **沉默的 reviewer 只会推迟决策**——每个有资格的 reviewer 都必须投票后决策才会结清；room 会先提醒停止工作的 reviewer，之后才把决策连同沉默者名单升级给人类。
- **room 面板从不记录立场**——当组合挂载 `@deepseek-ai/dsh-experimental-client-ui-agent-team` 时，它会渲染 transcript 与决策，并能交出发言权、开启决策和升级决策，但 review 只来自参与者通过 `room_review` 提交的立场。

本包不发布 runtime invariant companion：它自身不拥有任何运行时状态。它声明的每个 schema 都委托给 `ctx.agentTeams`，而守护这些记录的不变式由 `@deepseek-ai/dsh-experimental-agent-team` 拥有。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者备注</summary>

这组工具与 `@deepseek-ai/dsh-experimental-tool-agent-team` 对称：相同的 scoped 安装生命周期、相同的声明式 schema 结果契约，以及相同的经 tool error result 返回拒绝的路径。任一方变更时请保持两个包对称；共享的投递与 roster 机制位于 `@deepseek-ai/dsh-experimental-agent-team`。

</details>
