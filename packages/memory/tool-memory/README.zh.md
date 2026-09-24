---
description: "基于持久记忆存储的模型侧记忆工具：memory_write、memory_recall、memory_forget，注入每个会话的记忆目录，以及说明何时记忆的提示词段落，供选择、配置或调试这些工具的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

## 概述

`dsh-tool-memory` 让 agent（智能体）跨会话记忆。它基于 [`dsh-memory`](../memory/README.zh.md) 为模型提供三个工具：`memory_write` 保存或替换一条记忆，`memory_recall` 读取匹配的记忆，`memory_forget` 删除一条。会话一旦有可展示的已保存记忆，模型就会收到一份目录，每条记忆占一行，列出类型、名称和描述；存储发生变化时在下一轮发送新目录，压缩之后再次发送。一段简短的提示词段落说明何时该保存、何时不该。两个配置值分别限制目录字节数与回忆条数。

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
    injectMaxBytes: 4096
    maxRecallResults: 8
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `injectMaxBytes` | 必填 | 注入目录的 UTF-8 字节预算；`0` 关闭注入但工具仍然可用 |
| `maxRecallResults` | 必填 | 单次 `memory_recall` 调用最多返回的记录数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-memory)是受支持字段的完整来源。

### 每个工具做什么

`memory_write` 接收名称、类型、作用域、一行描述和内容，保存该记忆或替换同一作用域内同名的记忆；它回答 `Saved global memory "<name>".` 或 `Updated project memory "<name>".`。`memory_recall` 接收可选的查询，在全局记忆和当前项目记忆的名称、描述或内容上做不区分大小写的子串匹配，最多返回 `maxRecallResults` 条最新匹配并渲染为带标题的块；没有匹配时回答 `No saved memories match.`。`memory_forget` 接收名称和作用域，回答 `Forgot <scope> memory "<name>".`。存储的拒绝会以工具错误的形式携带存储消息到达模型，例如来自没有项目根目录的会话的项目作用域写入、超长内容或已达上限的作用域。每个工具都需要一个拥有它的 agent 会话，因为会话的工作目录决定项目作用域。

### 目录

