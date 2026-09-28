---
description: "随包附带的 agent-crew skill（技能），供启用、使用或排查工作树隔离式目标拆分的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-agent-crew

[English](README.md) | 中文

## 概述

agent（智能体）可以通过该内置提供方加载 `agent-crew` skill，并遵循其指令把一个目标拆分成若干可独立验证的部分，把每一部分委派给一个在自己 git 工作树中工作的工作 agent，并只落地经过独立评审者确认的部分。该提供方没有配置，按 `BUNDLED_SKILL_RANK` 注册，与 `dsh-badge`、`dsh-office` 优先级相同，因此同名的项目或用户 skill 仍会优先生效。

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

启用插件即可让 `agent-crew` skill 出现在会话 skill 目录中；随后模型可以像加载任何其他 skill 一样加载它（用户也可以直接用 `/agent-crew` 调用），并遵循其指令拆分和落地已拆分的工作。

### 何时选择

当支持独立评审的工作 agent 委派可用、并值得作为一个命名工作流公开时，选择此提供方：与 `@deepseek-ai/dsh-tool-subagent-worktree`，以及启用了 `worktreeIsolation` 的 `subagent` 工具一起使用（`@deepseek-ai/dsh-agent-crew` bundle 会把三者一并挂载）。当这些工具未挂载时请跳过——该 skill 的正文直接点名这些工具，未挂载它们时加载该 skill 会让模型拿到无法执行的指令。

### 启用插件

该插件没有配置。

```yaml
- name: '@deepseek-ai/dsh-skill-agent-crew'
```

启用后，`agent-crew` 会出现在会话目录的可用 skill 中。

### 该 skill 提供什么

- **拆分指导。** 如何把一个目标拆分成若干范围互不重叠、各自带有验收标准的部分。
- **工作简报模板。** 目标背景、精确范围、约束、验收检查，以及需要汇报的内容。
- **确切的工具调用形状。** `subagent({ description, prompt, isolation: "worktree", provider, model })`，以及用于落地、修复或丢弃每个部分的 `accept_worktree` / `discard_worktree` / `list_worktrees` / `send_message` 循环。
- **指向 `dsh agents run` 的指引**，供人类和外部 agent 从命令行执行同样的流程。

### 可观察的成功与失败

启用插件会使 `agent-crew` 出现在目录中并可凭名称加载；禁用或省略该行则它不会出现在任何目录中。由于提供方不可变，发现始终成功且恰好返回一个 skill，绝不会报告部分结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释内置提供方如何接线；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是一个不可变、同步注册的 skill 来源：它以 `agent-crew` 作为提供方名称、按内置 skill rank（600）注册一个固定候选项，把随包分发的 `assets/` 目录作为该 skill 的目录资源基底公开，并在每次加载时从随包分发的 `assets/agent-crew.md` 文件读取 skill 正文。其实现与 `skill-badge` 完全同构。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口与不可变提供方：一个候选项、资源基底、正文加载 |
| [`assets/agent-crew.md`](assets/agent-crew.md) | 随包分发的 skill 正文：何时使用、如何拆分、工作简报、如何派生工作 agent，以及如何落地每一部分 |
| — | 不发布运行时不变式伴生入口；本包只持有一个不可变的提供方注册，注册唯一性与生命周期检查由 skill 注册表负责。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时，请阅读以下页面。这些页面先介绍该提供方注册到的注册表，再说明 skill 如何到达模型，以及其工作流所调用的工具。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——该提供方实现的注册表与提供方约定。
- [skill 包](../skill/README.zh.md)——该提供方注册到的注册表，以及已加载 skill 的共享渲染。
- [tool-skill 包](../tool-skill/README.zh.md)——`agent-crew` skill 如何到达会话目录与模型。
- [`@deepseek-ai/dsh-tool-subagent-worktree`](../../subagent/tool-subagent-worktree/README.zh.md)——该 skill 工作流用来落地、丢弃和列出工作树的工具。
- [`@deepseek-ai/dsh-agent-crew`](../../bundle/agent-crew/README.zh.md)——把该 skill 与工作树隔离式委派一并挂载的可选 bundle。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-skill` 间接影响模型；该包会把该提供方的目录条目和所选 skill 的正文渲染给模型。

#### KV Cache 影响

该插件默认不在随包交付的组合中，在 `agent-crew` bundle 启用它之前不会改变任何请求。启用后，其目录条目和任何已加载正文都会在各自插入点改变提供方的 KV 前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明内置提供方不做什么。它们是当前包约束，不是任务积压。

- **固定一个 skill，无运行时自定义**——提供方恰好贡献 `agent-crew` 这一个 skill；需要其他拆分工作流的部署请自行编写 skill。
- **假定工作树工具已挂载**——正文直接点名 `subagent` 的 `isolation: "worktree"`、`accept_worktree`、`discard_worktree` 与 `list_worktrees`；未挂载这些工具时加载该 skill 会让模型拿到无法执行的指令。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
