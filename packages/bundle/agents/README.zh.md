---
description: "dsh agents 组合包：一个在 worker agent（智能体）专属的 git worktree 中运行任务的 CLI（命令行界面），由独立 reviewer 在变更 merge 前检查，面向用户与脚本化调用 dsh 的外部 agent。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-agents

[English](README.md) | 中文

## 概述

`dsh-agents` 从命令行运行 `dsh agents run "<task>"`：它在自己的 git worktree 中创建 worker agent，让独立 reviewer 检查确切的 commit，并且只把通过的变更 merge 进你的 checkout。`dsh agents list`、`accept` 与 `discard` 管理由此产生的 worktree。它作为 `agents` profile 模板随发行版交付，因此 `dsh agents ...` 无需安装步骤即可使用。边界：该进程每次 `run` 驱动一个 worktree 生命周期，然后退出。

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

### 在 worker 的 worktree 中运行任务

```sh
dsh agents run "add the parser and its tests"
```

这会从你 checkout 的 `HEAD` 拉出一个全新的 git worktree，在其中带着该任务启动 worker agent，提交 worker 的变更，让独立 reviewer 针对任务检查确切的 commit，并在通过后把变更 merge 进你的 checkout。一次 merge 结果会报告 worktree 及其分支是否被删除——删除通常伴随 merge 发生，但它是可能独立失败的单独步骤，因此结果始终如实说明发生了哪一种，而不是假定两者都发生了。未 merge 的运行会让 worktree 保持 `open`，并打印 reviewer 的发现、失败的检查输出或 merge 冲突，以便你重试。

| Flag | 含义 |
|---|---|
| `--name <label>` | worktree 的简短显示标签；默认为任务的第一行 |
| `--model <provider>/<model>` | worker 运行所用的路由；默认为当前的默认模型选择 |
| `--effort <e>` | 推理（reasoning）强度；给出 `--model` 时应用于它，否则应用于默认模型选择 |
| `--reviewer <provider>/<model>` | reviewer 运行所用的路由；默认为已配置的 reviewer 或你自己的路由 |
| `--reviewer-effort <e>` | `--reviewer` 的推理强度；缺少 `--reviewer` 时会在解析阶段被拒绝 |
| `--test "<cmd>"` | 在 reviewer 之前于审查 checkout 中运行的检查命令，按空白字符拆分 |
| `--worktree <id>` | 复用已有的 `open` worktree，而不是新建一个 |
| `--fix-rounds <n>` | 评审被拒绝或检查失败后的自动修复尝试次数；默认为 `0` |
| `--json` | 向 stdout 写出按行分隔的运行事件，而不是人类可读文本 |

`--test` 的命令按连续空白字符拆分，而不是像 shell 那样做词法分析：它从不识别引号、通配符、管道、重定向或环境变量展开，不含这些字符的值之所以能按预期工作纯属巧合。需要这些特性的检查应放进包装脚本，以纯粹的 `--test ./check.sh` 形式调用。

任务即位置参数；单独的 `-` 则从 stdin 读取它。退出码 `0` 表示变更已 merge；`2` 表示运行在未 merge 的情况下结算（被拒绝、检查失败、冲突、阻塞或没有变更）；`1` 表示运行本身失败（例如无法审查的路由配对，或 worktree 缺失）。在评审被拒绝或检查失败且仍有 fix 轮次时，全新的 worker 会在同一 worktree 中带着发现与原任务启动，随后循环再次 accept。

### 管理 worktree

```sh
dsh agents list [--all]
dsh agents accept <id> [--reviewer <provider>/<model>] [--reviewer-effort <e>] [--test "<cmd>"]
dsh agents discard <id>
```

`list` 显示当前仓库中的每个 worktree，默认显示 open 的，加 `--all` 则显示全部状态；`accept` 对已有 worktree 重复 commit/check/review/merge 循环，例如在你自行修好被拒绝 worker 的变更之后；`discard` 在不 merge 的情况下删除 worktree 及其分支，在已 attach 的 worker 仍在运行时拒绝执行。这三者都以 operator 身份行事：它们触及调用方所在仓库的每一个 worktree，而不仅仅是某次 `run` 自己创建的那些。

