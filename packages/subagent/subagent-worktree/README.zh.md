---
description: "为委派智能体提供隔离的 git 工作树,供用户和维护者独立于父级检出目录来置备、评审和合并单个工作者的改动。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-worktree

[English](README.md) | 中文

## 概述

`dsh-subagent-worktree` 为每个被委派的工作者提供一个关联的 git 工作树,该工作树从基础检出目录的 `HEAD` 分支而来,因此并行的工作者不会覆盖父级或彼此。工作者所做的任何改动,在调用 `accept` 之前都不会进入基础检出目录:该服务提交工作树中的改动,运行已配置的检查命令,让一个独立的评审子智能体检查这一确切提交,并只用 `--no-ff` 合并通过评审的改动。被拒绝或被阻塞的 accept 会使工作树保持 `open` 状态以便重试;`discard` 会删除被放弃的工作树而不进行合并。该服务本身不添加任何工具或提示词;消费方负责把这种隔离呈现给模型或操作者。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

加载本服务,以便某个委派消费方能够提供工作树隔离能力。单独加载它不会产生任何模型可见的效果;消费方会围绕工作者的生命周期调用它的方法。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-subagent-worktree'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `<DSH_HOME>/worktrees` | 存放工作树、记录和评审检出目录的绝对路径;若配置该值,必须是绝对路径 |
| `branchPrefix` | `dsh/worktree/` | 每个工作树分支名称的前缀 |
| `maxWorktrees` | `16` | 每个仓库允许的最大 `open` 或 `reviewing` 工作树数量 |
| `reviewerProvider` / `reviewerModel` | — | 评审者路由,需成对设置;省略时使用接受操作所属智能体自身的路由 |
| `reviewerReasoningEffort` | — | 评审者推理强度;需要同时设置 `reviewerProvider` 和 `reviewerModel` |
| `requireDistinctReviewer` | `false` | 为 `true` 时,拒绝与工作者路由相同的评审者路由(仅比较 provider 与 model,忽略推理强度) |
| `testCommand` | `[]` | 在评审检出目录中、评审者启动前运行的检查命令(argv);为空则不运行任何检查 |
| `checkTimeoutMs` | `900000` | 检查命令在被终止前允许运行的毫秒数,终止后 `accept` 报告 `checks-failed` 并附超时说明;至少 `1000` |
| `reviewDiffMaxBytes` | `49152` | 嵌入评审者提示词中的 diff 的字节上限 |
| `removeOnMerge` | `true` | 合并成功后删除工作树目录及其分支 |
| `commitAuthorName` / `commitAuthorEmail` | — | 用于 harness 提交的作者身份,需成对设置;省略时使用 git 自身已配置的身份 |

若 `reviewerProvider`/`reviewerModel` 或 `commitAuthorName`/`commitAuthorEmail` 中只设置了一半,会在加载时立即报错;若设置了 `reviewerReasoningEffort` 但未同时设置两个评审者字段,同样会立即报错。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-worktree)是每个可接受字段及其 JSDoc 的完整来源。

默认情况下,评审者运行在执行接受操作的智能体自身的路由上,因此以更便宜的路由启动的工作者会自动由接受者的路由评审。若要强制评审者使用与工作者不同的模型,请配置 `reviewerProvider`/`reviewerModel` 并设置 `requireDistinctReviewer: true`。

### 服务接口

`ctx.subagentWorktrees` 暴露六个方法,每个方法都接收单一的请求对象:

