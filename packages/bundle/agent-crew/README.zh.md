---
description: "从插件管理页把 subagent 工具切换为工作树隔离，并加入其 accept/discard/list 工具与 agent-crew skill 的可选 Bundle。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-agent-crew

[English](README.md) | 中文

## 概述

此可选 Bundle 打开 `tool-subagent` 的 `worktreeIsolation`，并插入随发行版交付的组合所不含的 `tool-subagent-worktree` 与 `skill-agent-crew` 两个条目。随包配置默认禁用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

打开 Web 侧栏（或 CLI profile）的插件管理页并启用 Agent Crew。启用后，`subagent` 工具获得 `isolation: "worktree"` 选项：设置它的调用方会得到一个在自己 git 工作树中工作的子级，与调用方的检出以及其他子级相互隔离。此外会话还会获得 `accept_worktree`、`discard_worktree` 与 `list_worktrees`，用于落地、丢弃和列出这些工作树；`agent-crew` skill 也会出现在会话 skill 目录中，让模型拥有一套命名的、经过打磨的工作流，用于把一个目标拆分给多个工作树隔离的工作者。禁用此 Bundle 会恢复随包交付的 `tool-subagent` 配置（不含 `worktreeIsolation`），并移除这两个插入的条目；已经创建的工作树会继续存在，直到 operator 用 `dsh agents accept`/`discard` 接受或丢弃它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`cordis.patch.yml` 替换 `tool-subagent` 条目的整个 config——重新声明来自 `dsh-base` 的 `provider`、`toolName` 与 `backgroundMode`，并加上新的 `worktreeIsolation: true`，因为按 id 定位的补丁会替换整个 config 而不是与之合并——并插入 `tool-subagent-worktree` 与 `skill-agent-crew` 两个条目。`package.json` 依赖这两个插入条目的包，使它们都从此 Bundle 解析；`subagent-worktree` 服务条目本身位于共享的 `dsh-base` 组合中（以惰性方式挂载，直到本 Bundle 这样的消费者将其启用），因此它不是此 Bundle 的依赖。`packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES` 列出此包，`apps/cli` 依赖它，因此每次安装都随包携带且默认禁用，插件管理页在“官方”分组中提供它。此纯配置包不拥有可变的运行时状态，因此不发布不变量伴随模块。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 用 `worktreeIsolation: true` 重新声明 `tool-subagent` 的 config；插入 `tool-subagent-worktree` 与 `skill-agent-crew` |
| [`package.json`](package.json) | 以依赖声明这两个插入条目的包 |
| [`locale/en.json`](locale/en.json)、[`locale/zh.json`](locale/zh.json) | 插件管理页的标题与描述 |
| [`icon.svg`](icon.svg) | 插件管理页图标 |
| [`src/index.ts`](src/index.ts) | 空的模块入口；补丁即运行时内容 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@deepseek-ai/dsh-tool-subagent-worktree`](../../subagent/tool-subagent-worktree/README.zh.md) —— 此 Bundle 加入的 `accept_worktree`、`discard_worktree` 与 `list_worktrees` 工具。
- [`@deepseek-ai/dsh-skill-agent-crew`](../../skill/skill-agent-crew/README.zh.md) —— 此 Bundle 加入的 skill。
- `@deepseek-ai/dsh-subagent-worktree`（`packages/subagent/subagent-worktree/`）—— 这些工具所公开工作树生命周期背后的服务。
- [`@deepseek-ai/dsh-tool-subagent`](../../subagent/tool-subagent/README.zh.md) —— 此 Bundle 为其切换 `worktreeIsolation` 的委派工具。

-----

<a id="model-experience"></a>
## 模型体验

### subagent 隔离选项与工作树工具

#### 模型看到的内容

`subagent` 工具的 schema 获得一个 `isolation` 参数（枚举 `["worktree"]`）；会话获得 `accept_worktree`、`discard_worktree` 与 `list_worktrees`。启用后，`agent-crew` 也会出现在会话 skill 目录中。

#### Token 影响

启用该 bundle 会给 `subagent` 的 schema 增加 `isolation` 参数，并给每个请求增加三个新工具 schema 与一条 skill 目录条目；即使对话从不以 `isolation: "worktree"` 委派，也要承担这项固定的 schema 开销。

#### KV 缓存影响

这些 schema 与目录的变化只在 bundle 挂载时于请求前缀处发生一次；此后只要 bundle 保持启用，就不会再变化。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **这三个条目并非各自独立可用**——如果关掉 `tool-subagent-worktree`，同时又让 `subagent` 上的 `isolation: "worktree"` 保持启用，调用方就能创建工作树，却无法通过任何模型可见工具落地或丢弃它（只能通过 `dsh agents accept`/`discard`）。
- **禁用此 Bundle 不会影响已有的工作树**——在此 Bundle 启用期间创建的工作树，会连同其分支一起保留在磁盘上，直到 operator 运行 `dsh agents accept` 或 `discard`。
- 未选中此 Bundle 时，按 id 定位 `tool-subagent-worktree` 或 `skill-agent-crew` 的 profile 补丁或 `--patch` overlay 匹配不到任何条目：加载器为每条这样的补丁报告一条 `patch: entry <id> not found` 警告。请选中此 Bundle，而不是按 id 打开这些条目。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
