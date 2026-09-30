# Agent Note: Fork 的产品身份存放在 fork 自有的包中

Status: implemented

[English](2026-09-21-fork-identity-lifecycle.md) | 中文

## Problem

本仓库是一个 fork。它的产品身份 —— Portal 标记、字标与铭牌、构建标题，以及桌面壳文案 —— 最初是通过修改上游自己的品牌包实现的：占用组件改的是 `dsh-client-ui-brand-official`，图形改的是 `dsh-client-ui-primitives`，标题改的是 `OFFICIAL_CLIENT_BUILD_ENVIRONMENT` 常量。

而这些恰恰是上游持续改动的文件。在其中产生偏离，会把每一次上游同步都变成对 fork 其实并不想拥有的文件的手工合并，并且掩盖了 fork 的意图：读者无法分辨这是有意的改版，还是一次陈旧的本地修改。同样的问题适用于任何默认落在上游包里的 fork 工作，因此 fork 需要的是一条长期规则，而不是一次性的清理。

## Decision

fork 的产品身份存放在 fork 自有的文件中。上游文件只接受最小的增量式接缝，而仓库根目录的 `FORK.md` 是账本，记录 fork 有意偏离的每一个上游文件及其原因与日期。

身份由四个接缝承载：

- **品牌占用组件。** `packages/client/portal-brand` 拥有标记、字标与铭牌图形，并占用三个通用品牌 slot。它的建立方式是把图形从 `dsh-client-ui-primitives` 移出，并把两个上游品牌包恢复为上游内容。
- **构建 profile。** `scripts/client-build-environment.ts` 新增携带 `DSH_CLIENT_TITLE: 'Portal Harness'` 的 `portal` profile，同时把上游的 `official` 取值恢复为 `DeepSeek Harness`。正是 profile 门控让两套占用组件不会争用：上游的只在 `official` 下注册，fork 的只在 `portal` 下注册，因此 `single` slot 永远不会看到两个候选。
- **不变式测试。** `scripts/client-build-environment.portal.spec.ts` 断言 fork 的 profile，并断言 `official` 仍然返回上游标题；`packages/client/portal-brand/tests/` 覆盖这些占用组件。它们的存在是为了在同步破坏 fork 时显式失败 —— 而这正是 merge-forward 工作流实际会产生的故障。
- **模型可见的身份。** `packages/core/system-prompt/src/index.ts` 输出 `You are an AI agent powered by Portal Harness.`，因此模型的自我描述与界面一致。这是唯一没有接缝的身份改动：随产品发布的 base 组合正是上游快照语料重放的输入，因此该行被固定在 58 个 `*.expected.md` 文件（`snapshots/session` 下 44 个、`snapshots/sdk` 下 10 个、`snapshots/web` 下 4 个）与 8 个测试文件中，它们现在都是记入 `FORK.md` 的 fork 偏离。已录制的 fixture 不受影响，因为它们把提示词模板化为 `{{system}}`，因此无需重新录制，keyless 重放即可验证结果。

该规则可以推广：fork 的行为属于 fork 自有的包、fork 自有的 profile，或 fork 自有的组合。修改上游包是最后手段，且必须记入 `FORK.md`，而不是默认做法。

## Alternatives considered

**继续就地修改上游品牌包。** 已否决。这正是产生账本的现状，而且它让 fork 的意图不可见：下一次同步无法区分 fork 有意的改版与它本应直接接受的上游修改。

**只修补 `OFFICIAL_CLIENT_BUILD_ENVIRONMENT` 的标题。** 作为完整答案已否决。这是看起来无害的单常量改动，但它让 fork 的标题与上游的官方标题无法区分，因此上游发布可能会带上 fork 的产品名，而同步也无法判断哪个值属于谁。具名 profile 让两个事实都保持显式。

**改用 fork 自有的 profile 来组合模型身份。** 经量化后否决，因为其前提不成立。`dsh web` 本身就是随产品发布的 `web` 模板，而快照 harness 只接受随产品发布的 `headless`、`sdk`、`acp` 与 `web` profile，因此语料启动的正是 fork 所运行的同一批模板。把身份 bundle 放进这些模板，同样会改动那 58 个 expected 文件；为 fork 单独设立 `portal` 模板可以保持语料不变，却会把 fork 的日常命令从 `dsh web` 改成 `dsh --profile portal`，并要求把桌面壳也指向它。不存在任何一种组合能让 `dsh web` 报告 fork 身份、同时上游的 expected 输出保持逐字节相同，因此 fork 选择直接修改，并把成本记录下来，而不是藏在 profile 之后。

**把 npm scope 改名为 fork 自己的。** 已推迟，并非否决。所有包目前仍是 `@deepseek-ai/dsh-*`，而该前缀在约三百个清单、Cordis 解析清单、发布家族检查以及文档中都承担实际作用。它是一次需要独立影响面评估的后续工作，而不是建立接缝的一部分。

**现在就修改应用内文案。** 已推迟。欢迎通知、插件安装安全提示与 Office 预览错误仍然写 DeepSeek Harness，而 `DSH` 缩写还出现在另外四个客户端字典中。`DSH` 源自 DeepSeek Harness，无法从 Portal Harness 推导出替代缩写，因此部分重命名会让 “Portal Harness” 与 “DSH plugin ecosystem” 出现在同一段落里。

## Consequences

侧边栏与 hero 中的 fork 品牌工作无需触碰任何上游文件即可完成，因此同步时这些品牌冲突的处理方式是接受上游并保留 fork 的包。启动页不是 slot：`dsh-client-web` 在所有构建 profile 下都在启动页上绘制 Portal 品牌，`FORK.md` 将这一偏离记在 Category D 下。fork 为身份而修改的六个上游文件都是增量式的：一个 profile 区块、一条 allowlist 条目、一个路径别名、一个项目引用、一个客户端行，以及一条依赖。模型可见的身份是例外：它没有接缝，因此直接偏离 70 个上游文件；那里的冲突意味着上游改动了提示词，fork 必须先重新应用自己那一行，然后重新生成。

改动身份还会波及已经存在的会话。循环会在每一步重新投影渲染后的提示词，并在结果不同时追加一条新的 `system/message`，因此在本次改动之后被恢复的会话会在其 surface 历史中先保留旧开场白、随后带上新的开场白。于是每个活动会话的提示词前缀都会位移一次，其缓存前缀也在那一刻失效。没有任何已录制的日志被重写。

本分支上的 `pnpm run duplication` 仍然是红的 —— **六个**克隆。其中四个位于 `packages/experimental/tool-agent-room` 与 `packages/experimental/tool-agent-team` 之间，一个位于 `agent-team` 的 `RoomFollowQueue` 与 `packages/api/session-controller` 中私有的 `ControlQueue` 之间，还有一个是 `packages/client/portal-brand/src/client/HarnessNameplate.tsx` 提取的 11 行铭牌几何，与上游 `BrandWordmark` 仍以内联形式 `dsh-wordmark-badge-clip` 保留的内容相同。

最后这个克隆是接缝本身固有的，而不是疏漏。上游的 `BrandWordmark` 把全小写的 `deepseek` 字形与铭牌渲染为一个 svg，因此没有任何上游导出能单独绘制该铭牌；把它提取出来，正是 fork 得以将 Portal 字标放在 HARNESS 铭牌旁边的前提。正确的修法是向上游贡献一个改动，从 `dsh-client-ui-primitives` 导出该铭牌图形供两个使用方共用，之后 fork 即可删除自己的副本。在此之前，fork 有意承担这份重复。其余五个克隆仍需为共享的实验性工具管线选定归属，本文不对此作出决定。