`list --json` 为每个 worktree 写出一行 `worktree` 类型的记录：`id`、`path`、`branch`、`baseCommit`、`state`（`open`/`reviewing`/`merged`/`discarded`）、`label`，以及 `verdict`（`"pass"` 或 `"fail"`，仅在已针对它运行过评审后才出现）。这与下文 `run --json` 为刚创建或复用的 worktree 发出的 `worktree` 记录形状更窄、也不相同。

### 机器可读输出

`--json` 用每行一个 JSON 对象取代人类可读文本：`worktree`（已创建或已复用，含其 id、路径、分支与基础 commit）、`worker`（已结算的 worker 或 fixer 子级的会话 id、路由、停止原因，以及在以错误停止时的诊断信息）、`review`（reviewer 的裁决、commit、路由、摘要与发现）、`outcome`（已结算的 accept 结果）与 `error`（运行级失败）。事件字段携带完整的 40 字符 commit id；只有人类可读文本会把 commit 缩写为 7 个字符。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 运行流程

`run` 解析 worker 路由（`--model`/`--effort`，否则为共享的 [`agentDefaultModel`](../../core/agent-default-model/README.zh.md) 选择）与 reviewer 覆盖项（`--reviewer`/`--reviewer-effort`），然后在创建任何东西之前调用 `ctx.subagentWorktrees.resolveReviewer`：独立性检查会拒绝的路由配对会在创建 worktree 或 worker 之前就失败。接着它创建一个 operator root Agent，即在调用目录中的一个 Session，其创建方式与 [`dsh-headless`](../headless/README.zh.md) 创建自己的 Agent 相同，且从不进行模型轮次；它唯一的用途是作为 worker、fixer 与 reviewer 子级的委派 `parent`，以及作为 `resolveReviewer` 回退时使用的调用方路由。它创建一个 worktree（或复用 `--worktree` 指名的那个 `open` worktree——这是 operator 对调用方所在仓库中每一个 worktree 的视角，而不仅是某次 `run` 自己创建的那些，`accept`/`discard` 具有同样的触及范围），把 worker 作为一次性前台 `spawn` 子级启动：`cwd` 指向该 worktree，任务前加上 worker brief，然后 attach 它并 accept。每一轮 fix 都会在同一 worktree 中启动全新的子级，内容为同样的 worker brief，后接本包自有的 fixer 模板——`Fix these problems in this worktree:` 加上 reviewer 的摘要与发现，或失败的检查命令及其输出，再加 `Original task:` 与原任务文本——attach 该子级并再次 accept。每个子级的运行都在 `finally` 中结算：一旦子级发布，无论其轮次如何结束，worktree 服务都会获知它；其运行始终会被 dispose；`run.result` 的拒绝（基础设施故障，而非模型层面的停止原因）会在向上传播前中止该子级自己的信号。operator Agent 本身也以同样方式被 flush 并释放——在该次调用的每个子级都结算完毕之后，无论成功路径还是任一失败路径皆如此。

### 基于 base 的 patch 内容

