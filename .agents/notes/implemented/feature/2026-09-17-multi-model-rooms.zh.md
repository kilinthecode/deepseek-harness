# Agent Note：建立在 Agent Teams roster 之上的 quorum 授权 room

Status: implemented

[English](2026-09-17-multi-model-rooms.md) | 中文

## 问题

Agent Teams 协调的是工作：Lead 把任务委派给具名 teammate，持久 mailbox 传递 peer 消息，共享任务板跟踪归属。它没有共享对话的概念，也不集体结清任何事情。每个持久结果都是单个成员的决定：任务 owner 完成自己的任务，而分配、重新分配与中断只有 Lead 能做。

希望多个模型共同推理同一个问题的部署，需求恰好相反。参与者必须读到其他人说了什么，而且任何参与者都不能独自承载结论。运行时的两个事实决定了答案。一个 Session log 只有一份派生消息历史，而 agent loop 要求每个请求的 messages 等于该历史，因此多个模型无法写入同一段对话。continuable child 的 Agent 只在运行期间存活，因此 peer 无法通过寻址一个在线 Agent 来接收上下文。

## 决定

`TeamRoom` 在 Agent Teams 服务之上扩展出带署名的 transcript 与集体决策，复用它本来就已经拥有的那一个 Lead Session log。room 行为通过 `roomEnabled` 选择加入，默认 `false`；关闭时服务不记录任何 room event，所有 room 操作都以 `TEAM_ROOM_DISABLED` 拒绝，因此没有要求 room 的组合保持今天的行为与日志。

transcript 是一种派生，而不是第二个存储。`TeamRoom` 的 observer 读取每个参与者已提交的 `assistant/message`，并追加一条 `room/message`，只携带作者身份与该 assistant 消息的 text block。名字留在 roster 中，署名因此只有一个归属。`room/message`、`room/proposal` 与 `room/review` 都是 log-only event：它们绝不进入派生的模型历史，从而在不让 surface 变宽的前提下保持 loop 的「模型可见即已记录」不变式。

参与者就是 roster 本身。成员从 provisioning 记录它的那一刻起就是参与者，直到它失败为止；这与 `TeamRoster.tryMembership` 解析在线成员 Team 身份所用的规则一致，因此由同一条规则决定谁可以行动、谁计入 quorum。

发言不会唤醒 peer。`roomPrompt` 通过发送目标自己上次发言之后记录的 transcript 条目把发言权交给某个参与者，条目数量受 `roomTranscriptWindow` 限制，随后接上调用方的 instruction。由于参与者自己的上次发言总是排在它被展示过的一切之后，这个边界不需要额外记账，而未激活的参与者也不需要在线 Agent：持久 mailbox 会冷启动它。因此 room 只在人类或某个参与者交出发言权时推进，成本由结构而非提示词纪律来约束。

工作由同行验证，而不是由作者自己结清。任务 owner 用 `submit` 交出当前 revision，视图从「已提交但无裁决」派生出 `verifying`，只有另一位成员的 `verify` 裁决才会把工作推进到 `completed`，或连同反对意见退回。因此持久 task union 保留其既有变体，等待状态也不需要存储新的迁移。

决策只由 quorum 结清。`room-quorum.ts` 仅根据记录在案的 review 计算结果：每个有资格的 reviewer 都是 proposer 之外的参与者，接受要求全部 reviewer 都已投票、其中至少 `roomApprovalRatio` 比例批准，且没有任何反对成立。反对一旦达到同一阈值，决策立即结清。服务不暴露任何可以强行给出结论的操作，proposer 不能 review 自己的决策，已结清的决策是最终的，而 `roomEscalate` 会把未决决策交给人类。`roomMaxProposalRevisions` 限制 proposer 可以把修订后的 statement 重新提交多少次，超过后必须升级。chair 随 transcript 长度轮转，不授予任何权力：它的存在只是为了让部署知道下一个该叫谁，而每个参与者都在同一规则下投票。人类能做与参与者相同的三件事：`roomPrompt`、`roomPropose` 与 `roomEscalate` 让浏览器面板可以交出发言权、把 statement 提交给 room，并把未决决策交给人类，各自委派给 model-facing 工具所调用的同一个服务操作。面板不记录任何立场：review 属于拥有该裁决的参与者；每条已记录的立场都携带 reviewer 给出的理由并对所有参与者可见，因为问责需要的是反对意见本身，而不只是反对的票数。每次提交都会触发一个进程内的 `room/updated` 通知，而一条 Remote stream 会在每次提交后重发完整 view，并转发每个实时 text chunk，因此读取方能在审议进行时展示它，同时持久日志仍是唯一事实来源。

