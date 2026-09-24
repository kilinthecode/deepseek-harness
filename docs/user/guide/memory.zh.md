# 跨会话记忆

[English](memory.md) | 中文

DeepSeek Harness 为 agent（智能体）保存持久记忆：你是谁、你喜欢怎样工作，你对工作方式给出的反馈，关于某个项目的持久事实，以及指向工单或仪表盘等外部资源的链接。在一个会话中写入的记忆，在同一 harness home 下的每个后续会话都可用，不需要厂商服务、embedding 模型或后台进程。随附的 `headless` profile 以及 `standard`、`ptc`、`cordis` 三个 Web agent 预设包含它；`minimal` 预设不包含。

## agent 如何使用记忆

当 agent 能看到已保存的记忆时，模型会收到一份记忆目录：每条记忆占一行，列出类型、名称和一行描述。开始时已有记忆的会话在第一次模型请求之前收到目录；开始时没有记忆的会话在第一条记忆保存后随即收到。此后已保存的记忆发生变化时，新目录会在下一轮开始时送达；上下文压缩之后也会再次发送目录。模型用 `memory_recall` 读取一条记忆的完整内容，用 `memory_write` 保存或替换一条记忆，用 `memory_forget` 删除一条记忆。

你可以直接驱动它：

> 记住我更喜欢 pnpm 而不是 npm。

> 你记得关于我的哪些事？

> 忘掉名为 prefers-pnpm 的记忆。

模型自行决定什么值得保留。它的指令要求它保存偏好、反馈、项目事实和参考资料，绝不保存任务进度、临时状态、密钥，或仓库中已有记录的内容。

## 类型与作用域

每条记忆属于四种类型之一：`user`（你是谁及你的偏好）、`feedback`（如何做事、纠正）、`project`（项目的事实与约束）或 `reference`（指向外部资源的链接）。

每条记忆还有一个作用域。`global` 记忆在同一 harness home 下的每个会话中可见。`project` 记忆只在工作目录位于同一项目内的会话中可见，项目通过从工作目录向上查找第一个包含 `.git` 条目的目录来确定。不在任何项目内的会话只能读写全局记忆。

## 查看、编辑或删除记忆

每条记忆都是 harness home（`~/.dsh`，或 `DSH_HOME` 指定的目录）下的一个可读 JSON 文件：

```text
~/.dsh/storages/memory/global/<name>.json
~/.dsh/storages/memory/project/<slug>__<name>.json
```

项目 `<slug>` 是项目目录名加上由其完整路径派生的八个十六进制字符。用任意编辑器编辑文件，或删除文件以忘掉该记忆。无法解析的文件会在存储打开时被移到一旁，命名为 `<name>.json.bak.<timestamp>`，其他记忆仍然可用。[存储包 README](../../../packages/memory/memory/README.zh.md) 记录了记录的各个字段。

## 配置或关闭

存储和工具是两个组合配置项：`memory` 与 `tool-memory`，其取值由随附的 [base bundle](../../../packages/bundle/base/cordis.patch.yml) 设定。存储限制每个作用域的记忆数量（`maxRecords`）和单条记忆的字节数（`maxRecordBytes`）；工具限制目录字节数（`injectMaxBytes`）和单次回忆返回的记忆数（`maxRecallResults`）。生成的[配置目录](../../config-catalog.zh.md#deepseek-aidsh-memory)列出了全部字段。

在用户补丁层中覆盖它们：针对单个 profile 使用 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，针对所有 profile 使用 `$DSH_HOME/cordis.patch.yml`。补丁会整体替换该配置项的 `config`，因此必须写出每个必填字段。下面的写法保留工具但停止注入目录：

```yaml
- id: tool-memory
  config:
    injectMaxBytes: 0
    maxRecallResults: 8
```

下面的写法从 headless profile 中移除工具和目录，同时保留已保存的记忆：

```yaml
- id: tool-memory
  disabled: true
```

在 Web 上，工具属于 agent 预设；需要没有这些工具的会话时选择 `minimal` 预设。

## 限制

- 移动或重命名项目目录会使其项目记忆成为孤儿，因为项目记忆以其根目录的完整路径作为键；请在新位置重新写入。
- 长期运行的 `dsh web` 宿主在启动时读取存储，因此手工编辑以及其他进程（例如旁边的一次 headless 运行）写入的记忆只有重启后才会出现。
- 回忆用一个不区分大小写的短语匹配记忆的名称、描述和内容；没有排序打分或语义搜索。
- 记忆工具的调用在 Web UI 中显示为通用工具行；目前还没有记忆面板。

通过 MCP 连接的第三方记忆服务器是另一条默认关闭的路径，见[连接第三方记忆 MCP 服务](mcp-memory.zh.md)；两者可以同时启用。
