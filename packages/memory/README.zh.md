---
description: "memory 组地图：跨会话的持久记忆存储及其面向模型的工具与目录，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/memory

[English](README.md) | 中文

## 概述

memory 组让 agent（智能体）跨会话保留事实：用户是谁、偏好怎样的工作方式，关于如何做事的反馈，关于某个项目的持久事实，以及指向外部资源的指针。一个包拥有存储，在 harness home 下为每条记忆保存一个 JSON 文档；另一个包向模型提供三个工具，并在每个会话开始时注入已保存记忆的目录。这里没有任何东西会连接厂商记忆服务、需要嵌入模型或在后台运行。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`memory`](memory/README.zh.md) | 基于存储 domain 数据形式的持久全局与项目级记忆记录：写入、回忆、遗忘，以及某个工作目录可见的记录 | `ctx.memory` |
| [`tool-memory`](tool-memory/README.zh.md) | 模型工具 `memory_write`、`memory_recall`、`memory_forget`，注入的记忆目录，以及说明何时记忆的提示词段落 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Memory 子系统](../../docs/subsystems/memory.zh.md)——存储的请求与结果类型、磁盘上的记录布局，以及生成的服务 API。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory)——模型接收的三个工具 schema。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-memory)——存储与工具的每个受支持配置字段。
- [第一方持久记忆 Agent Note](../../.agents/notes/implemented/feature/2026-09-19-first-party-durable-memory.zh.md)——设计决策及其胜过的备选方案。
- [第三方记忆 MCP 指南](../../docs/user/guide/mcp-memory.zh.md)——本组与之共存的默认关闭的厂商记忆覆盖配置。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