沉默是对每个 reviewer 的观察，而不是一个统一的墙钟期限。开启一个 revision 会向每个有资格的 reviewer 请求 standing，并启动该 reviewer 的 `roomReviewGraceMs` 窗口；维持窗口的是该 reviewer 自身的工作 —— 它自己 turn 的持久 event（包括在 room 已经开始等待之后才提交的那次），或实时的 `agent/assistant-stream` 帧 —— 而绝不是 room 自己的记录：Lead Session 保存着每个角色的记录，若把它们计入，就会把 peer 的工作算到 Lead 头上。窗口耗尽的 reviewer 会被记入持久的 `room/review-timeout` 记录，并至多被提醒 `roomReviewReminders` 次；每次提醒都会重启被提醒者的窗口，且绝不打扰 Lead —— Lead 自身的沉默要由人类来解决。只有当所有仍欠 standing 的 reviewer 都用尽窗口后决策才升级，升级记录会点名它们，因此慢模型的决策会交到人类手里，而不是由 room 编造一个 standing。

## 考虑过的替代方案

**把 `Agent.steer` 扩展成广播。** 否决，因为每次发言都唤醒所有 peer 会产生一个成本无法用任何配置约束的无界自主循环，而且接收方的 Agent 可能不在线。让每个请求收到它尚未见过的 transcript，使接收方自己的历史成为边界。

**随着输出到达就通过持久 mailbox 转发 peer 输出。** 作为主要机制否决：每条发言都会按目标数量在 Lead log 中重复一次，顺序会遵循 mailbox 队列顺序而非对话顺序，而 proposer 自己已提交的 turn —— 它不是一次 mailbox 发送 —— 会从 transcript 中缺失。

**按固定的墙钟期限升级。** 否决，因为流逝的时间无法区分正在思考的模型与卡住的模型：一次缓慢的 provider 响应就会丢掉一个仍在工作的参与者，从而决定结果。按 reviewer 观察其自身活动，可以让正在流式输出或刚刚提交 turn 的参与者留在窗口内；有界的提醒则让沉默的 reviewer 在惊动人类之前还有机会作答。

**由 Lead 或 moderator 结清决策。** 否决，因为这会重现 room 本要解决的单点权威问题。chair 轮转且不携带投票权重，无法达成 quorum 时会升级而不是自行结清。

**把参与者与角色存成独立的持久记录。** 否决，因为 roster 已经拥有成员身份、provisioning 与恢复。第二条记录必须与第一条对账，而 room 并未增加 roster 尚不具备的任何属性。

**用显式覆盖强行给出结论。** 否决：覆盖会让每一项接受声明都无法验证。受阻的决策通过 `roomEscalate` 到达人类，持久记录保持分歧可见。

**在默认组合中启用 room。** 否决，因为默认开启的 transcript 会给每个 Agent Teams session 增加持久记录，并改变从未想要 room 的部署的日志与快照预期。

## 测试

`room-quorum.spec.ts` 覆盖 quorum 算术：不同 reviewer 数量下的批准阈值、按 reviewer 与 revision 选取最新立场、仍有 reviewer 未投票时的 open 状态、接受、达到 quorum 的拒绝、全部投票后的拒绝，以及被单个反对击败的一致 quorum。

