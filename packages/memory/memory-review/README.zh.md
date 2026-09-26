---
description: "cache-parity 无人值守记忆回顾：在父级 idle 通知时启动、只能添加新记忆的 fork 子会话，供选择、配置或调试该回顾的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-review

[English](README.md) | 中文

## 概述

`dsh-memory-review` 在足够多条用户类轮次之后启动一次无人值守的进程内 fork，让子 agent（智能体）从父会话已有的对话中保存持久记忆。父模型看不到任何额外内容；子 agent 继承父级已完成轮次，再收到一条回顾任务，并且只能添加新名称。base 组合包与 TUI 配置每十轮用户消息启用它、步骤上限为八；headless、ACP（Agent Client Protocol）和 SDK 将其关闭；Web 在 `standard`、`cordis` 和 `ptc` 预设上按会话重新挂载。当进程仍在运行、且不应改变父请求前缀时选择它。

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

在 [`dsh-tool-memory`](../tool-memory/README.zh.md) 之后挂载它：只要存在 `fork` 提供方，且进程仍在运行并应从对话中回顾持久记忆。两个配置字段均为必填；省略任一字段的组合会在加载时失败。

### 何时选择

当仍在运行的交互进程应从对话中保存持久记忆、且不应改变父请求前缀或等待新会话时选择它。对于进程可能在父级刚进入 `idle` 就退出的 headless、ACP 和 SDK 自动化，以及省略 `dsh-tool-memory` 或 `fork` 提供方的组合，请保持关闭。`reviewEveryUserTurns: 0` 使插件保持挂载但永不启动子会话。

### 最小配置

两个字段均为必填且无默认值；省略任一字段、将 `reviewEveryUserTurns` 设为小于 `0`，或将 `maxReviewSteps` 设为小于 `1` 的组合会在加载时失败。若到期时 `memory_write` 或 `fork` 提供方缺失，本次复盘会记录一条指明缺失项的错误并且不启动；同级插件并发激活，因此无法在加载时检查它们的注册。

