---
description: "面向使用者与维护者的 accept_worktree、discard_worktree、list_worktrees 工具说明，用于组合或调试工作树隔离式委派。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-worktree

[English](README.md) | 中文

## 概述

`dsh-tool-subagent-worktree` 提供落地、丢弃和列出 `ctx.subagentWorktrees` 所创建隔离 git 工作树的模型可见工具：`accept_worktree` 提交子级已完成的更改、运行任何已配置的检查，并让独立评审者确认那次确切的提交，然后才合并进调用方的检出；`discard_worktree` 删除一个被放弃的工作树及其分支，不进行合并；`list_worktrees` 报告调用方自己创建的、仍处于打开状态的工作树。每个工具都从发起调用的 Session 解析出其 owner，`list_worktrees` 还据此解析所属仓库，因此调用方只能看到并操作自己创建的工作树。这些工具只是薄的适配层：生命周期权限、git 操作与评审都属于 `ctx.subagentWorktrees`。

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

在任何提供 `isolation: "worktree"` 的 `subagent` 委派工具所在的组合中挂载本包（参见 `@deepseek-ai/dsh-tool-subagent` 的 `worktreeIsolation` 配置，以及 `@deepseek-ai/dsh-agent-crew` bundle）。它需要 `ctx.subagentWorktrees`（`@deepseek-ai/dsh-subagent-worktree`），该服务已经以惰性方式挂载在共享的 `dsh-base` 组合中。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-subagent-worktree'
- name: '@deepseek-ai/dsh-tool-subagent-worktree'
```

本包不需要任何配置：只要 `ctx.subagentWorktrees` 可用，三个工具就会无条件注册。

### accept_worktree

提交指定工作树的更改、运行任何已配置的检查命令，并让独立评审者检查那次确切生成的提交；评审通过后才会合并进调用方的检出。渲染文本会精确说明结果：merged（附合并提交与评审路由）、rejected（附每一条问题）、checks-failed（附检查命令及其输出）、conflict（附冲突路径）、blocked（附 git 拒绝原因），或 empty（没有可接受的更改）。只有 merged 结果才会改变调用方的检出。被拒绝的结果会说明如何修复并重新提交：后台子级通过 `send_message` 接收这些问题，待其结束后调用方再次 accept；前台子级无法接收消息，因此调用方需丢弃该工作树，并带着任务与这些问题启动一个新的后台 worker。

### discard_worktree

删除指定的工作树及其分支，不进行合并；通过本工具丢弃的更改无法恢复。

### list_worktrees

列出调用方自己仍处于打开状态的工作树（`open` 与 `reviewing` 状态），包含每一个的分支、路径、状态、最近一次 worker 的 agent id（没有记录 worker 时为 `none`）和最近一次评审结论（`pass`、`fail` 或 "not reviewed"）。worker id 就是 `send_message` 接收的 `agent_id`，因此调用方在上下文压缩（context compaction）后仍能联系拥有被拒绝工作树的 worker。范围限定为以发起调用的 Session 为 owner，且仓库取自该 Session 工作目录所在的仓库；它从不列出其他 Session 的工作树。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计概念

每个工具只是把发起调用的 Agent 转换成服务所需的请求形状，不做更多事情：owner 始终是 `{ kind: 'session', sessionId: <发起调用的 Agent id> }`，`accept_worktree` 的 parent 就是发起调用的 Agent 本身，`list_worktrees` 的 `baseDir` 则取自发起调用 Session 的 `header.cwd`。这些工具自身不持有任何状态；每一个 id、state 和 verdict 都来自 `ctx.subagentWorktrees` 的持久化记录。

### 声明的结果与渲染文本

每个工具都声明了完整的规范结果 schema——`accept_worktree` 对应一个判别联合类型，覆盖服务可能给出的每一种结果——因此 PTC 调用方能拿到结构化字段（提交 id、评审路由、问题列表、冲突路径），而不仅是文字说明。`output.render` 把同一个值转换成模型读到的确切措辞。[`src/values.ts`](src/values.ts) 同时拥有这些 schema 与逐字模板，使模板的修改与其 schema 保持在同一个文件中。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 工具注册：`accept_worktree`、`discard_worktree`、`list_worktrees` |
| [`src/values.ts`](src/values.ts) | 声明的结果 schema、服务到值的投影，以及逐字渲染模板 |
| — | 未发布运行时不变量配套包：这个模型可见适配器自身没有独立的生命周期流——工作树的状态与权限属于 `ctx.subagentWorktrees`。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当本包层面的说明不够用时，可阅读以下页面；它们从这几个工具 schema 延伸到背后的工作树服务与工作流。

- `@deepseek-ai/dsh-subagent-worktree`（`packages/subagent/subagent-worktree/`）——这些工具调用的服务：位置约定、accept 状态机与评审。
- [`@deepseek-ai/dsh-tool-subagent`](../tool-subagent/README.zh.md)——其 `isolation: "worktree"` 选项会创建这些工具所操作工作树的委派工具。
- [`agent-crew` 技能](../../skill/skill-agent-crew/README.zh.md)——将目标拆分为多个工作树隔离的工作者，并用这些工具落地每一部分的打包工作流。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-worktree)——三个工具的 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

生成的 [schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-worktree)：`accept_worktree` 与 `discard_worktree` 均接收必填的 `worktree_id`；`list_worktrees` 不接收任何参数。这三个 schema 仅在启用它们的 bundle（`@deepseek-ai/dsh-agent-crew`）被打开时才会加入 session 的工具目录；未打开该 bundle 的 session 永远看不到它们。

#### Token 影响

每次父请求固定的 schema 开销，且仅在启用该 bundle 时才会出现。

#### KV 缓存影响

前缀稳定；这些 schema 不会在运行时改变。

### accept_worktree 结果

#### 模型看到的内容

以下六个固定模板之一，由服务给出的结果决定选用哪个。当工作树在合并后被移除时，merged 结果会追加 ` The worktree was removed; start a new child for further work.`。当检查进程没有留下退出码时（例如被信号杀死），checks-failed 结果会说该命令“was stopped before it exited”而不是给出退出码，并且会给包含空白字符的 argv 元素加上引号，使该命令可以复现。确切措辞见 [`src/values.ts`](src/values.ts)。

##### 合并（merged）

```markdown
Merged worktree <id> into <repoRoot>: commit <commit> as merge <mergeCommit>. Reviewer <provider>/<model> passed it: <summary>.
```

##### 拒绝（rejected）

```markdown
Review failed for worktree <id> at commit <commit> (reviewer <provider>/<model>): <summary>
Findings:
- <finding>
If the child is a background subagent, send these findings to it with send_message, wait for it to finish, then accept again. A foreground child cannot receive messages: discard the worktree and start a new background worker with the task and these findings.
```

##### 检查失败（checks-failed）

```markdown
Checks failed for worktree <id> at commit <commit>: `<argv>` exited <code>.
<output>
```

##### 冲突（conflict）

```markdown
Worktree <id> passed review at commit <commit> but conflicts with your checkout in: <files>. Nothing was merged. Merge branch <branch> yourself and resolve the conflicts, or discard the worktree.
```

##### 被阻止（blocked）

```markdown
Worktree <id> passed review at commit <commit>, but the merge could not start: <reason>. Commit or set aside the conflicting changes in your checkout, then accept again.
```

##### 空（empty）

```markdown
Worktree <id> has no changes to accept.
```

#### Token 影响

每次调用一小段文字，其长度受检查输出以及服务本身已限定的评审摘要与问题列表所约束。

#### KV 缓存影响

仅追加；每个结果都紧跟在可复用的请求前缀之后。

### discard_worktree 结果

#### 模型看到的内容

`Discarded worktree <id> and branch <branch>.`

#### Token 影响

每次调用一行简短确认。

#### KV 缓存影响

仅追加；紧跟在可复用的请求前缀之后。

### list_worktrees 结果

#### 模型看到的内容

每个打开的工作树一行标注字段：`<id>  state=<state>  branch=<branch>  path=<path>  worker=<agent-id-或-none>  review=<verdict-或-"not reviewed">  label="<label>"`；没有打开的工作树时为 `No open worktrees.`。包含空白字符的路径会加引号。

#### Token 影响

随调用方自己打开的工作树数量线性增长；没有游标也没有上限。

#### KV 缓存影响

仅追加；紧跟在可复用的请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不支持跨 Session 评审**——`accept_worktree` 与 `discard_worktree` 只接受记录自身的 session owner，或 CLI operator；兄弟 Session 或无关 Session 无法对自己未创建的工作树采取任何操作，即便是想帮忙完成一个停滞的工作树。
- **`list_worktrees` 只报告打开状态**——它排除 `merged` 与 `discarded` 记录，调用方因此无法通过本工具审查工作树的完整历史；`ctx.subagentWorktrees.list()` 的 `includeClosed` 选项目前没有任何模型可见工具暴露它。
- **不支持部分接受**——被拒绝或检查失败的工作树必须整体修复后重新提交；没有工具可以只合并工作树更改中的一部分。
- **被拒绝的前台子级无法就地修复**——前台子级结束时即被释放，无法接收 `send_message`，因此其被拒绝的工作树需被丢弃，并由新的后台 worker 重做。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
