---
description: "基于持久记忆存储的模型侧记忆工具：memory_write、memory_recall、memory_forget，在会话开始时和压缩之后注入的记忆快照，以及说明何时记忆的提示词段落，供选择、配置或调试这些工具的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

## 概述

`dsh-tool-memory` 让 agent（智能体）跨会话记忆。它基于 [`dsh-memory`](../memory/README.zh.md) 为模型提供三个工具：`memory_write` 保存或替换一条记忆，`memory_recall` 读取实时存储，`memory_forget` 删除一条。当存在已保存记忆时，会话开始时添加一份快照，压缩之后再添加一份：部分条目带全文，其余为一行索引，受 `injectMaxBytes` 限制。写入与遗忘在工具结果中确认，并出现在下一份快照中。一段简短的提示词段落说明何时该保存、何时不该。

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

在需要模型读写持久记忆的地方挂载它：随附的 headless profile 在宿主平面挂载，`standard`、`ptc` 和 `cordis` agent 预设在 Web 上按会话挂载。它需要来自 [`dsh-memory`](../memory/README.zh.md) 的 `ctx.memory`，以及工具、系统提示词和会话投影注册表。

### 何时选择

当 agent 应把用户偏好、工作方式反馈、项目事实和参考资料从一个会话带到下一个会话、并自行决定哪些值得保留时选择它。对于人设即完整系统提示词的组合（`minimal` 预设），以及从不希望模型写入 harness home 的自动化场景，请不要加入它。它可以与厂商记忆 MCP 覆盖配置共存：工具名称互不相同，提示词段落也会告诉模型不要镜像事实。

### 最小配置

两个字段均为必填且无默认值；省略任一字段的组合会在加载时失败。