该 patch 叠加在 `dsh-base` 之上：它在基础 `system-prompt` 行上设置与 `dsh-headless` 相同的编码 persona 与 cwd 后缀，保留同样临时的进程级 PTC mode 开关（`DSH_TOOLS_MODE`），禁用共享的 HMR（热模块替换）行，并挂载启动提供方与 runner。启动提供方（[`src/startup.ts`](src/startup.ts)）从 `ctx.cmdlineArgs` 解析 `run`/`list`/`accept`/`discard` 四个动词，打印本应用的 `--help`（没有动词或动词未知时退出 `1`），并提供 `agentsStartup`；runner（[`src/index.ts`](src/index.ts)）在 `ctx.subagentWorktrees` 与 `ctx.subagents` 旁注入该服务，并从惰性配置中读取自己的动词与选项。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/startup.ts`](src/startup.ts) | `agents-startup` 提供方：四个动词、它们的 flag、`--help` 与 `--json` 语法错误报告 |
| [`src/index.ts`](src/index.ts) | `agents-runner` 插件：服务守卫与动词分发 |
| [`src/run.ts`](src/run.ts) | `run`：路由解析、快速失败的 `resolveReviewer` 预检、worktree 创建/复用、worker 与 fix 轮次子级，以及 accept |
| [`src/accept.ts`](src/accept.ts), [`src/accept-cycle.ts`](src/accept-cycle.ts) | `accept` 以及 `run` 的 fix 轮次循环复用的共享 accept 并报告步骤 |
| [`src/list.ts`](src/list.ts), [`src/discard.ts`](src/discard.ts) | `list` 与 `discard` |
| [`src/operator.ts`](src/operator.ts) | operator root Agent 与调用目录解析 |
| [`src/route.ts`](src/route.ts) | 路由 flag 解析、标签派生、检查命令拆分，以及复用 worktree 的目录公式 |
| [`src/render.ts`](src/render.ts), [`src/fixer.ts`](src/fixer.ts) | 人类可读文本、`--json` 事件负载与 fix 轮次提示词 |
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上的 patch |
| — | 不发布运行时不变式伴生入口；runner 的可观察约定（worktree 生命周期、按已结算结果决定的退出码）属于进程级，并由启动器 e2e 负责；它不注册任何内容，树内也不持有可审计的可变关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [组合包索引](../README.zh.md)——基于同一核心构建的表层。
- [dsh-base](../base/README.zh.md)——`dsh agents` 运行其上的共享核心。
- [dsh-headless](../headless/README.zh.md)——本组合包 patch 内容所镜像的同级一次性 runner。
- `dsh-subagent-worktree`（`packages/subagent/subagent-worktree`）——本 runner 驱动的 worktree 生命周期、审查与 merge 服务。
- [dsh-cmdline](../../boot/cmdline/README.zh.md)——启动器如何把命令行交给应用。

-----

<a id="model-experience"></a>
## 模型体验

### Fixer 提示词模板

#### 模型所见

第一个 worker 的提示词是 `dsh-subagent-worktree` 拥有的 worker brief，逐字前置于任务之前；本包在那里不贡献任何自己的文本。而一轮 fix 的子级则会收到同样的 brief，后接本包自有的固定模板：`Fix these problems in this worktree:`，然后是 reviewer 的摘要连同其发现，或是失败的检查命令及其输出，再接 `Original task:` 与原任务文本。

#### Token 影响

只有 fix 轮次才需要为该模板付出代价：其固定文案约为几十个 token，外加 reviewer 摘要、发现或检查输出所增加的部分，每个 fixer 子级各付一次。若某次 `run` 首次尝试即 merge，或者 `--fix-rounds` 保持默认值 `0`，就永远不会启动 fixer，也就不会付出这项开销。

#### KV Cache 影响

每个 fixer 子级都是全新的一次性请求；该模板在其单一轮次开始时一次性成为该子级自己提示词前缀的一部分，此后运行期间不会被修订。runner 本身不驱动任何自己的模型请求——无论 worker 还是 fixer，它启动的每个子级都在各自的组合下打开独立请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每次 `run` 一个 worktree 生命周期**——运行结算后（或 fix 轮次用尽后）进程即退出；没有交互式后续，因此重试被拒绝的运行只能是新的 `dsh agents accept` 或 `dsh agents run --worktree <id>` 调用。
- **`--json` 事件携带无上限的 reviewer 与检查文本**——`review.findings` 与 `outcome.output`/`outcome.summary` 不受本包限长；产生超大文本的 reviewer 或检查命令会产生相应巨大的事件行。
- **依赖 `ctx.subagentWorktrees` 与 `ctx.subagents`**——在没有同时挂载两者的 `dsh-base` 层的情况下组合 `agents` profile 会让 runner 永久处于 pending 状态；它永不激活，也永不退出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>