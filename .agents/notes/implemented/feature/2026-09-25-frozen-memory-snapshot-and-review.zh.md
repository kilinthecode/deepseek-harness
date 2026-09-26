# Agent Note: Frozen memory snapshot and unattended review

Status: implemented

[English](2026-09-25-frozen-memory-snapshot-and-review.md) | 中文

## Problem

第一方持久记忆已经把偏好、反馈、项目事实和参考资料以 JSON 保存在 harness home 下。若在每一轮开始刷新注入列表，并在渲染文本变化时再次刷新，就会在可复用的请求前缀之后再追加一份副本，使后续轮次为该后缀付费，且无法对该前缀复用已预热的 KV Cache。把列表放进系统提示词会在没有 `systemPromptUpdate` 的模型上重建 node 0，并会通过 persona 插值 `{{cwd}}`。若无人值守的回顾方更改工具、persona 或模型，就会错过父级已缓存的前缀。保存在记忆正文中的注入文本会进入后续会话的模型请求。

## Decision

可见记忆的一份快照作为带 source 的 `user/message`，在一次 surface generation 的第一步加入，并在压缩（compaction）之后再次加入。`memoryCatalog` 投影为 `stateVersion: 3`，状态为 `{ taken: boolean; stepPending: boolean }`。`step/start` 在 `agent/request`/`prepareCall` 解析路由之前记录，而该异步阶段的取消既不提交系统提示词也不提交该步骤的消息，因此它只折叠为 `stepPending: true`；待定期间有一条 `user/message` 落盘则折叠为 `{ taken: true, stepPending: false }`，本插件自己的快照消息无条件折叠为同一状态，`step/end` 将待定状态折回 `false`，`compaction/summary` 将 `taken` 与 `stepPending` 都折为 `false`。无论是否实际注入，都会设置 `taken`，因此第一步时存储为空的会话在压缩之前不会得到快照；其间的写入由工具结果确认。前置的 `agent/pre-step` 监听器先 `await next()`，再把快照追加在已认领的用户消息和运行时上下文之后。恢复会从日志重新折叠 `taken` 与 `stepPending`。继承父级快照消息的 fork 子会话会折叠出 `taken === true`，不再注入第二份。

快照标题为 `Saved memories (snapshot):`。可见记录按类型顺序 `user`、`feedback`、`project`、`reference` 展平，再按名称，再以全局先于项目。每条记录在其回忆块的 UTF-8 字节放入剩余 `injectMaxBytes` 时内联该块，否则输出索引行，否则省略；大于剩余预算的单条记录只出现在索引中。描述或内容未通过 `scan` 时变为 `- [<type>, <scope>] <name> — [blocked]`，从不内联。随附的 `injectMaxBytes` 为 8192；`0` 关闭注入；正数且低于 `SNAPSHOT_MIN_BYTES` 时加载失败。

`scanMemoryText` 与 `MemoryStore.scan` 是安全不变量，不是 Config 字段。原始文本拒绝除制表符与换行以外的 C0 控制字符、全部 C1 控制字符，以及不可见与双向字符集 U+200B、U+200C、U+200D、U+2060、U+2062–U+2064、U+FEFF、U+202A–U+202E、U+2066–U+2069。匹配只用一份 NFKC 规范化副本，截断到 65,536 个 UTF-16 码元，再对照随附的威胁模式数组。`write` 在修剪和大小检查之后先扫描描述再扫描内容。发现为 `blocked-content`。写入描述中的换行为 `invalid-description`。已被另一项目记录占用的项目键为 `project-key-collision`。快照渲染和 `memory_recall` 用同一扫描生成占位，扫描发现从不触发 `backup-and-skip`。

`@deepseek-ai/dsh-memory-review` 在 `reviewEveryUserTurns` 条用户类消息之后（随附为 10；`0` 关闭），根据父级的 `agent/status` idle 通知启动一次进程内 fork。启动省略 `toolFilter`、`persona` 和 `agentOptions`。限制在 `agents.create` 于 `start()` 返回之前等待的串行 `agent/created` 期间安装到 `created.agent.ctx`：允许 `memory_recall`；仅当名称与作用域尚不可见时允许 `memory_write`；拒绝 `memory_forget` 和所有其他工具；在 `step > maxReviewSteps`（随附为 8）时拒绝。父模型看不到任何额外内容。base 组合包与 TUI 启用该插件；headless、ACP 和 SDK 将其禁用；Web 在 `standard`、`cordis` 和 `ptc` 预设上重新挂载。