```yaml
- name: '@deepseek-ai/dsh-tool-memory'
  config:
    injectMaxBytes: 8192
    maxRecallResults: 8
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `injectMaxBytes` | 必填 | 注入快照的 UTF-8 字节预算；随附组合使用 `8192`；`0` 关闭注入但工具仍然可用；正值小于 `SNAPSHOT_MIN_BYTES` 时加载失败 |
| `maxRecallResults` | 必填 | 单次 `memory_recall` 调用最多返回的记录数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-memory)是受支持字段的完整来源。

### 每个工具做什么

`memory_write` 接收名称、类型、作用域、一行描述和内容，保存该记忆或替换同一作用域内同名的记忆；它回答 `Saved global memory "<name>".` 或 `Updated project memory "<name>".`。`memory_recall` 读取实时存储，包括快照之后保存的记忆：它接收可选的查询，在全局记忆和当前项目记忆的名称、描述或内容上做不区分大小写的子串匹配，最多返回 `maxRecallResults` 条最新匹配；每条匹配渲染为带标题的块，或在描述或内容未通过 `scan` 时渲染为拦截形式（文件不会被改名为 `.bak`）；没有匹配时回答 `No saved memories match.`。`memory_forget` 接收名称和作用域，回答 `Forgot <scope> memory "<name>".`。存储的拒绝会以工具错误的形式携带存储消息到达模型，例如来自没有项目根目录的会话的项目作用域写入、超长内容、被拦截的描述或内容，或已达上限的作用域。每个工具都需要一个拥有它的 agent 会话，因为会话的工作目录决定项目作用域。

### 快照

快照是本插件产生的一条持久的用户角色消息。它在对话的第一个步骤拍摄，并在压缩之后再次拍摄，无论当时是否注入了任何内容，并追加在用户消息和运行时上下文之后。可见记录按类型（`user`、`feedback`、`project`、`reference`）、再按名称、再以全局先于项目的顺序展平排序；没有 `Global:` / `Project:` 分节标题。对每条记录，若描述或内容未通过 `scan`，快照发出 `- [<type>, <scope>] <name> — [blocked]` 且从不内联正文；否则在回忆块的 UTF-8 字节放入剩余预算时发出该块，否则在索引行 `- [<type>, <scope>] <name> — <description>` 放得下时发出该行，否则省略该记录。单条记录大于剩余预算时只发索引行，从不截断。当有任何记录被省略时，追加 `… N more; use memory_recall`，并丢掉末尾的索引行，直到完整文本不超过 `injectMaxBytes`。第一步时为空的存储不注入任何内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释工具背后的设计决策并指向实现它们的代码；可观察行为已在[使用本包](#use-this-package)中覆盖。

### 设计理念

- **带贪心字节预算的快照。** 注入的上下文在放得进剩余 `injectMaxBytes` 时内联回忆块，否则发索引行，否则省略该记录，然后丢掉末尾的索引行直到完整文本落在预算内。快照在每次表面生成（surface generation）拍摄一次，后续轮次不刷新。
- **模型可见即已记录。** 快照是一条普通的 `user/message`，每次写入都是带 `tool/result` 的 `tool/call`，因此回放无需读取存储即可从会话日志重建每个模型请求。
- **由投影记录拍摄机会是否已用。** `memoryCatalog` 投影为 `stateVersion: 2`，状态为 `{ taken: boolean }`。它将 `step/start` 与本插件自己的快照消息折叠为 `{ taken: true }`，将 `compaction/summary` 折叠为 `{ taken: false }`。表面生成的第一个步骤之后，监听器不再读取存储。
- **不新增会话事件。** 存储是跨会话状态而非会话状态；工具调用已经记录了每次变更，因此本包不声明 `SessionEventMap` 成员。不发布不变量配套插件，因为本包不拥有任何会话事件，也没有自己的持久数据；快照投影只折叠已有的事件类型。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、提示词段落、工具与快照注册 |
| [`src/tools.ts`](src/tools.ts) | 三个 `defineTool` 定义、其结果渲染及通用调用卡片 |
| [`src/catalog.ts`](src/catalog.ts) | 快照渲染（`renderSnapshot`）、`SNAPSHOT_HEADER`、`SNAPSHOT_MIN_BYTES`、`memoryCatalog` 投影单元，以及 `agent/pre-step` 监听器 |
| [`src/prompt.ts`](src/prompt.ts) | 静态提示词段落文本 |

### 导出列表

本插件是函数/命名空间插件：它导出 `name` / `inject` / `Config` / `apply`，没有默认导出，因此 Loader 会保留其注入元数据（[事后分析 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。具名导出 `SNAPSHOT_HEADER`、`SNAPSHOT_MIN_BYTES` 和 `renderSnapshot` 分别是快照首行、最小的正 `injectMaxBytes`（该标题加上七位省略行的 UTF-8 字节数），以及带预算的渲染函数。

### 注入机制

监听器以前置方式注册在 `agent/pre-step` 上，先等待链上其余部分完成（因此该链中的 `compaction/summary` 可在同一步将 `taken` 折回 `false`），再把快照追加到 `enter` 决定中。它每个步骤运行一次，而不是每次重试运行一次。若 `state.taken` 为真或 `injectMaxBytes` 为 `0`，它原样返回该决定且不读取存储。否则它对 `visible(cwd)` 运行 `renderSnapshot`，并在已声明的用户批次和运行时上下文之后追加一条用户角色消息。`memoryCatalog` 投影为 `stateVersion: 2`，状态为 `{ taken: boolean }`，`init: () => ({ taken: false })`。它将 `step/start` 折叠为 `{ taken: true }`，将 `source.kind === 'tool-memory'` 且 `form === 'snapshot'` 的本插件 `user/message` 折叠为 `{ taken: true }`（fork 子会话的种子可能带有父会话的快照而没有父会话的 `step/start` 行），将 `compaction/summary` 折叠为 `{ taken: false }`。快照消息携带 `source: { kind: 'tool-memory', form: 'snapshot', sections: [{ name: 'memory-catalog', text }] }`。`tool-memory` kind 仅用于归属：未安装本插件的读取方会保留该消息及其 source 字段。

### 呈现

每个工具把调用呈现为通用卡片（`Save memory`、`Recall memories`、`Forget memory`），以参数作为原始输入；Web 客户端通过通用工具行渲染已记录的调用与结果，没有专门的卡片。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Memory 子系统](../../../docs/subsystems/memory.zh.md)——存储的请求与结果类型以及生成的服务 API。
- [memory 组地图](../README.zh.md)——同级组页面及其包表格。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory)——模型接收的三个工具 schema。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-memory)——每个受支持的配置字段及其源声明。
- [第一方持久记忆 Agent Note](../../../.agents/notes/implemented/feature/2026-09-19-first-party-durable-memory.zh.md)——设计决策及其胜过的备选方案。
- [第三方记忆 MCP 指南](../../../docs/user/guide/mcp-memory.zh.md)——这些工具与之共存的默认关闭的厂商覆盖配置。

-----

<a id="model-experience"></a>
## 模型体验

### 提示词段落

#### 模型看到什么

系统提示词 `TOOL_MEMORY` 位置的一个静态段落。

##### 该字段的逐字文本

```markdown
You have durable memory that persists across sessions. When saved memories exist, one snapshot of them is added to the conversation when it starts: some entries with their full content, the rest as a one-line index. The snapshot is not refreshed during the conversation; after context compaction a new snapshot is added. Memories you write or forget now are confirmed in the tool results and appear in the next snapshot. Call memory_recall to read an entry the snapshot lists only as an index line, or to find memories saved after the snapshot. Save a memory with memory_write when you learn a fact that stays true in every session. Write declarative statements, not imperatives: "The user prefers concise answers", not "Always answer concisely". Do not save task progress, transient state, secrets, or anything the repository already records. Remove a memory that is wrong or no longer applies with memory_forget.
```

#### Token 影响

插件挂载后，每个请求都有固定开销。

#### KV Cache 影响

插件保持挂载时前缀稳定；挂载或卸载它会改变系统提示词并使前缀失效。

### 工具 schema

#### 模型看到什么

生成的 [`memory_write`、`memory_recall` 与 `memory_forget` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory)：`memory_write` 需要 `name`、`type`、`scope`、`description` 和 `content`，其中 `type` 与 `scope` 为枚举；`memory_recall` 接收可选的 `query`；`memory_forget` 需要 `name` 与 `scope`。

#### Token 影响

工具可见的每个请求都有固定的 schema 开销。

#### KV Cache 影响

定义与可见性不变时前缀稳定。

### 记忆快照

#### 模型看到什么

一条列出可见记忆的用户角色消息，追加在已声明的用户消息和运行时上下文之后。`<type>` 是 `user`、`feedback`、`project`、`reference` 之一；`<scope>` 是 `global` 或 `project`。内容块使用回忆文法；索引行与拦截索引行使用下面的形式。内容块彼此之间、以及内容块与索引行组之间用一个空行分隔；连续的索引行紧邻；省略行紧跟最后一条，没有额外空行。省略行只在至少丢掉一条记录时出现。第一步时为空的存储不添加任何内容。

##### 该字段的逐字文本

```markdown
Saved memories (snapshot):
## <name> [<type>, <scope>]
<description>

