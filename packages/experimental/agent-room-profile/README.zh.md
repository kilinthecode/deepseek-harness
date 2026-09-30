---
description: "发布在 dsh-base 之上、在 Agent Teams roster 上启用 quorum 授权审慎讨论的实验性 room profile 层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-room-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-room-profile` 是一个已发布的实验性 profile 层，它在 `@deepseek-ai/dsh-base` 之上把 [Agent Teams](../agent-team/README.zh.md) 变成 room。它的 patch 以 `roomEnabled` 挂载 Team 域，保留 Team 委派工具以便 roster 能够创建参与者，并加入 [room 工具](../tool-agent-room/README.zh.md)。此后集体决策只由记录在案的 quorum 结清，而被拒绝的决策必须携带修订后的 statement 或升级。dsh 安装把它作为可选 bundle 提供，任何随产品发布的 profile 都不会启用它；可在 Web 侧边栏的 Plugins 页面启用它以代替 Agent Teams bundle，或把它显式加入某个已初始化的 profile。

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

### 安装到 profile

把本包加入一个已初始化的 profile，然后运行一个要求多位参与者的任务：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-room-profile
```

### 你会得到什么

在 `dsh-base` 之后的四行：开启 `roomEnabled: true` 的 Team 域、它的委派工具、room 工具，以及 Team 浏览器 UI。room 强制执行的每个值都写在 patch 中而不是依赖默认值：最多八个成员、每次 prompt 二十条 transcript 窗口、多数批准，以及决策必须升级前的四次 revision。插件页通过组合包的 `package.json.icon` 声明读取其[图标](icon.svg)，组合包禁用时也会显示。

<a id="understand-the-implementation"></a>
## 理解实现

该层保留 `@deepseek-ai/dsh-experimental-tool-agent-team` 的挂载，这正是 room 可用的前提：参与者就是 roster 中的 teammate，因此 `spawn_teammate` 是 room 获得成员的方式。与 Team profile 不同，它不禁用任何东西，因为 room 工具使用不同的名称，不会遮蔽旧 continuable child 的同名控制工具。

patch 显式设置 `roomEnabled`。若不设置，room 工具仍会挂载，但每次调用都会以 `TEAM_ROOM_DISABLED` 拒绝，因此只想要委派的部署应改用 `@deepseek-ai/dsh-experimental-agent-team-profile`。

<a id="further-exploration"></a>
## 进一步探索

- [`@deepseek-ai/dsh-experimental-agent-team`](../agent-team/README.zh.md) 负责持久 room 状态、roster，以及工具调用的每个操作。
- [`@deepseek-ai/dsh-experimental-tool-agent-room`](../tool-agent-room/README.zh.md) 负责 model-facing 的 room 工具。
- [Room 类型](../../../docs/subsystems/agent-team.zh.md#shared-room)定义了每一种持久记录。

<a id="model-experience"></a>
## 模型体验

### Room 策略与工具

#### 模型看到什么

该层新增一个描述共同问责的 system-prompt section 与五个工具：`room_view`、`room_prompt`、`room_propose`、`room_review` 与 `room_escalate`。它同时保留九个 Team 工具，因此参与者可以创建 teammate 并使用任务板。

#### Token 影响

策略 section 是每位参与者请求中的固定文本。工具结果是受 roster 规模约束的紧凑 JSON，而 `room_view` 的开销与配置的 transcript 窗口成正比。

#### KV Cache 影响

策略 section 加入稳定 prompt section，因此它扩展的是可复用前缀。工具结果像其他 turn 内容一样追加在该前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该层目前不能做什么、或哪些方面需要特别的运维关注。它们是当前包约束，不是与其他协作机制的对比。

- **实验原型，无稳定性承诺**——本包公开发布，但孵化期间约定仍可自由变更。
- **没有随产品发布的 profile 会启用它**——该层随安装提供，但在某个 profile 加入它之前一直关闭，因为 room 会改变其参与者 turn 的含义。
- **面板只在 Web Client 中渲染**——UI 行的浏览器入口只在那里挂载，因此 headless profile 运行 room 时没有浏览器界面；请改为通过 Session log 读取。
- **room 继承 Team 的全部约束**——单进程、共享 checkout、扁平且不可变的 roster，以及没有跨进程 exactly-once 投递。

本包不发布 runtime invariant companion：它只携带静态 profile patch，而其激活的可变关系由 Team 域拥有。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者备注</summary>

该层与 `@deepseek-ai/dsh-experimental-agent-team-profile` 是同一批 base 行上的互斥选择：Team profile 禁用直接委派与旧控制工具，而这一层保留委派并加入 room。任一方变更时请保持两个 patch 对称，并把每个配置值写在这里，而不是依赖包默认值。

</details>
