---
description: "Portal fork 的品牌占用组件，用于侧边栏与对话 hero，仅在 portal 构建中生效；面向把产品身份保留在上游文件之外的 fork 维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-portal-brand

[English](README.md) | 中文

## 概述

该包让 `portal` 构建在侧边栏显示 Portal 方形结标记、Portal 字标与 HARNESS 铭牌，并在空白会话 hero 中显示 Portal 标记。它由 fork 自有：其存在是为了让 fork 的产品身份留在上游品牌包之外，而上游仍会持续改动那些包。上游的占用组件位于 [`dsh-client-ui-brand-official`](../ui-brand-official/README.zh.md)，仅在 `official` 构建 profile 下注册，因此两者永远不会争用同一个 slot。它不保存运行时状态，也不影响模型请求。

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

把该插件挂载到身份为 Portal 的部署的浏览器插件清单中，然后用 `portal` profile 构建客户端，使占用组件注册。

### 选择 profile

`DSH_CLIENT_BUILD_PROFILE` 决定渲染哪套品牌。`portal` 构建在侧边栏显示 Portal 标记与名称，并在 hero 中显示 Portal 标记；`official` 构建在这些位置显示上游的 DeepSeek Harness 品牌。其他取值则保留外壳兜底 —— fish 标记与本地构建标签。任何情况下插件都会加载并通过校验，只有注册受 profile 门控。启动页不是 slot：`dsh-client-web` 在所有构建 profile 下都在启动页上绘制 Portal 标记与名称，因此 `official` 或本地构建会先显示 Portal 启动品牌，再显示各自的应用内品牌。

### 更换品牌

修改 [`src/client/`](src/client) 中的图形，以及 [`src/client/locales.ts`](src/client/locales.ts) 中的字标文案。字标由调用方传入，因此本包拥有唯一副本，任何 primitive 都不携带兜底字符串。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

侧边栏的两个占用组件作为一组声明感知的注册集合安装：嵌套的 `ctx.slots.inject()` 会等待侧边栏声明，因此无论本行是在声明方之前还是之后激活都成立，声明塌缩时同时撤回两个占用组件，并且 HMR 期间不会出现品牌混用。浏览器半边是 [`src/client/index.ts`](src/client/index.ts)；node 半边是空的 Loader 席位。浏览器标题属于构建环境事务（`DSH_CLIENT_TITLE`，由 `portal` profile 提供），不在 slot 体系内。

标记、字标与铭牌图形放在这里而不是 `dsh-client-ui-primitives`，是为了让上游的 primitive barrel 保持上游所有。字标文本通过本包自己的 `portal-brand` locale 命名空间传入。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当品牌表层不够用时，请阅读下列页面。它们从本包占用的 slot 走向渲染这些 slot 的外壳。

- [ui-sidebar](../ui-sidebar/README.zh.md) —— 声明 `sidebar.brand.mark` 与 `sidebar.brand.name` 并渲染其兜底内容。
- [ui-conversation](../ui-conversation/README.zh.md) —— 在 hero 中声明 `conversation.hero.brand.mark`。
- [ui-brand-official](../ui-brand-official/README.zh.md) —— 在 fork 的 profile 下被本包取代的上游占用组件。
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md) —— 浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

无：本包只贡献浏览器呈现，此处没有任何内容会到达模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定 fork 品牌呈现的供给方式。它们是当前的包约束，不是品牌设计对比，也不是任务清单。

- **只有一套占用组件** —— 其他呈现方式应放在另一个占用相同 slot 的 Cordis 包中。
- **浏览器标题是独立的** —— `DSH_CLIENT_TITLE` 在构建期选择标题文本，而不是通过 UI slot；它由 `portal` 构建 profile 提供。
- **桌面壳文案未被覆盖** —— Electron 的关于面板、菜单与对话框读取各自的字典，重命名必须另行更新。
- **上游必须继续拥有 `official`** —— 若某次同步覆盖了 `scripts/client-build-environment.ts` 中的 Portal profile 区块，fork 会静默回到上游标题；届时 `scripts/client-build-environment.portal.spec.ts` 会显式失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本包是 fork 的品牌接缝。请把 fork 的所有品牌改动保留在包内：改 `dsh-client-ui-brand-official` 或 `dsh-client-ui-primitives` 只会重新引入与上游的长期合并冲突，毫无收益。fork 有意偏离上游的文件完整清单见 `FORK.md`。

</details>

**Runtime invariant:** 未发布配套组件。本包不保留可变状态；其三个 slot 占用组件通过两组 declaration-aware 注册安装与退出，词典则通过一个 effect 安装与退出。
