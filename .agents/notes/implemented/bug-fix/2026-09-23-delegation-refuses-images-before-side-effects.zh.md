# Agent Note: 委派在任何副作用发生之前拒绝子代理无法接受的图像

Status: implemented

[English](2026-09-23-delegation-refuses-images-before-side-effects.md) | 中文

## 问题

[Route-checked image prompts](../feature/2026-09-23-route-checked-image-prompts.zh.md) 关闭了 SDK 服务器和 headless 入口,但每条委派路径仍会在检查之前放行图像内容,或完全跳过检查:

- `TeamMailbox.sendAdmitted` 对任何目标都会追加 `team/message/queued`,不做 route 检查;纯文本的 teammate 随后会在接收端的 `assertImageCapable` 中失败并一直保持 queued,后续发往同一目标的文本消息也无法解堵。纯文本的 Lead 目标则完全跳过该闸门,因为 Lead 投递是 `root.steer()` 的直接调用,不在 `assertImageCapable` 守护的 continuable-child 路径之内,于是图像到达了 Lead 自己的纯文本投影,而不是被拒绝。
- `TeamRoster.spawnAdmitted` 在 continuable child 创建之前就追加了 provisioning 的 `team/member` 记录,因此针对纯文本继承 route 的、携带图像的首条 prompt 会在一次注定失败的 spawn 上烧掉 teammate 的名字和一个 member slot。
- Team 投影的图像 Zod schema 比声明的 `ImageAttachmentRef`/`ImageBlock` 类型更严格:一个真实的缩小尺寸引用(`originalDimensions`)或重放的 `offloaded` 标记会永久地在整个 Team 投影上设置 `state.failure`。
- `SubagentContinuationManager.startContinuable` 仅在物化子代理之后才检查图像能力(在 `submitMaterialized` 内部),因此拒绝仍会留下一个持久化的子 Session。
- 一次性(one-shot)的 `SubagentRuntime.start()` 完全没有图像检查:在任何拒绝之前,图像 prompt 就会到达 ACP、Claude Code、Codex 或 DSH SDK provider,而这些 provider 都不会跨进程边界转发图像字节。
- continuable child 向其自身父级(`sendToParent`)发起的 `sendMessage()` 调用没有图像检查:纯文本的父级会收到一条它实际上无法使用的图像消息。

## 决策

### 闸门位于做出决策的操作中,在其持久化或进程副作用之前

每条会解析 provider/model route 的委派路径都会在做出决策的位置应用相同的检查——`imageInputSupport(info) === 'unsupported'` 拒绝;provider、model、`llm` service 缺失,或 modality 列表未披露,则放行——先于该检查所要防止的副作用:

- `SubagentContinuationManager.startContinuable` 在捕获委派的策略覆盖、持有父级所有权并调用 `prepareContinuable` 之后,检查已解析的 child route,先于任何子级写入。provider 对 `prepareContinuable` 的同步贡献(fork 种子)与委派策略都在该检查的 await 之前捕获,与一次性路径保持的顺序相同。
- `SubagentRuntime.start()` 同步检查 `provider.imageInput`,先于 `provider.start` 以及该调用中的任何其他 await,因此它从不会延迟 provider 自己的 pre-first-await 工作(捕获的委派策略、fork 种子读取)。对于支持图像的进程内 provider,已解析 child route 的检查本身在 `startInProcessRun` 中运行(`packages/subagent/subagent-in-process-driver`),即 `spawn-in-process` 和 `fork-in-process` 共享的唯一 driver:它在该 driver 自己同步的 `captureDelegatedPolicyOverrides` 捕获之后、`ctx.agents.create()` 之前运行,针对的是 driver 传给 `create()` 的同一个 `resolveChildAgentOptions` 结果。`start()` 自身内部一个 await 的 route 检查会落在 provider 同步的 pre-first-await 捕获与其第一个真正的 await 之间,恰好破坏这些捕获所依赖的顺序。
- `TeamRoster.spawnAdmitted` 在 provisioning 的 `team/member` 追加之前检查继承的 child route(即 Lead 当前的委派 route,因为 spawn 不请求任何 per-child 覆盖)。
- `TeamMailbox.sendAdmitted` 在 `team/message/queued` 追加之前、journal 事务之外检查目标的 route——对 Lead 是活跃根 Agent 当前的委派 route,对 teammate 是 `dsh-subagent` 的 continuable-child 探针——因此 LLM route 查询从不会持有 journal 锁。preflight 块还会在 route 检查之前重复自我消息拒绝,因此一条发给自己的图像消息会报告 `TEAM_SELF_MESSAGE`,而不是一个误导性的图像拒绝。
- `SubagentContinuationManager.sendToParent` 在 `sendWaking` 之前检查活跃父 Agent 的 route。