`room.spec.ts` 通过两个模型路由的真实 Loader 组合覆盖引擎：带署名的 transcript 条目、投递 prompt 中「未见过的 transcript」边界、自我 prompt 拒绝、room 关闭时的拒绝、`room/stream` 署名、不产生文本的 turn、不属于参与者的 provider-owned subagent、无人发言前的 prompt、未知目标、部署限制校验，以及完整决策路径 —— quorum 接受、quorum 拒绝、自我 review、过期 revision、未知决策、revision 重开、revision 上限、升级、结论通知与 chair 轮转。

`room-projection.spec.ts` 覆盖 fold：重复 transcript 身份、外来 room 身份、首 revision 规则、原地结清、拒绝改动最终决策、proposer 与 statement 不可变、只能通过下一个 revision 重开、review 放置，以及包含饱和 id 的身份分配。

产出 Desktop `.app` 需要 release 凭据：macOS 的每一条打包路径都会校验 notary 环境，而 `DSH_ADHOC_SIGN=1` 会选择 adhoc 签名身份，但不会豁免 notarization，因此随产品发布的流水线无法产出未签名的本地构建。room 是通过 `apps/cli` 的依赖闭包而非任何打包专属步骤加入其中的，也没有任何本地打包运行验证过它。

随产品发布的 CLI 也经过了端到端验证：用 `dsh plugin add` 把 `agent-room-profile` 安装进一个 profile，然后让一个任务要求 Lead 把两位 teammate 安排在 不同模型上并向它们提交一个决策。二进制组合出了 room，模型调用了 room 工具，决策以两条独立写下的拒绝结清。在并非所有 reviewer 都投票之前就结清的决策不会报告任何 `awaiting` 名称，因为从未投票的 reviewer 无法改变 quorum 已经达成的结论。

`room.e2e.ts` 针对随产品发布的 DeepSeek route 认证在线路径。它把一位参与者安排在 `deepseek-v4-flash`、另一位安排在 `deepseek-v4-pro`，断言两者都以各自的 route 流式进入 room，向它们提交一个有争议的 statement，并等待 peer 模型用自己的 turn 结清该决策。随后它重新读取持久日志，要求存在带非空 reason 的记录在案的 verdict。若环境或 harness home 存储中没有凭据，它会自行跳过。

`room-vendors.spec.ts` 在没有凭据的情况下把一个 room 铺设在三种 vendor 适配器上：原生 DeepSeek 适配器使用 chat-completions、一条 pi-ai 的 `anthropic-messages` 路由，以及一条 pi-ai 的 `openai-completions` 路由，各自背后是本地的替身端点。它要求共享 transcript 中每个 peer 的发言就是它自己 vendor 返回的文本、每个 peer 的立场都经由 `room_review` 抵达其自身路由、两条理由都保留到 decision view 中，并要求结清通知在第三条路由上唤醒 DeepSeek Lead。真实 vendor 端点在凭据具备前仍未验证；room 的路由、署名与 quorum 已在没有它们的情况下跨适配器得到证明。

`agent-room-panel.e2e.ts` 在组装后的浏览器中认证该面板：它在同时携带 Team 浏览器 UI 的 room profile 层之上启动 Host 与 Web 应用，在 Session 中记录一个决策与一条同伴发言，断言渲染出的 transcript、决策 phase、具名反对，以及不存在等待中的 reviewer，然后比对稳定的 ARIA 快照。该次运行是面板确实经由真实 Remote 流程渲染、而非只针对 stub 渲染的唯一证据。

`team-action.client.spec.tsx` 与 `browser-plugin.client.spec.ts` 覆盖该面板：渲染 transcript 与决策、每个决策 phase 标签、空 room、与健康 roster 并列报告的 room 加载失败，以及 mount 生命周期发起的 `agentTeams/room` 调用。

