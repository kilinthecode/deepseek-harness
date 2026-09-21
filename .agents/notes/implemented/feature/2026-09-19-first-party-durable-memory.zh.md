# Agent Note: First-party durable memory

Status: implemented

[English](2026-09-19-first-party-durable-memory.md) | 中文

## Problem

agent（智能体）在会话之间会忘记一切。用户表达过的偏好、他们对工作方式给出的反馈、关于某个项目的持久事实以及指向外部资源的链接，每次都必须重新说明，或者手工写进工作区指令文件。唯一的记忆路径是面向第三方服务器的默认关闭的 MCP 覆盖配置，而[第三方记忆 MCP 示例说明](../../archived/feature/2026-07-31-third-party-memory-mcp-examples.md)有意将其置于产品之外：没有厂商适配器、没有记忆服务、没有安装界面。这一决定留下了一个空白：需要一种不依赖厂商、不需要嵌入模型、不需要后台进程，并且足够持久、能够经受崩溃、两个并发进程和手工编辑的记忆。

## Decision

新的 `packages/memory/` 组中的两个包提供第一方记忆。

`@deepseek-ai/dsh-memory` 是 `ctx.memory` 上的 Service Definition 与 Provider：基于现有存储 domain 数据形式的一个 `memory` domain，采用逐记录布局，包含以记忆名称为键的 `global` 表和以 `<project slug>__<name>` 为键的 `project` 表。一条记录携带 `name`、`type`（`user`、`feedback`、`project`、`reference`）、`scope`（`global`、`project`）、最多 256 个字符的一行 `description`、受 `maxRecordBytes` 限制的 `content`、项目记录的 `projectRoot`，以及绝不会到达模型的 ISO 时间戳。记录在打开时由 zod 以 `backup-and-skip` 校验，因此弄坏某个文件的手工编辑只会把该文件移到一旁并保留其余记录。存储对全局作用域和每个项目分别执行 `maxRecords`，通过从会话工作目录向上查找 `projectRootMarkers` 条目来解析项目根目录，并在无法解析根目录时让项目作用域的操作明确失败。

`@deepseek-ai/dsh-tool-memory` 是 Consumer：`ctx.tools` 上的 `memory_write`、`memory_recall` 和 `memory_forget`，位于 `TOOL_MEMORY` 位置、说明何时记忆的静态提示词段落，以及以 `source.form: 'snapshot'` 的 `user/message` 注入的可见记忆目录。`memoryCatalog` 会话投影折叠插件自身的目录消息，并在 `compaction/summary` 时重置；前置的 `agent/pre-step` 监听器在投影为空时的任意步骤、某轮第一步渲染出与投影不同的目录时，以及压缩之后注入；当某轮第一步发现存储在目录已送达模型之后被清空时，它注入一份唯一条目行为 `No saved memories.` 的目录，使已遗忘的条目不再被依赖。正文只能通过 `memory_recall` 到达模型，受 `maxRecallResults` 和存储的字节上限约束。目录受 `injectMaxBytes` 约束；`0` 关闭注入。

不新增任何会话事件。每个模型可见的输入都是已有的事件类型：目录是一条 `user/message`，每次变更都是带有 `tool/result` 的 `tool/call`。因此本包不发布不变量配套插件，也不记录持久化类型变更。

base 组合包在宿主平面挂载存储，并把工具挂载在 `tool-todo` 旁边；Web 组合包在宿主平面禁用工具，而 `standard`、`ptc` 和 `cordis` 预设按会话挂载它们，因为一个 domain 在每个进程中只打开一次，而预设按 agent 挂载工具。

## Storage layout

使用 JSON 后端时，全局记忆是 `<storages>/memory/global/<name>.json`，项目记忆是 `<storages>/memory/project/<slug>__<name>.json`，其中 slug 是项目目录经过清理的基础名加上根目录 SHA-1 的八个十六进制字符。每个文件保存 `{ "version": 1, "record": … }`。不同记录是不同文件；两个进程写入同一记录时以最后一次完整的原子发布为准，继承 JSON 后端的约定。SQLite 只需在 domain 插件上加一行 `routes: { memory: sqlite }`。

## Alternatives considered