这五个调用点共享同一个函数:`packages/subagent/subagent/src/image-capability.ts` 中的 `assertImageCapableRoute(ctx, provider, model, signal)`,构建于 `imageInputSupport` 之上。它抛出 `SubagentError('MODEL_DOES_NOT_SUPPORT_IMAGES')`;Team mailbox 和 spawn 闸门将同一消息重映射为 `TeamError('TEAM_IMAGES_UNSUPPORTED')`,以便模型看到一个 Team 拥有的错误码。

### `imageInput` 是 provider 的传输事实,而非启动时能力

`SubagentProvider` 在 `inheritsParentContext` 旁声明 `readonly imageInput: boolean`,而不是 `SubagentCapabilities` 中的新行。`SubagentCapabilities` 与 `SubagentStartRequest` 选项一一对应;图像内容是 prompt 数据,而不是调用方选择加入的选项。`spawn-in-process` 和 `fork-in-process` 声明 `true`(同一进程,同一附件存储)。另外四个进程外 provider 各自因不同的原因声明 `false`,而非一个共享的进程外理由:ACP 的 prompt 映射完全不携带图像块——`toAcpPrompt` 将内容映射为仅文本的 ACP prompt 部分,没有针对图像块的分支。DSH SDK provider 的子进程有自己的附件存储,跨该边界的字节编码被推迟。Claude Code 和 Codex 各自将任务映射为仅文本的 CLI prompt,`textTask` 会在子进程启动之前对任何非文本块抛出异常。

### Team 的 route 探针保持在公开 Service Definition 之外

`TeamMailbox` 需要 teammate 已解析的 LLM route——活跃 Activation 的 Agent 选项,否则是持久化描述符的 `agentProvider`/`agentModel`——与冷恢复(cold resume)已读取的来源相同。回退按来源进行:命名了任一字段的来源整体作为 route,只有两个字段都未命名的来源才整体回退到父级当前的委派 route,因此探针绝不会把 child 的 provider 与父级的 model 拼在一起。`packages/subagent/subagent/src/internal.ts` 中的 `assertContinuableChildAcceptsImages(runtime, parent, childId, signal)` 通过类型化的方括号属性访问调用 runtime 私有的 `requireContinuations()`,而不是为这一个 Team 调用方添加公开的 `SubagentRuntime` 方法;`SubagentContinuationManager.resolveChildRoute` 和 `.assertChildAcceptsImages` 保持为公开 API 从不导出的类上的包内部方法。其拒绝由该活跃 `runtime` 自己捆绑的 continuation manager 构造,因此它携带捆绑 runtime 条目的 `SubagentError` 类——其身份与 `internal.ts` 未改动的 `assertImageCapableRoute` 再导出所构造的不同:后者是当通过此 `/internal` 子路径到达的调用方(如 `assertTeamRouteAcceptsImages`,即 Lead 目标路径)直接调用该函数时所构造的。两种拒绝携带相同的 `error.code`(`MODEL_DOES_NOT_SUPPORT_IMAGES`),并且都扩展自 `dsh-llm` 的 `HarnessError`——一个共享的类身份,无论捆绑还是非捆绑的 `dsh-subagent` 都不会复制它。因此,`packages/experimental/agent-team/src/image-content.ts` 中的 Team 重映射以 `instanceof HarnessError` 为保护,并通过 `error.code` 匹配特定的拒绝,绝不用 `instanceof SubagentError`:任何通过该子路径到达的调用方——无论 teammate 还是 Lead 目标——都不得依赖该类的身份。

### Team 的 route 检查委托给 subagent 拥有的闸门

`packages/experimental/agent-team/src/image-content.ts` 不重新实现宽松的图像能力策略。`assertTeamRouteAcceptsImages` 调用 `assertImageCapableRoute`(从 `@deepseek-ai/dsh-subagent/internal` 再导出),并通过匹配 `error.code` 将其拒绝重映射为 `TeamError('TEAM_IMAGES_UNSUPPORTED')`;`assertTeamTargetAcceptsImages` 将 Lead 情形路由到同一个函数,将 teammate 情形路由到 `assertContinuableChildAcceptsImages`,因此一个 subagent 拥有的检查同时支撑两个委派表面,后续的策略变更无法在它们之间悄悄分叉。

