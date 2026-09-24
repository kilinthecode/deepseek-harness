---
description: "持久的 agent 记忆存储（ctx.memory）：基于存储 domain 数据形式、以 JSON 文档保存的全局与项目级记录，提供写入、回忆、遗忘以及按工作目录判定的可见性，供选择、配置或调试该存储的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

[English](README.md) | 中文

## 概述

`dsh-memory` 让 agent（智能体）的记忆跨会话保留。每条记忆是一条小记录，包含名称、类型（`user`、`feedback`、`project` 或 `reference`）、作用域（`global` 或 `project`）、一行描述及其内容，并在 harness home 下保存为一个可读的 JSON 文件。存储会校验每次写入，限制每个作用域可持有的记忆数量，并根据会话的工作目录解析当前项目，使项目记忆与其仓库保持在一起。凡是希望 agent 记住事情的地方都可以挂载它；`dsh-tool-memory` 为模型提供工具与目录。

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

当组合需要不依赖厂商服务的持久跨会话记忆时使用本包：在宿主平面基于存储栈（`dsh-storage`、诸如 `dsh-storage-json` 的后端，以及 `dsh-storage-domain`）挂载一次，然后在需要模型读写记忆的地方挂载 [`dsh-tool-memory`](../tool-memory/README.zh.md)。

### 何时选择

用于 agent 应从一个会话带到下一个会话的事实：偏好、工作方式反馈、项目约束和链接。不要用于会话内的工作状态（会话日志与压缩负责这部分），也不要用于大型文档（每条记录的内容有上限）。如果你想要带自有搜索的厂商记忆系统，请改用默认关闭的[记忆 MCP 覆盖配置](../../../docs/user/guide/mcp-memory.zh.md)；两者可以同时挂载。

### 最小配置