威胁模式组与只添加的无人值守回顾沿用 Hermes Agent，采用 MIT 许可：[Hermes 记忆指南](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)与 [Hermes Agent 仓库](https://github.com/NousResearch/hermes-agent)。`packages/memory/memory/src/scan.ts` 改编自 [`tools/threat_patterns.py`](https://github.com/NousResearch/hermes-agent/blob/4c286ae7a0dcb86e70a7ad8c23c0f05c89e33ec3/tools/threat_patterns.py) 的正则，并带有该 MIT 声明。

存储与工具的拆分、JSON 布局，以及仅用于归属的 `tool-memory` source kind，仍见[第一方持久记忆说明](2026-09-19-first-party-durable-memory.zh.md)。

## Alternatives considered

### Why not refresh the catalog at every turn start?

在每一轮开始把渲染文本与上次注入文本比较，可以在同一会话中收入本进程的写入、手工编辑和兄弟会话写入，而不会留下陈旧副本。它也会在文本有差异的每一轮把新列表追加到可复用前缀之后，从而造成 generation 内抖动，且无法复用该后缀的前缀。冻结付出兄弟会话代价：一次写入出现在另一会话的下一次快照中（该会话压缩之后，或新会话中）。

### Why not put memory in the system prompt?

`deepseek-v4-pro` 没有 `systemPromptUpdate`，因此会话中途改写系统提示词会重建 node 0。persona 会插值 `{{cwd}}`，因此系统提示词中的记忆列表也会破坏跨 cwd 的前缀复用。模型可见输入必须能从会话日志重建；带 source 的 `user/message` 是已有事件类型。

### Why not prepend the snapshot before the claimed user message?

`agent-instructions` 写明认领的用户消息在前。time-context 已经追加每会话第一步消息，因此前置并不能换来稳定的跨会话前缀。前置还会让攻击者植入的用户角色记忆排在人类轮次之前。

### Why not group snapshots under Global and Project headers?

按类型优先展平会让项目作用域的 `user` 记录排在全局 `reference` 之前。作用域已经写在 `[<type>, <scope>]` 标签里。

### Why not make threat patterns a Config field?

组合可以把该列表留空。这些检查是 `scan.ts` 中的安全不变量，体现为一份导出的 `readonly` 数组。误报是源码变更，不是 Config 编辑，也不刷新提示词语料。

### Why not quarantine a record when snapshot or recall scan fails?

`backup-and-skip` 用于打开时 zod schema 失败。渲染时隔离会把仍能解析的手工编辑文件改名。`[blocked]` 占位保留文件，并告诉模型正文未被内联。

### Why not pass toolFilter, persona, or a routed model to the review child?

这些选项会让子会话的首次请求相对父级发生变化，从而失去 cache parity。子会话是持久的进程内 fork，使用与父级相同的路由、工具和 persona。只添加是 Hermes Agent 的无人值守回顾规则，在 `agent/created` 期间于子会话 `ctx` 的 `tools/pre-execute` 上强制执行。

### Why not a pre-compaction flush, a MemoryProvider ABC, a routed digest review, or LLM search summarization?

Hermes Agent 在 [`ea01bdce`](https://github.com/NousResearch/hermes-agent/commit/ea01bdce) 移除了压缩前刷新。MemoryProvider ABC 等到出现无法做成 MCP 覆盖配置的厂商再考虑。更便宜的路由摘要回顾等到有可度量的费用再考虑。在回忆路径中使用 LLM 摘要会破坏无密钥回放。

## Consequences

第一步之后的轮次复用请求前缀：快照追加在已认领的用户消息和运行时上下文之后，直到压缩才刷新。兄弟 Web 会话在下一次快照中看到新写入（压缩之后或新会话中）。开始时为空的会话在压缩之前没有快照。跨进程写入仍只在 domain 重新打开时可见。

无人值守回顾在进程仍存活时，每十轮用户类消息以缓存费率重放一次父级前缀。当父级接近压缩阈值时，子会话的第一步可能发生压缩，从而失去预热的缓存读取。Web 显示带 `memory-review` 标签的普通 subagent 行。

## Deferred

当 JSON 文件被证明不够用且已有录制 GIF 时再考虑 `/memory`；当通用工具行被证明不够整理时再考虑 Web 记忆面板；在测得美元成本之后再考虑路由摘要回顾；在首次无人值守丢失之后再通过 `ctx.approval.request` 做写入审批；当厂商无法做成 MCP 时再做 MemoryProvider ABC；在测得同一 cwd 冷预填、且 `{{cwd}}` 与 time-context 不再造成分叉之后再为跨会话共享做前置；当团队必须提交事实时再做 git 共享存储；在测得子串未命中之后再做语义回忆；当组合的 `toolFilter` 被选为执行手段时再禁止 subagent 写入记忆。

## Testing

存储扫描、键碰撞和单行描述测试位于 `packages/memory/memory/tests/`。快照每代一次、追加位置、预算和 `[blocked]` 测试位于 `packages/memory/tool-memory/tests/`。回顾间隔、只添加、创建先于执行以及缓存 e2e 测试位于 `packages/memory/memory-review/tests/`。`snapshots/sdk/memory-catalog-refresh` 固定压缩后的再次注入以及第二轮不刷新。`snapshots/session/memory-review-fork` 等待子轮次结束。提示词与工具描述冻结只刷新一次语料；memory-review 场景不得改写这些伴随文件。