`tool-room.spec.ts` 在真实 Loader 组合上覆盖 model-facing 界面：scoped 安装及其在插件 HMR 下的移除、同作用域冲突后的回滚、direct-apply 默认值、由 proposer 自身模型 turn 发起的工具调用所结清的决策、自我 review／过期 revision／未知决策／自我 prompt／provider-owned subagent 的拒绝结果、只携带目标尚未见过的 transcript 的发言权交接、transcript 窗口收敛、两位参与者并发流式输出，以及从持久日志回放的 transcript 与决策。

## 后果

Lead Session 会随完整 transcript 条目增长。text block 是被复制而非引用，因此一场很长的 room 会带来与参与者发言量成正比的持久字节开销；而模型只在获得发言权时为未见过的窗口付费。

room 复用 Team roster，因此继承其约束：单进程、共享 checkout、扁平且不可变的 roster，以及没有跨进程 exactly-once 投递。成员不可能只属于 room 而不属于 roster；失败的成员不再计入 quorum，这可能让原本无法达成的 quorum 变得可达。

只有参与者确实彼此不同时，room 才有意思，因此 `SpawnTeammateRequest` 接受 subagent seam 的 `agentOptions`，而 `spawn_teammate` 暴露 `provider`、`model` 与 `reasoning_effort`。teammate 由此得到的 route 仍持久保存在它自己的 Session header 中，也就是 route 来源本来就所在的位置；roster 的 `model` 列在参与者在线时报告它。若某条 route 未声明所请求的 reasoning effort，会在任何 child 存在之前就被拒绝，并且针对的是 teammate 的生效 route，而不只是显式指定的那条。较晚的校验反而会让 child 的首次请求失败：那表现为耐久性失败、指认了错误的原因，并永久占用该 teammate 的名字。

room 随安装提供，而不只是存在于仓库中：`agent-room-profile` 被列入启动器的 `OPTIONAL_BUNDLES`，并且是 `apps/cli` 的 runtime dependency，因此 Plugins 页面会提供它，Desktop 的 production closure 也包含它。没有随产品发布的 profile 会启用它，因为 room 会改变其参与者 turn 的含义；而把实验性包挡在默认产品之外的检查，正由这一对声明保持满足。

读取 room 是全函数，而写入 room 受保护。没有 room 的组合会让 `roomView` 回答 `enabled: false` 与空集合，而不是拒绝，因为不支持的界面是面板要渲染的状态，而不是它要报告的错误。这一区分必须显式化：否则在普通 Team 组合旁挂载 room 读取器时，会显示一个 room 错误，随后又显示一个空 room 区块，而该部署根本没有 room。每个会写入的操作仍然以 `TEAM_ROOM_DISABLED` 拒绝，因此无法把任何东西记录进未挂载的 room。

room 通过既有的 Agent Teams 面板而非新的界面到达人类：`@deepseek-ai/dsh-experimental-client-ui-agent-team` 经由生成的 Remote API 读取 `RoomRemoteView`，并在 roster 旁渲染 transcript 与决策板。一个面板已经拥有 Team 状态，第二个面板会把同一个 room 的 roster 与决策割裂开。

只有当参与者能够对其采取行动时，room 才真正有用，因此 model-facing 界面作为独立包发布，而不是塞进 `agent-team`。`@deepseek-ai/dsh-experimental-tool-agent-room` 安装五个 scoped 工具 —— view、prompt、propose、review、escalate —— 以及共同问责策略，沿用 `@deepseek-ai/dsh-experimental-tool-agent-team` 已经建立的 scoped 安装生命周期。每个工具都委托给服务，因此工具界面不会带来这些操作本身不具备的任何权威。

scoped 安装有一个值得说明的后果：安装依据 Agent 创建时的成员身份，而它早于 provider-owned child 的 descriptor，因此这样的 child 可能在 roster 不再承认它之前就收到工具。真正拒绝它的是每个操作内部的授权检查，那才是执行点；安装不是。