### Team 准入剥离 `offloaded`,保留 `originalDimensions`

`packages/experimental/agent-team/src/image-content.ts` 克隆发往 Team mailbox 消息或 spawn prompt 的内容,并从每个图像块中移除 `offloaded`,因为 offload 是接收方针对自己的请求历史所做的 per-target 压缩决策;发送方的或重放副本的标记不得随被准入到另一个 Session 日志中的内容一起传播。`originalDimensions` 是持久化的 ref 元数据,予以保留。Team 投影的 `imageAttachmentSchema` 接受可选的 `.strict()` `originalDimensions` 对象,图像块 schema 接受可选的 `offloaded: z.literal(true)`,因此真实的(可能缩小尺寸的)引用或重放的 `offloaded` 标记可以正常往返,而不会毒害整个 Team 投影。事件和状态版本不变;`verify-persistence-changes` 报告无变化,因为这两个字段已在 `ImageAttachmentRef`/`ImageBlock` 上声明。

## 考虑过的替代方案

**`textOnlyTargetImages: 'refuse' | 'placeholder'` Team 配置。** 当前没有消费者需要 placeholder 策略,而且将发送方已记录的块重写为 placeholder 会使持久化记录与发送方实际发送的内容产生分歧。

**持久的 `team/message/rejected` 事件。** 一旦不支持的内容从不入队就不再需要;它会新增一个 `SessionEventMap` 根,需要同版本确认以及两个 SDK 的期望输出更新,却不提供任何拒绝路径尚未通过工具结果错误提供的行为。

**保持 Team 图像 Zod schema 不变,仅在写入时剥离。** `originalDimensions` 仍会在任何真实的缩小尺寸引用上毒害投影,因为只要图像被调整大小,normalization 就会设置它;无论剥离发生在哪里,schema 都必须放宽。

**用必需的 `SubagentCapabilities.imageInput` 行代替 `SubagentProvider` 字段。** Capabilities 与 `SubagentStartRequest` 选项一一对应;图像内容是通过每条路径(一次性、continuable 创建、后续投递)委派的 prompt 数据,而不是调用方请求的启动选项。

**为 Team mailbox 提供公开的 `SubagentRuntime.assertChildAcceptsImages()` 方法。** 一个外部调用方不足以证明扩大 Service Definition 是合理的;私有 continuation manager 读取在保持公开表面不变的同时,仍向 Team 提供冷恢复所使用的精确来源。

**将 `SubagentContinuationManager.assertImageCapable` 折叠进其调用点。** 该私有方法已经委托给 `assertImageCapableRoute`,因此每条委派路径共享同一个策略定义;折叠它只会改变调用点的写法。

**用 `images` 参数扩大 `subagent`/`send_message`/`spawn_teammate` 工具 schema。** 那是图像进入委派的传输——让模型将图像附加到 child prompt——与拒绝 child 无法接受的内容是两项独立的决策。无论由哪个调用方提供图像,这些闸门都同样生效。

## 影响

Team teammate 继承 Lead 的委派 route:`spawnTeammate()` 不请求 per-child 的 `agentOptions`,因此携带图像的首条 prompt 或同伴消息只能到达其继承 route 接受图像的 teammate;为某个 teammate 选择不同的模型是另一项独立的模型选择功能。这些闸门遵循 `imageInputSupport` 宽松的 `'undeclared'` 策略:它们只拒绝省略 `image` 的已声明 modality 列表,这与 `LlmRuntime` 将图像投影为占位文本的条件相同,因此目录条目未披露 modality 的 route,或为无法读取图像的模型声明了 `image` 的 route,会原样收到图像,只有其 provider 能拒绝它。ACP 和 DSH SDK provider 会拒绝每个携带图像的一次性 prompt,直到各自能跨其进程边界传送图像字节;Claude Code 和 Codex 拒绝是因为它们各自将任务映射为仅文本的 CLI prompt。一条在投递时被其 teammate 目标的 route 拒绝的已入队图像——手工追加的 `team/message/queued` 记录,或在该 route 的目录条目改变之前入队的记录——仍可能阻塞发往该 teammate 的队首投递。