| 方法 | 效果 |
|---|---|
| `create` | 从基础检出目录的 `HEAD` 在新分支上置备一个关联工作树;返回 `open` 记录、工作者所在目录,以及工作树中不包含的任何未提交的基础改动 |
| `attach` | 在一个 `open` 的工作树上记录一个工作者会话 id 及其路由;当某次 `accept` 持有该工作树时,以及工作树已关闭后,均会拒绝 |
| `resolveReviewer` | 解析评审者路由——依次为操作者覆盖、`Config`、调用者自身的路由——若在 `requireDistinctReviewer` 生效时该路由与工作者路由相同,则抛出异常 |
| `accept` | 唯一会提交或合并的操作:参见[运行流程](#run-flow) |
| `discard` | 删除一个工作树及其分支而不合并。它在任何 git 改动之前先在记录锁下占有该记录,因此当某次 `accept` 持有该工作树或已挂接的工作者的 Agent 仍在运行时会拒绝执行;已经不存在的目录或分支会被跳过。对 `merged` 记录,它只清除遗留的工作树或分支,状态保持 `merged` |
| `list` | 列出一个仓库的工作树,可按所有者过滤,并可选择包含已关闭的记录 |

每个方法都会对调用者进行鉴权:`session` 所有者只能操作自己的工作树,而 `operator`(`dsh agents` 命令行)可以操作该仓库的任何工作树。`create` 和 `list` 会根据仓库内部的 `baseDir` 解析目标仓库;`attach`、`accept` 和 `discard` 只接收工作树 id,并在 `root` 下的每个仓库中搜索该记录,因为记录自身的 `repoRoot` 之后会为每一条后续 git 命令提供所属仓库。

`accept` 的 `testCommand` 与 `reviewer` 覆盖项仅限操作者使用:`session` 所有者只要设置其中任何一个,就会在提交任何内容之前被拒绝。每个接收工作树 id 的方法,都会在据此构造任何路径之前,先用导出的 `assertWorktreeId`(`wt-` 后跟八位小写十六进制数字)校验它;从磁盘读取的每条记录,还会与其文件名、工作树目录、分支以及完整的 40 位提交 id 进行核对,不一致时立即报错。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明该服务背后的设计决策,以及[使用本包](#use-this-package)中所述行为的由来。

### 设计概念

每个工作树、其持久化的 JSON 记录及其一次性的评审检出目录,都存放在以仓库的 git 公共目录哈希值为键的单个按仓库划分的目录下,因此互不相关的两个仓库永远不会冲突,同一仓库的所有关联工作树共用一个记录目录、合并锁和 `maxWorktrees` 计数,工作树也永远不会存在于它所隔离的仓库内部。每条记录仍以创建它的那个检出目录作为合并目标。一条记录会在 `open → reviewing → open | merged` 与 `open → discarded` 之间迁移;向 `reviewing` 与 `discarded` 的迁移以及 `attach`,都在该记录自身的写者锁之下检查状态与正在运行的工作者,而不是在获取锁之前检查,因为只有这把锁才能串行化并发的操作。当任何操作下一次读取某条 `reviewing` 记录时,若其接受进程已不再存在,则会被视为 `open`(崩溃恢复)。

<a id="run-flow"></a>
### 运行流程:`accept`

1. 拒绝设置了 `testCommand` 或 `reviewer` 的 `session` 所有者,然后加载记录并鉴权调用者。
2. 在记录锁之下检查记录是否为 `open`(或其接受进程已不存在的 `reviewing`),以及已挂接工作者的 Agent 是否仍在运行,然后迁移到 `reviewing`。
3. 提交:执行 `git add -A`,仅当确有内容被暂存时才提交(仅当配置了 `commitAuthorName`/`commitAuthorEmail` 时才附加 `-c user.name=`/`-c user.email=`)。若得到的提交与工作树的基础提交相同,则结果为 `empty`,记录回到 `open`。
4. 若针对这一确切提交已记录过通过的评审结果,则直接跳到合并步骤——对未产生新改动的被阻塞或冲突的合并重试,不必为此再付出一次评审的代价。
5. 否则,在该提交处的一个一次性分离检出目录中(会先清理同一工作树遗留的过期检出目录):在 `checkTimeoutMs` 限制下运行已配置的检查命令(如果有)——非零退出码或超时即为 `checks-failed`,评审者不会启动——然后通过 `ctx.subagents.start('spawn', …)` 启动评审子智能体,其提示词中包含有边界的 diff 与该工作树的任务描述,并在宿主代码中校验其结构化结果是否符合评审结果 schema。缺失或无效的结果,或者停止原因不是 `completed` 的运行,都会被视为 `fail` 评审结果,并附带结论 `the reviewer returned no structured verdict`——即失败关闭(fail closed),绝不会抛出异常,也绝不会视为通过。
6. `fail` 评审结果会得到 `rejected`;工作树回到 `open`。`pass` 评审结果会在按仓库划分的合并锁之下尝试对基础检出目录执行 `git merge --no-ff --no-edit`,最多等待十分钟以让另一次 accept 的合并完成(并行的工作者从同一基础分支而来,因此在第一次合并之后,后续任何分支都无法再进行快进合并)。尝试开始前会先检查:若基础检出目录已有正在进行的合并(存在 `MERGE_HEAD`)或 `HEAD` 已分离,则不运行 `git merge`,直接报告 `blocked`。真正的冲突会中止合并并报告冲突的路径,同时保留该分支;从未开始的合并(例如因为会覆盖本地改动)会报告有边界的 git 消息;被终止或在开始后失败的合并会被中止——仅限本次 accept 自己发起的合并——并抛出异常。冲突与被阻塞这两种情况都会让记录保持 `open` 并保留评审结果。
7. 合并尝试一结束就释放该锁。一次成功的合并会先被记录——状态置为 `merged`,记录合并提交 id——然后 `removeOnMerge` 才会删除工作树及分支。合并提交一旦存在,记录就绝不会被重新打开:写入 `merged` 状态失败会抛出一个说明合并已经落地的错误,而删除失败只会被记录日志并返回 `removed: false` 的 `merged` 结果,随后由 `discard` 完成清理。
8. 合并落地之前抛出的任何错误,都会先让仍处于 `reviewing` 的记录回到 `open`,再重新抛出该错误;这一尽力而为的恢复操作本身若失败,只会被记录日志,绝不会掩盖原始错误,期间状态已被改变的记录则保持不动。

### 源码结构

| 文件 | 角色 |
|---|---|
| [`src/types.ts`](src/types.ts) | 公开的请求、记录与结果类型(仅包含类型) |
| [`src/text.ts`](src/text.ts) | 逐字的工作者简报、评审者提示词,以及评审者的评审结果 schema |
| [`src/index.ts`](src/index.ts) | `SubagentWorktrees` 服务:`Config` 接口与 schema、加载时对根目录与身份的解析、精简的方法体,以及导出的 `assertWorktreeId` |
| [`src/config.ts`](src/config.ts) | 在加载时一次性解析并校验扁平化的评审者路由与提交作者 `Config` 字段;`Config` 本身声明在 `src/index.ts` 中 |
| [`src/worktree-id.ts`](src/worktree-id.ts) | `wt-` id 格式校验器,在每个公开方法处以及据 id 构造任何路径之前使用 |
| [`src/git.ts`](src/git.ts) | 通过 `ctx.subprocess` 执行的 argv 形式 git 命令,带有经过清理的非交互式环境、有边界的输出,以及对需要解析的输出的有损捕获检查 |
| [`src/check-command.ts`](src/check-command.ts) | 在时限内运行已配置的(非 git)检查命令并收集其合并输出 |
| [`src/paths.ts`](src/paths.ts) | 纯粹的目录布局计算:按仓库划分的键及其下的每一条路径 |
| [`src/records.ts`](src/records.ts) | 持久化的按工作树划分的 JSON 记录:schema 与完整性校验、原子化的加锁写入、按 id 的跨仓库查找,以及所有者/状态的断言 |
| [`src/workers.ts`](src/workers.ts) | `accept` 与 `discard` 共用的、对正在运行的已挂接工作者的拒绝逻辑 |
| [`src/repo.ts`](src/repo.ts) | `create` 与 `list` 共用的仓库身份(顶层检出目录与共享的 git 公共目录)解析 |
| [`src/create.ts`](src/create.ts) | `create` 流程:仓库解析、`maxWorktrees`、失败时带清理的置备过程、基础检出目录的脏改动摘要 |
| [`src/review.ts`](src/review.ts) | 评审子智能体:限定 diff 的边界、启动它,并校验其结构化结果 |
| [`src/merge.ts`](src/merge.ts) | `--no-ff` 合并尝试:开始前的拒绝检查,以及冲突、被阻塞与被终止合并的分类 |
| [`src/accept.ts`](src/accept.ts) | [运行流程](#run-flow)中所述的 `accept` 编排逻辑 |
| — | 本包未发布运行时不变量伴生模块;每一次状态迁移本就只能通过本包自身对记录锁与所有者检查的强制执行才能触及,因此不存在对同一关系的独立观测会与之产生分歧。 |

<a id="host-realm-git"></a>
### 宿主域中的 git

本包中的每一次 git 与检查命令调用都通过 `ctx.subprocess`、以显式的 argv 与 cwd 执行——绝不经过 shell——并且运行在**宿主域**中,而不在任何会话沙箱内部:部署环境针对被委派工作者自身工具调用的隔离策略,并不适用于本服务自身的 git 底层操作。这些命令的 argv 只来自 `Config` 或操作者(命令行)输入,绝不来自模型输入,这正是使其在不受沙箱约束的情况下运行仍可接受的原因。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级别的约定不足以说明问题时,请阅读以下页面;它们会从共享的 subagent 模型延伸到把工作树隔离呈现给模型或操作者的消费方。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——启动请求、结果、provider 约定,以及进程内的深度与种子。
- [dsh-subagent](../subagent/README.zh.md)——本包的评审子智能体所运行于其上的委派服务(`ctx.subagents`)。
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.zh.md)——评审者运行所依赖的全新子智能体后端(provider 名称为 `spawn`)。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-worktree)——每个可接受的配置字段及其源码声明。

-----

<a id="model-experience"></a>
## 模型体验

### 工作者简报与评审者提示词(间接地,通过消费方)

#### 模型所见内容

本服务本身不添加任何工具,也不添加任何系统提示词片段;它从不在模型自身的回合内部运行。它拥有两段逐字的、面向模型的文本,由某个消费方代表它发送:`renderWorkerBrief` 说明工作树的路径、分支和基础提交,并要求工作者不要运行会产生写入的 git 命令,该文本会被添加到委派消费方发给工作者的第一条消息之前;`renderReviewerPrompt` 说明评审检出目录、提交范围、任务内容,以及一段有字节边界的改动 `git diff`,并要求评审子智能体调用 `structured_output` 工具,给出 `pass` 或 `fail` 的评审结果、一段摘要、它运行过的检查,以及每个问题各一条结论。

#### Token 影响

工作者简报会在工作者收到的第一条消息中,添加一段固定的提示文字,以及该工作树自身的路径、分支和提交 id。评审者提示词对应每一次需要评审的 `accept` 都是一次新的、独立的智能体运行:其主要的可变开销是 diff,上限为 `Config.reviewDiffMaxBytes`(默认 48 KiB),被截断时会附带一条截断提示。若某个提交此前已记录过通过的评审结果,则会完全跳过评审者,不产生额外的 token 开销。

#### KV 缓存影响

彼此独立的模型请求:工作者的第一条消息与评审子智能体的提示词,各自开启一段全新的对话,与委派智能体自身的历史记录没有共享的前缀。

## 已知限制与延后事项

<a id="known-limitations-and-deferred-work"></a>

- **git 与检查命令运行在宿主域中,不受沙箱约束**——本包自身的 git 底层操作以及已配置的检查命令都在任何会话沙箱之外运行(参见[宿主域中的 git](#host-realm-git));若某个部署要求所有子进程都受到隔离约束,则不应将 `testCommand` 指向任何不会直接在宿主机上运行的内容。
- **尚未在 Windows 上验证**——git 工作树的布局、路径处理,以及 `@deepseek-ai/dsh-atomic-write` 中的文件锁接管逻辑,在本包自身的测试中只在 macOS 与 Linux 上得到过验证。
- **工作者需自行安装依赖**——工作树只是一个普通的关联检出目录,不共享任何 `node_modules`;工作者简报会要求工作者在需要时从本地缓存安装依赖,但本服务本身不会代为执行此操作。
- **基础检出目录中未提交的改动不会带入新的工作树**——`create` 会将这些改动作为 `baseDirty` 报告(最多 20 条,并附总数),以便调用方对此发出提示,但工作树始终只会从基础检出目录已提交的 `HEAD` 分支而来。
- **`maxWorktrees` 在并发下只是建议值**——`create` 先统计打开的工作树,再在两者之间不加锁的情况下持久化记录,因此对同一仓库同时发起的两次 `create` 可能都通过检查。
- **被回收的进程 id 可能钉住工作树**——崩溃的 accept 会让其记录保持 `reviewing` 并带着其进程 id;若某个无关的后续进程复用了该 id,这条记录就会被当作仍在运行的 accept:该工作树会一直被拒绝为“正在被接受”,直到操作者清理该记录。`withFileLock` 对自己的锁接管也记录了同样的限制。
- **diff 超过 8 MiB 的改动无法评审**——`accept` 会立即报错,而不是嵌入不完整的 diff,并让工作树回到 `open`。
- **被中断的 discard 会留下遗留物**——`discard` 在删除任何东西之前先占有记录,因此中途失败会让记录保持 `discarded`,而工作树或分支仍然存在;请用 `git worktree remove` 与 `git branch -D` 手动清除。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

无。

</details>