目录是本插件产生的一条持久的用户角色消息。它先列出全局记忆，再列出当前项目的记忆；每个分节内的条目按类型（`user`、`feedback`、`project`、`reference`）再按名称排序。当预算截断条目时，最后一行说明省略了多少条并指向 `memory_recall`。模型在第一个有可见记忆的步骤看到它（存储已有记忆时是会话的第一步，否则是有记忆保存之后的第一个步骤），在后续某轮的第一步、当存储的可见内容发生变化时再次看到，在压缩遮蔽了之前的目录后的下一步又会再次看到。一直为空的存储不注入任何内容；在目录已送达模型之后被清空的存储会在下一轮注入一份唯一条目行为 `No saved memories.` 的目录，让模型不再依赖已被遗忘的条目。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释工具背后的设计决策并指向实现它们的代码；可观察行为已在[使用本包](#use-this-package)中覆盖。

### 设计理念

- **注入目录而非正文。** 注入的上下文是索引；正文通过 `memory_recall` 获取，因此无论存在多少记忆，每个会话的开销都受 `injectMaxBytes` 约束。
- **模型可见即已记录。** 目录是一条普通的 `user/message`，每次写入都是带 `tool/result` 的 `tool/call`，因此回放无需读取存储即可从会话日志重建每个模型请求。
- **由投影决定何时注入。** `memoryCatalog` 投影折叠本插件自己的目录消息和 `compaction/summary`；预步骤监听器把新渲染的目录与投影中的上一份比较，因此该决定是日志加存储当前内容的函数。
- **不新增会话事件。** 存储是跨会话状态而非会话状态；工具调用已经记录了每次变更，因此本包不声明 `SessionEventMap` 成员。不发布不变量配套插件，因为本包不拥有任何会话事件，也没有自己的持久数据；目录投影只折叠已有的事件类型。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、提示词段落、工具与目录注册 |
| [`src/tools.ts`](src/tools.ts) | 三个 `defineTool` 定义、其结果渲染及通用调用卡片 |
| [`src/catalog.ts`](src/catalog.ts) | 目录渲染、`memoryCatalog` 投影单元，以及 `agent/pre-step` 监听器 |
| [`src/prompt.ts`](src/prompt.ts) | 静态提示词段落文本 |

### 导出形状

本插件是函数/命名空间插件：它导出 `name` / `inject` / `Config` / `apply`，没有默认导出，因此 Loader 会保留其注入元数据（[事后分析 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

### 注入机制

监听器以前置方式注册在 `agent/pre-step` 上，等待链上其余部分完成后，把目录追加到 `enter` 决定中。它每个步骤运行一次，而不是每次重试运行一次。在尚未注入任何内容时，它在每个步骤都检查存储，因此新会话中的第一次写入之后，下一步就会跟着目录；一旦表面上已有目录，只有每轮的第一步才会重新检查。`compaction/summary` 会把投影的目录重置为 `null`，因此下一步会重新注入。目录消息携带 `source: { kind: 'tool-memory', form: 'snapshot', sections: [{ name: 'memory-catalog', text }] }`；投影折叠的正是 sections 中的文本。`tool-memory` kind 仅用于归属：未安装本插件的读取方会保留该消息及其 source 字段。

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
You have durable memory that persists across sessions. When saved memories exist, a catalog of them (type, name, one-line description) is added to the conversation; the most recent catalog is current, and changes appear in a new catalog at the start of a later turn. Call memory_recall to read a memory's content before relying on it. Save a memory with memory_write when you learn something worth keeping beyond this session: who the user is and how they like to work (type user), feedback or corrections on how to do the work (type feedback), a durable fact or constraint about the current project (type project), or a pointer to an external resource such as a URL, ticket, or dashboard (type reference). Use scope project for facts about the current repository and scope global for everything else. Do not save task progress, transient state, secrets, or anything the repository already records. Writing an existing name in the same scope replaces it; remove a memory that turned out wrong with memory_forget.
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

### 记忆目录

#### 模型看到什么

一条列出可见记忆的用户角色消息。`<type>` 是 `user`、`feedback`、`project`、`reference` 之一；`Project:` 分节只在会话拥有带记忆的项目根目录时出现；最后一行只在 `injectMaxBytes` 截断了条目时出现。当会话曾看到的所有记忆都已被遗忘时，下一轮的目录是同一标题行加上单独一行 `No saved memories.`。

##### 该字段的逐字文本

```markdown
Saved memories (catalog; call memory_recall to read one):
Global:
- [<type>] <name> — <description>
Project:
- [<type>] <name> — <description>
… <omitted> more; use memory_recall
```

#### Token 影响

受 `injectMaxBytes` 限制；在第一个有可见记忆的步骤、可见记忆发生变化的某轮的第一步，以及压缩之后的下一步添加。一直为空的存储不添加任何内容；在目录之后被清空的存储只添加一次两行的空目录。

#### KV Cache 影响

仅追加；目录落在可复用的请求前缀之后，不会使现有条目失效。

### 工具调用历史与结果

#### 模型看到什么

每次调用都保留其参数。`memory_write` 返回 `Saved <scope> memory "<name>".` 或 `Updated <scope> memory "<name>".`；`memory_forget` 返回 `Forgot <scope> memory "<name>".`；`memory_recall` 返回 `No saved memories match.` 或按下面的形式为每条记忆返回一个块。稳定的失败包括 `Error: <tool> requires an owning agent session`、存储的 `MemoryError` 消息（无效名称、空的或超长的描述或内容、已达上限的作用域、`project scope is unavailable …; use scope "global"`，以及 `no <scope> memory named "<name>"`），以及注册表的 schema 拒绝。

##### 该字段的逐字文本

```markdown
## <name> [<type>, <scope>]
<description>

<content>
```

#### Token 影响

写入与遗忘的结果是简短的一行。回忆结果随返回的记忆增长，最多 `maxRecallResults` 条正文、每条最多为存储的 `maxRecordBytes`，并保留到压缩为止。

#### KV Cache 影响

仅追加；新可见的内容跟在可复用的请求前缀之后，不会使现有条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了工具何时不适用。它们是当前的包约束，而不是任务待办。

- **首次目录之前每步检查存储**——当会话表面上还没有目录时，每个步骤都会从存储的内存记录渲染目录；这项工作受存储上限约束，但并非零成本。
- **按字节而非 token**——`injectMaxBytes` 统计 UTF-8 字节，因此多字节描述组成的目录每个 token 能容纳的条目少于预算所暗示的数量。
- **没有专门的 Web 卡片**——调用与结果通过通用工具行渲染；没有记忆面板，也没有从 UI 列出或编辑记忆的命令。
- **没有跨进程刷新**——目录从本进程自身的存储视图刷新，因此其他进程写入的记忆只有在存储重新打开后才会出现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付的行为、限制与已接受的理由位于上文各节、包代码以及链接的 Agent Notes 中。

#### 未来：记忆面板

一个用于列出、编辑和删除记忆的 Web 面板会通过宿主控制器而非会话日志读取存储。目前尚无设计；触发条件是通用工具行被证明不足以支持整理。

</details>