<content>

- [<type>, <scope>] <name> — <description>
- [<type>, <scope>] <name> — [blocked]
… N more; use memory_recall
```

#### Token 影响

每次表面生成一份快照，至多 `injectMaxBytes` 个 UTF-8 字节。第一步时为空的存储直到压缩之前都不添加任何内容。

#### KV Cache 影响

仅追加在可复用的请求前缀之后；在同一次表面生成内从不刷新。只在压缩造成的系列中断处再次添加。fork 子会话在其种子中继承该快照，不会再添加一份。

### 工具调用历史与结果

#### 模型看到什么

每次调用都保留其参数。`memory_write` 返回 `Saved <scope> memory "<name>".` 或 `Updated <scope> memory "<name>".`；`memory_forget` 返回 `Forgot <scope> memory "<name>".`；`memory_recall` 返回 `No saved memories match.` 或按下面的成功形式为每条记忆返回一个块；当描述或内容未通过 `scan` 时，该块改为拦截形式。稳定的失败包括 `Error: <tool> requires an owning agent session`、存储的 `MemoryError` 消息（无效名称、空的或超长的描述或内容、被拦截的描述或内容、已达上限的作用域、`project scope is unavailable …; use scope "global"`，以及 `no <scope> memory named "<name>"`），以及注册表的 schema 拒绝。

##### 该字段的逐字文本

```markdown
## <name> [<type>, <scope>]
<description>

<content>
```

##### 被拦截回忆的逐字文本

```markdown
## <name> [<type>, <scope>]
[blocked]
```

#### Token 影响

写入与遗忘的结果是简短的一行。回忆结果随返回的记忆增长，最多 `maxRecallResults` 条正文、每条最多为存储的 `maxRecordBytes`，并保留到压缩为止。

#### KV Cache 影响

仅追加；新可见的内容跟在可复用的请求前缀之后，不会使现有条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了工具何时不适用。它们是当前的包约束，而不是任务待办。

- **第一步时存储为空**——第一步时存储为空的对话直到压缩之前都不会得到快照，即使之后写入了记忆；这些写入由工具结果确认。
- **同一 Web 宿主中的兄弟会话**——兄弟对话共享存储，但各自拍摄自己的快照；一个对话中的写入出现在兄弟会话的快照中，要等到该兄弟下一次压缩或新对话。
- **按字节而非 token**——`injectMaxBytes` 统计 UTF-8 字节，因此多字节描述组成的快照每个 token 能容纳的条目少于预算所暗示的数量。
- **没有专门的 Web 卡片**——调用与结果通过通用工具行渲染；没有记忆面板，也没有从 UI 列出或编辑记忆的命令。
- **没有跨进程刷新**——回忆与下一份快照读取的是本进程自身的存储视图，因此其他进程写入的记忆只有在存储重新打开后才会出现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付的行为、限制与已接受的理由位于上文各节、包代码以及链接的 Agent Notes 中。

#### 未来：记忆面板

一个用于列出、编辑和删除记忆的 Web 面板会通过宿主控制器而非会话日志读取存储。目前尚无设计；触发条件是通用工具行被证明不足以支持整理。

</details>