**带 front matter 的 Markdown 文件加索引文件。** 对人友好、对 git 友好，但存储 domain 已经提供的每项持久性属性——原子发布、schema 校验、损坏记录隔离、后端路由——都得手工重写，而索引文件会成为第二条写入路径并带来自己的并发问题。逐记录 JSON 保持文件可读可编辑并删除了这些代码。推迟到手工编辑 JSON 被证明是真正的阻碍时再考虑。

**一个包同时持有存储、工具和注入。** 纸面上更小，但 Web profile 按 agent 预设挂载工具，而存储 domain 在每个进程中只打开一次，因此单包要么按预设打开 domain（被 domain facility 拒绝），要么把工具强行放到宿主平面、对包括 `minimal` 在内的每个预设生效。goal/tool-goal 的拆分正是仓库对这种形态的模板。

**带不变量配套插件的 `memory/write` 与 `memory/forget` 会话事件。** 模型团队的合并方案为 UI 渲染和回放提出了它们。它们对可重建性并非必要：工具调用与结果已经记录了每次变更，而存储是跨会话状态而非会话状态。去掉它们同时移除了不变量配套插件、持久化变更记录和目录再生成。未来的记忆面板会通过宿主控制器读取存储。

**每次写入后重新注入目录，并用代数计数器控制。** 在模型刚做出的写入之后重发整份目录只会消耗 token 而不带来任何信息。在某轮第一步把渲染的目录与投影中的上一份比较，只用一个可空字符串的投影状态就覆盖了本进程任何会话的写入、手工编辑和压缩。

**按类型限制目录条目数。** 第二个旋钮，用来防止某一类型挤占其他类型。按类型等级（`user`、`feedback`、`project`、`reference`）再按名称排序，在单一字节预算下提供了同样的保护。

**为记忆增加 `MessageSourceMap` 成员。** 现有的 `plugin` 来源配合 `form: 'snapshot'` 和命名的 sections 已经携带了文本和取代语义；新的来源种类会在没有消费者的情况下扩大联合类型。

**在回忆路径中使用语义搜索或 LLM。** v1 拒绝：它会破坏无密钥回放的确定性，并给读取增加模型依赖。先交付在名称、描述和内容上的子串匹配；引入更多能力的触发条件是可度量的回忆未命中。

**仓库内的 `<project>/.dsh/memory/` 存储。** 可以让团队提交事实，但需要位于 harness home 之外的存储根目录和第二个 domain。推迟到某个团队必须通过 git 共享记忆时再考虑。

## Consequences

agent 在同一 harness home 下跨会话、跨 profile 保留用户偏好、反馈、项目事实和参考资料，每个会话的开销有界，且不依赖厂商、嵌入或守护进程。记忆是人可以阅读、编辑或删除的普通 JSON 文件。每次注入和变更都可以从会话日志回放。

代价是：进程只有在 domain 重新打开时才能看到其他进程的写入，回忆只支持子串匹配，目录预算按字节而非 token 计算，并且除了通用工具行之外没有用于整理的 UI。同时挂载厂商记忆覆盖配置的组合依赖于互不相同的工具名称以及提示词段落中不要镜像事实的指示。

## Testing

单元套件覆盖 domain schema、项目根目录发现、基于真实 JSON 后端的存储（上限、隔离、重新打开、隔离损坏记录、同一根目录上的两个存储）、通过真实工具注册表运行的工具、目录渲染以及通过真实预步骤瀑布流运行的注入门控，以及每个包的真实 Loader 组合。一个 agent 循环集成套件用脚本化模型驱动真实工具，并断言目录在日志和模型请求中的位置。一个无密钥的 headless 进程测试在一次运行中写入，并在同一 harness home 上的第二次运行中回忆。一个无密钥的双进程测试让两个 Node 子进程同时向同一根目录发布不同的和共享的记录，并断言每个文件都是一次完整的发布、没有任何文件被隔离。一个需要密钥的套件让真实模型在一个会话中写入记忆，并在同一存储上的全新会话中于第一次请求之前收到目录、调用 `memory_recall` 并据此作答。两个无密钥的录制场景运行随附的 headless profile：`memory-catalog-recall` 预置一条全局记录并让模型先回忆再写入，`memory-project-forget` 让模型通过提交的 `.dsh-project` 根目录标记写入一条项目记忆、收到目录的 `Project:` 分节并将其遗忘。`snapshots/` 下的录制语料在每个随附 profile 中引用提示词段落和工具 schema，因此该文本的每次变更之后都要做一次无密钥刷新。