两个上限均为必填且无默认值：省略任一字段的组合会在加载时失败，非正值同样失败。

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- name: '@deepseek-ai/dsh-memory'
  config:
    maxRecords: 200
    maxRecordBytes: 4096
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxRecords` | 必填 | 全局作用域内、以及每个项目内各自的最多记录数；超过上限的写入会失败 |
| `maxRecordBytes` | 必填 | 单条记录内容的 UTF-8 字节上限 |
| `projectRootMarkers` | `['.git']` | 从会话工作目录向上查找时用于识别项目根目录的目录条目 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-memory)是受支持字段的完整来源。可通过 `dsh-storage-domain` 的 `routes` 将 `memory` domain 路由到其他后端（例如 `memory: sqlite`）；存储本身没有后端字段。

### 记忆存放在哪里

使用 JSON 后端时，每条记忆是一个文件：全局记录位于 `<root>/memory/global/<name>.json`，项目记录位于 `<root>/memory/project/<slug>__<name>.json`，其中 `<slug>` 是项目目录经过清理的基础名加上根路径哈希的八个十六进制字符。每个文件保存 `{ "version": 1, "record": { … } }`，可以放心手工阅读或编辑。存储打开时，无法解析或违反字段上限的文件会被移到一旁改名为 `<name>.json.bak.<timestamp>`，其余记忆仍然可用。上限覆盖每个字段：名称格式、256 个字符的描述、不超过当前 `maxRecordBytes` 的内容（因此调低上限会把更大的记录移到一旁）、至多 32,767 个字符的项目根目录，以及 ISO-8601 UTC 时间戳。

### 作用域与项目根目录

`global` 记忆在同一 harness home 下的每个会话中可见。`project` 记忆只在工作目录位于同一项目根目录内的会话中可见；项目根目录通过从会话 `cwd` 向上查找、直到第一个包含 `projectRootMarkers` 之一的目录来确定。当会话没有工作目录或其上方没有标记时，项目作用域的写入和遗忘会以 `project-root-unavailable` 失败，而 `recall` 与 `visible` 只返回全局记录。存储绝不猜测根目录。

### 每个操作做什么

`write` 校验名称（小写 kebab-case，1 到 64 个字符），修剪描述（最多 256 个字符）与内容（最多 `maxRecordBytes`），按本进程已加载或写入的记录执行作用域上限，并在返回 `created` 或 `updated` 之前持久地插入或替换记录。`recall` 在可见记录的名称、描述和内容上做不区分大小写的子串匹配，按最新优先、再按名称、再以全局先于项目的顺序返回，并受调用方的数量限制。`forget` 删除一条记录，不存在时以 `not-found` 失败。`visible` 返回所有全局记录加上当前项目的记录。每次拒绝都是带有稳定 `code` 和面向模型的消息的 `MemoryError`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释存储背后的设计决策并指向实现它们的代码；可观察行为已在[使用本包](#use-this-package)中覆盖。

### 设计理念

- **不新增持久化代码。** 存储是 `dsh-storage-domain` 的消费者：逐记录原子发布、打开时的 schema 校验，以及对损坏记录的隔离都是继承而来，而非重新实现。
- **人类可编辑的记录。** 每条记忆一个格式化的 JSON 文档，使存储可以用任何编辑器查看并手工比对。
- **显式作用域，绝不猜测根目录。** 项目身份只来自会话工作目录和配置的标记；缺少根目录是一个明确的错误，而不是悄悄回退到全局。
- **时间戳留在存储里。** `createdAt` 和 `updatedAt` 用于排序回忆结果，绝不会到达模型，因此录制的会话可以逐字节回放。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `MemoryStore` 服务（`ctx.memory`）、`Config`、请求与结果类型、`MemoryError` |
| [`src/domain.ts`](src/domain.ts) | 按存储构建 zod 记录 schema 与 `memory` domain 规范的函数，以及品牌化的名称与键类型 |
| [`src/project.ts`](src/project.ts) | 项目根目录发现与路径安全的项目键 |

### 生命周期

服务在其初始化期间打开 `memory` domain，因此注入 `memory` 的消费者总能看到已打开的存储，并随自身 fiber 关闭该 domain。一个 domain 在每个进程中只打开一次；这正是 Web profile 中存储位于宿主平面、而工具按 agent 预设组合的原因。

### 并发

不同记录是不同文件，因此两个进程写入不同记忆绝不会冲突。两个进程写入同一记录时，以最后一次完整发布为准，绝不会产生撕裂的文件。在同一进程内，存储的每次 `write` 与 `forget` 都按调用顺序在同一个串行区段中执行，该区段包含项目根目录查找、存在性检查、上限检查以及持久的写入或删除，因此并行工具调用或多个 agent 的重叠调用绝不会超出 `maxRecords`；同名重叠只对较早的调用报告 `created` 并保留其 `createdAt`；对同一记录的两次重叠遗忘，第二次报告 `not-found`。进程在打开时加载一次存储；其他进程写入的记忆只有在 domain 重新打开时才可见并计入上限，因此两个进程同时写入新名称时，合计可能超出 `maxRecords`。

### 没有不变量配套插件

不发布不变量配套插件，因为持久数据在打开时由 domain schema 校验、在每次写入时由存储校验，且本包不拥有任何会话事件，因此不存在可能分歧的独立观察。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Memory 子系统](../../../docs/subsystems/memory.zh.md)——请求与结果类型、记录布局，以及生成的服务 API。
- [memory 组地图](../README.zh.md)——同级组页面及其包表格。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-memory)——每个受支持的配置字段及其源声明。
- [Storage 子系统](../../../docs/subsystems/storage.zh.md)——存储所依赖的 domain 数据形式与后端。
- [第一方持久记忆 Agent Note](../../../.agents/notes/implemented/feature/2026-09-19-first-party-durable-memory.zh.md)——设计决策及其胜过的备选方案。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-memory`：它把存储的记录转换为注入的目录、工具 schema 以及模型读取的回忆结果。

#### KV Cache 影响

没有直接失效；命名的消费者拥有所有请求前缀变更。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义了存储何时不适用。它们是当前的包约束，而不是任务待办。

- **跨进程写入在重新打开时才可见**——进程在 domain 打开时读取一次存储，因此另一个进程写入的记忆（例如长期运行的 Web 宿主旁的一次 headless 运行）只有在 domain 重新打开后才可见并计入 `maxRecords`；两个进程写入同一记录时以最后一次完整发布为准。
- **仅支持子串回忆**——`recall` 是不区分大小写的子串匹配；没有排序打分、同义词处理或语义搜索。
- **没有仓库内存储**——项目记忆按项目根目录存放在 harness home 下，不会随仓库提交，也无法通过 git 共享。
- **项目身份是根目录的绝对路径**——项目记录保存其根目录，并以由该路径派生的 slug 作为键，因此移动或重命名仓库目录会使其项目记忆成为孤儿；新路径下的会话看不到它们，除非重新写入。
- **内容上限按字节计算**——`maxRecordBytes` 统计 UTF-8 字节，因此多字节字符的文字能容纳的字符数少于 ASCII。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付的行为、限制与已接受的理由位于上文各节、包代码以及链接的 Agent Notes 中。

#### 未来：通过 git 共享的项目记忆

团队可提交的 `<project>/.dsh/memory/` 存储需要位于 harness home 之外的存储 domain 根目录和第二个 domain。目前尚无设计；触发条件是某个团队必须通过仓库共享事实。

</details>