```yaml
- name: '@deepseek-ai/dsh-memory-review'
  config:
    reviewEveryUserTurns: 10
    maxReviewSteps: 8
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `reviewEveryUserTurns` | 必填 | 两次回顾之间的用户类父消息数；随附组合使用 `10`；`0` 在插件保持挂载时关闭回顾 |
| `maxReviewSteps` | 必填 | 回顾子会话 `agent/pre-step` 的 `step` 含上限；随附组合使用 `8`；第 `maxReviewSteps + 1` 步被拒绝 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-memory-review)是受支持字段的完整来源。

### 父级与子级看到什么

父模型不会从本插件收到额外的提示词、工具结果或快照。子会话的写入在子会话的工具结果中确认，并出现在之后的快照中（压缩（compaction）之后或新会话中）。在 Web 上，父级标题目录显示带 `memory-review` 标签的普通 subagent 行。子会话继承父级已完成轮次，然后将回顾任务作为其第一条新的用户角色消息，并且只能调用 `memory_recall` 以及用于添加尚未可见名称的 `memory_write`。

### 挂载位置

base 组合包在 `tool-memory` 之后立即启用它，配置为 `reviewEveryUserTurns: 10` 与 `maxReviewSteps: 8`，因此只使用该组合包的 TUI 配置拥有它。headless、ACP 和 SDK 补丁将 `id: memory-review` 设为禁用。Web 宿主平面在 `tool-memory` 旁禁用它；`standard`、`cordis` 和 `ptc` 预设按会话以这两个字段重新挂载。`minimal` 预设省略它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释回顾背后的设计决策并指向实现它们的代码；可观察行为已在[使用本包](#use-this-package)中覆盖。

### 设计理念

- **按 `idle` 触发，而不是工具。** 全局 `agent/status` 监听器在 `status` 为 `idle` 时启动回顾，并且不等待子会话。当 `reviewEveryUserTurns` 为 `0`、当 `agent.session.header.parentSession` 已设置（不对任何子会话做嵌套回顾）、当该父级已有进行中的回顾、或当 `turnsSinceReset` 低于间隔时，跳过启动。
- **在父日志上统计用户类轮次。** `memoryReview` 投影为 `stateVersion: 1`，状态为 `{ turnsSinceReset: number }`，`init: () => ({ turnsSinceReset: 0 })`。它将 `source.kind === 'user'` 的 `user/message` 折叠为加一，并将名为 `memory_write`、`memory_recall` 或 `memory_forget` 的 `tool/call`，以及 `label === 'memory-review'` 的 `subagent/catalog`，折叠为 `{ turnsSinceReset: 0 }`。`source.kind === 'goal'` 的消息不计入。恢复会从父日志重建计数。
- **Cache-parity fork。** 启动方式为 `ctx.agents.withInitiator(parent, () => ctx.subagents.start('fork', { parent, prompt: [{ type: 'text', text: REVIEW_PROMPT }], label: 'memory-review', signal }))`，并省略 `toolFilter`、`persona` 和 `agentOptions`，因此子会话的首次请求保持父级的路由、工具和 persona。启动要求 `run.localAgent`；否则记录警告、dispose（资源释放）该 run，并且不将父级保持为待处理。
- **无竞态限制。** 全局 `agent/created` 监听器在该父级处于待回顾且 `created.agent.session.header.parentSession` 为该父级时，在 `agents.create` 于 `start()` 返回之前等待的串行 `agent/created` 期间，在 `created.agent.ctx` 上调用 `installReviewRestrictions`，因此子会话的第一次工具调用已被守卫。`tools/pre-execute` 先 `await next()`，然后允许 `memory_recall`，仅当可见记录中没有该 `name` 与 `scope` 时允许 `memory_write`，并以 `{ kind: 'deny', reason }` 拒绝 `memory_forget` 和所有其他名称。当 `step > maxReviewSteps` 时，`agent/pre-step` 返回 `{ kind: 'reject' }`。
- **释放。** 进行中的回顾在该父级的 `agent/disposed` 时中止，也在插件 fiber dispose 时中止（`ctx.effect`）。成功启动后，`void run.result.finally(() => run.dispose())` 删除待处理标记并 dispose 子会话。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、idle 触发、fork 启动、`agent/created` 限制安装 |
| [`src/projection.ts`](src/projection.ts) | `memoryReview` 投影单元与 `dueForReview` |
| [`src/restrict.ts`](src/restrict.ts) | 仅添加的 `tools/pre-execute` 策略与子会话步骤上限 |
| [`src/prompt.ts`](src/prompt.ts) | 回顾任务、目录标签与拒绝理由 |

### 导出列表

本插件是函数/命名空间插件：它导出 `name` / `inject` / `Config` / `apply`，没有默认导出，因此 Loader 会保留其注入元数据（[事故复盘（postmortem） 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。具名导出 `REVIEW_PROMPT`、`REVIEW_LABEL`、`REVIEW_DENY_OTHER_TOOL`、`REVIEW_DENY_OVERWRITE`、`dueForReview` 和 `reviewWriteTarget` 分别是子任务、目录标签、两条拒绝理由、间隔谓词，以及写入目标解析器。

### 触发与限制

复盘到期时，若 `ctx.tools.get('memory_write')` 为 undefined，或 `ctx.subagents.list()` 中没有 `'fork'`，`startReview` 会调用 `ctx.logger.error` 记录并跳过本次复盘。无效的 `memory_write` 参数（缺少字符串 `name`，或 `scope` 不是 `global` 或 `project`）会以覆盖理由拒绝。下游 `tools/pre-execute` 的拒绝原样返回。

### 没有不变量配套插件

不发布不变量配套插件，因为本包不拥有任何会话事件，也没有持久数据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-tool-memory`](../tool-memory/README.zh.md)——回顾子会话使用的工具、快照与提示词段落。
- [memory 组地图](../README.zh.md)——同级组页面及其包表格。
- [`dsh-subagent-fork-in-process`](../../subagent/subagent-fork-in-process/README.zh.md)——以父级已完成轮次作为子会话初始内容的进程内 fork 提供方。
- [Hermes Agent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)——无人值守记忆回顾的既有实现；[Hermes Agent 仓库](https://github.com/NousResearch/hermes-agent)以 MIT 许可。

-----

<a id="model-experience"></a>
## 模型体验

### 回顾子任务

#### 模型看到什么

回顾子会话先收到继承的父前缀，再将这条用户角色任务作为其第一条新消息。父模型永远看不到这段文本。

##### 该字段的逐字文本

```markdown
This is an unattended memory review of the conversation above. Save a fact only if it remains true in every future session: who the user is and how they like to work (type user), feedback or corrections on how to do the work (type feedback), a durable fact or constraint about the current project (type project), or a pointer to an external resource (type reference). Write declarative statements, not imperatives. Prefer project scope for project facts, global otherwise. You may only add new memories: memory_write with an existing name and memory_forget are denied. Call memory_recall before writing if the snapshot lists only an index line. Do not save task progress, transient state, secrets, or anything the repository already records. If nothing qualifies, reply with exactly: Nothing to save.
```

#### Token 影响

每隔 `reviewEveryUserTurns` 条用户轮次，按缓存 token 价格回放一次父前缀，再加上回顾轮次。当 `reviewEveryUserTurns` 为 `0` 时，不产生子请求。

#### KV Cache 影响

仅当路由、工具和 persona 与父级相等时为热缓存——本插件不传入 `toolFilter`、`persona` 或 `agentOptions`。父前缀永不改变。

### 被拒绝的工具结果

#### 模型看到什么

子会话会看到被拒绝的 `tool/result`：针对 `memory_forget`、针对已有名称与作用域的 `memory_write`，以及除 `memory_write` 与 `memory_recall` 以外的每个工具。`memory_recall` 被允许。

##### 其他工具的逐字文本

```markdown
Memory review may only call memory_write and memory_recall.
```

##### 遗忘或覆盖的逐字文本

```markdown
Unattended memory review may only add a new name.
```

#### Token 影响

每次被拒绝的调用在子会话上增加一行短错误，保留到压缩为止。

#### KV Cache 影响

在继承前缀之后对子会话仅追加。父请求不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了无人值守回顾何时不适用。它们是当前的包约束，而不是任务待办。

- **第一步压缩**——当父级接近压缩阈值时，子会话的第一步可能会压缩，因此继承前缀被摘要，热缓存读取丢失。
- **仅限进程存活期间**——回顾只在进程存活时运行，因此 headless、ACP 和 SDK 组合包禁用该插件。
- **普通 Web 行**——Web 显示带 `memory-review` 标签的普通 subagent 行。
- **并行的新名称写入**——同一步骤中两次并行的、使用同一新名称的 `memory_write` 调用都可以通过仅添加检查。
- **父级写入竞态**——若父级的 `memory_write` 落在子会话的仅添加检查与子会话对同一名称的 `memory_write` 之间，会被子会话覆盖。
- **`memory_recall` 与失败调用同样会重置间隔**——每次名为 `memory_write`、`memory_recall` 或 `memory_forget` 的父级 `tool/call` 都会将 `turnsSinceReset` 重置为 `0`，无论调用是否成功，因此每轮都调用记忆工具的父级会无限期推迟回顾。
- **路由到更便宜模型的摘要回顾**——使用更便宜路由模型的回顾被延期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付的行为、限制与已接受的理由位于上文各节、包代码以及链接的页面中。

无。

</details>
