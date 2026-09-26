# 跨会话记忆

[English](memory.md) | 中文

DeepSeek Harness 为 agent（智能体）保存持久记忆：你是谁、你喜欢怎样工作，你对工作方式给出的反馈，关于某个项目的持久事实，以及指向工单或仪表盘等外部资源的链接。在一个会话中写入的记忆，在同一 harness home 下的每个后续会话都可用，不需要厂商服务、embedding 模型或后台进程。随附的 TUI（base 组合包）、`headless` profile 以及 `standard`、`ptc`、`cordis` 三个 Web agent 预设包含存储和工具；`minimal` 预设不包含。

## agent 如何使用记忆

当已保存的记忆存在时，模型会收到它们的一份快照：一部分条目带完整正文，其余为一行索引，受 `injectMaxBytes` 限制（随附组合为 8192 字节）。快照在对话开始时加入，并在上下文压缩（context compaction）之后再次加入。对话中的写入或遗忘不会刷新这份快照；那些变更在工具结果中确认，并出现在下一次快照中。开始时没有已保存记忆的对话在压缩之前不会得到快照。

你可以直接驱动它：

> 记住我更喜欢 pnpm 而不是 npm。

> 你记得关于我的哪些事？

> 忘掉名为 prefers-pnpm 的记忆。

模型用 `memory_recall` 读取快照里只显示为一行索引的记忆，或快照之后新保存的记忆。它用 `memory_write` 保存或替换一条记忆，用 `memory_forget` 删除一条记忆。

模型自行决定什么值得保留。它的指令要求它保存偏好、反馈、项目事实和参考资料，绝不保存任务进度、临时状态、密钥，或仓库中已有记录的内容。

在 TUI 以及 Web 的 `standard`、`cordis` 和 `ptc` 预设上，每 10 条用户消息之后会运行一次无人值守的回顾 fork（goal Round 消息不计入）。父对话看不到这次回顾；子会话只能添加新的记忆名称。`headless`、ACP 和 SDK 这些 profile 不运行此回顾。在 Web 上，回顾显示为带 `memory-review` 标签的普通 subagent 行。

## 类型与作用域

每条记忆属于四种类型之一：`user`（你是谁及你的偏好）、`feedback`（如何做事、纠正）、`project`（项目的事实与约束）或 `reference`（指向外部资源的链接）。

每条记忆还有一个作用域。`global` 记忆在同一 harness home 下的每个会话中可见。`project` 记忆只在工作目录位于同一项目内的会话中可见，项目通过从工作目录向上查找第一个包含 `.git` 条目的目录来确定。不在任何项目内的会话只能读写全局记忆。

## 查看、编辑或删除记忆

每条记忆都是 harness home（`~/.dsh`，或 `DSH_HOME` 指定的目录）下的一个可读 JSON 文件：

```text
~/.dsh/storages/memory/global/<name>.json
~/.dsh/storages/memory/project/<slug>__<name>.json
```

项目 `<slug>` 是项目目录名加上由其完整路径派生的八个十六进制字符。用任意编辑器编辑文件，或删除文件以忘掉该记忆。无法解析的文件会在存储打开时被移到一旁，命名为 `<name>.json.bak.<timestamp>`，其他记忆仍然可用。包含隐藏 unicode、看起来像提示词注入，或为 20 个及以上字符的带引号密钥赋值的写入会被拒绝。未通过该扫描的已存文件不会被改名为 `.bak`；快照和回忆以 `[blocked]` 显示它，而不内联正文。[存储包 README](../../../packages/memory/memory/README.zh.md) 记录了记录的各个字段。

## 配置或关闭

存储、工具和回顾是三个组合配置项：`memory`、`tool-memory` 与 `memory-review`，其取值由随附的 [base bundle](../../../packages/bundle/base/cordis.patch.yml) 设定。存储限制每个作用域的记忆数量（`maxRecords`）和单条记忆的字节数（`maxRecordBytes`）；工具限制快照字节数（`injectMaxBytes`，随附为 8192）和单次回忆返回的记忆数（`maxRecallResults`）；回顾统计两次 fork 之间的用户类消息（`reviewEveryUserTurns`，随附为 10），并限制子会话步骤（`maxReviewSteps`，随附为 8）。生成的[配置目录](../../config-catalog.zh.md#deepseek-aidsh-memory)列出了全部字段。

在用户补丁层中覆盖它们：针对单个 profile 使用 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，针对所有 profile 使用 `$DSH_HOME/cordis.patch.yml`。补丁会整体替换该配置项的 `config`，因此必须写出每个必填字段。下面的写法保留工具但停止注入快照：

```yaml
- id: tool-memory
  config:
    injectMaxBytes: 0
    maxRecallResults: 8
```

下面的写法保持插件挂载但从不启动回顾：

```yaml
- id: memory-review
  config:
    reviewEveryUserTurns: 0
    maxReviewSteps: 8
```

下面的写法从 headless profile 中移除工具和快照，同时保留已保存的记忆：

```yaml
- id: tool-memory
  disabled: true
```

在 Web 上，工具和回顾属于 agent 预设；需要没有这些工具的会话时选择 `minimal` 预设。

随附 profile 关闭全文会话搜索和 session-query 工具。若要让模型搜索先前会话，请应用[会话搜索覆盖配置](../../../apps/cli/config/examples/session-query/README.zh.md)中的 overlay。该覆盖配置不会用 LLM 摘要会话。

## 限制

- 移动或重命名项目目录会使其项目记忆成为孤儿，因为项目记忆以其根目录的完整路径作为键；请在新位置重新写入。
- 同一 Web 宿主中的兄弟对话共享存储，但各自拍摄自己的快照；一个对话中的写入出现在兄弟对话的下一次压缩之后，或出现在新对话中。其他进程（例如长期运行的 `dsh web` 宿主旁边的一次 headless 运行）写入的记忆只有在存储重新打开（重启）后才会出现。
- 回忆用一个不区分大小写的短语匹配记忆的名称、描述和内容；没有排序打分或语义搜索。
- 记忆工具的调用在 Web UI 中显示为通用工具行；目前还没有记忆面板。回顾子会话是带 `memory-review` 标签的普通 subagent 行。

通过 MCP 连接的第三方记忆服务器是另一条默认关闭的路径，见[连接第三方记忆 MCP 服务](mcp-memory.zh.md)；两者可以同时启用。