每个 Team 闸门都在其持久追加之前检查 route,Team 事务不会重复该检查,而该检查需要 await 一次模型信息读取。Lead 的 route 有两个使用方,二者都只在 await 的追加之后才读取它:通过 `root.steer()` 向 Lead 目标的投递不再施加任何检查,而 spawn 的 `startContinuable` 创建检查会在 `provisioning` 记录之后再次读取并检查它。Lead 以不同模型记录一次请求时,其 route 就会改变。在 Team 检查与使用方读取之间改为纯文本模型是更糟的失败方向,因为它是一次错误放行:mailbox 仍会将图像入队,Lead 的 steer 不施加任何投递时闸门,图像会在 Lead 的模型视图中悄悄退化为占位文本。继承 route 同样改变的 spawn 会通过 Team preflight,被该创建检查拒绝,并落定一个持久的 `failed` 成员,用掉 preflight 拒绝时本会保留的名字和一个 member slot。在事务内同步比较 Lead 的 route 只能缩小检查到追加的区间,因为两个使用方都在 await 的追加之后才读取 route,所以它不会改变任何一个失败方向。改为支持图像的模型只会产生调用方可以重试的拒绝。`agent-team` README 在 Known Limitations 中记录了这段窗口。

mailbox 的 Lead 作为目标闸门和 `SubagentContinuationManager.sendToParent` 都从 `parentAgentOptionsForDelegation`——即 Lead(或父级)最后一条*已记录*的请求 route——解析 route,而不是从闸门运行时仍待处理的模型切换解析。待处理地切换到支持图像的模型,仍可能拒绝 teammate 发往 Lead 的图像,直到 Lead 的下一次请求记录新 route;待处理地切换到纯文本模型会放行图像,随后 runtime 在 Lead 的下一轮将其投影为占位文本。`agent-team` README 在 Known Limitations 中记录了这一点;要消除它,需要在 Lead 自己的请求之前读取其进行中的 route 选择。

## 测试

单元测试覆盖共享闸门(`packages/subagent/subagent/tests/image-capability.spec.ts`)、continuable 创建与父方向闸门以及 child-route 探针的 live/cold/fallback 来源(`packages/subagent/subagent/tests/continuation.spec.ts`)、一次性 `start()` 传输检查(`packages/subagent/subagent/tests/service.spec.ts`)、共享进程内 driver 的 route 检查及其与同步委派策略捕获的顺序关系(`packages/subagent/subagent-in-process-driver/tests/inheritance.spec.ts`)、Team mailbox 与 spawn 闸门以及 mailbox 投递和 spawn prompt 两者的 `offloaded` 剥离(`packages/experimental/agent-team/tests/team.spec.ts`)、放宽的投影 schema(`packages/experimental/agent-team/tests/projection-events.spec.ts`),以及独立测试的准入/route 辅助函数(`packages/experimental/agent-team/tests/image-content.spec.ts`)。`startContinuable` 的创建闸门、child-route 探针和 `sendToParent` 各自有一个 spec,为 child(或对 Lead 目标和 `sendToParent` 而言,通过被监视的 `requestHeader()` 的活跃父级)赋予一个与父级创建选项不同的显式 route,因此读取了错误 Agent 选项的闸门或探针会使断言失败,而不是碰巧匹配;Team spawn preflight 有相同的被监视 `requestHeader()` 覆盖。专门的 spec 固定了:`startContinuable` 中先于待处理图像能力读取的所有权持有;continuable fork child 的种子在该读取之前捕获(读取待处理期间父级完成的轮次不会进入 child);在 `sendToParent` 的该读取、mailbox 的目标 route 读取以及 spawn 的继承 route 读取待处理期间到达的调用方 signal abort;自我消息检查和名称/member 上限快照检查各自在 mailbox 和 spawn preflight 中先于其图像检查;`resolveChildRoute` 对只命名了 provider 的冷描述符与活跃 Activation 各自按来源回退;以及它对 `observeSession` 失败的 `NOT_RESUMABLE` 包装。在 `subagent-in-process-driver` 中,一个 spec 在切换父级 sandbox 模式的同时保持 route 检查的 `resolveModelInfo` promise 未解析,然后确认发布的 child 仍携带该 await 之前捕获的 sandbox 值,而不是之后的值;第二个 spec 确认 route 拒绝不会在 `ctx.agents.list()` 中留下条目。仓库中每个 `SubagentProvider` 实现和 stub 都在 `inheritsParentContext` 旁固定了 `imageInput`。
