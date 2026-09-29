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

工作树隔离通过注册而不是配置向委派工具提供：`ctx.subagentWorktrees.offerIsolation()` 计入一个有效的提供，并返回用于撤回它的 disposer（再次调用无任何效果）；只读的 `offersIsolation` getter 在至少存在一个有效提供时为 true。提供方具备 `cwd` 能力的委派工具，在 `offersIsolation` 为 true 期间会提供 `isolation: "worktree"` 参数（同时仍参考其自身 `worktreeIsolation` 行的设置），并在 `subagent-worktree/offer-changed` 报告翻转时重新挂载；该事件携带新的取值，仅在翻转时触发，监听器抛出异常或被拒绝时只记录日志，不会向外传播。`@deepseek-ai/dsh-tool-subagent-worktree` 在其工具挂载期间注册一个提供，因此提供随这些工具出现和消失，并能触及由智能体预设挂载的工具（bundle 补丁无法改动这些预设中的行）；针对本服务条目的 profile 补丁无法移除它。

### 服务接口

除了上述提供注册之外,`ctx.subagentWorktrees` 暴露六个方法,每个方法都接收单一的请求对象:

| 方法 | 效果 |
|---|---|
| `create` | 从基础检出目录的 `HEAD` 在新分支上置备一个关联工作树;返回 `open` 记录、工作者所在目录,以及工作树中不包含的任何未提交的基础改动 |
| `attach` | 在一个 `open` 的工作树上记录一个工作者会话 id 及其路由;当某次 `accept` 持有该工作树时,以及工作树已关闭后,均会拒绝 |
| `resolveReviewer` | 解析评审者路由——依次为操作者覆盖、`Config`、调用者自身的路由——若在 `requireDistinctReviewer` 生效时该路由与工作者路由相同,则抛出异常 |
| `accept` | 唯一会提交或合并的操作:参见[运行流程](#run-flow) |
| `discard` | 删除一个工作树及其分支而不合并。它在任何 git 改动之前先在记录锁下占有该记录,因此当某次 `accept` 持有该工作树或已挂接的工作者的 Agent 仍在运行时会拒绝执行;已经不存在的目录或分支会被跳过,而分支探测若被取消,或以文档所述答案之外的退出码结束,则会抛出异常,因此无法检查该分支的清扫绝不会在留下该分支的情况下报告成功。对 `merged` 或 `discarded` 记录,它除了清除遗留的工作树或分支外不做任何改动,因此中途失败的 `discard` 可以再次运行以完成清理。若某条过期的 `reviewing` 记录所评审的提交已经落地,则与 `accept` 一样先将其记为 `merged` |
| `list` | 列出一个仓库的工作树,可按所有者过滤,并可选择包含已关闭的记录 |

每个方法都会对调用者进行鉴权:`session` 所有者只能操作自己的工作树,而 `operator`(`dsh agents` 命令行)可以操作该仓库的任何工作树。`create` 和 `list` 会根据仓库内部的 `baseDir` 解析目标仓库;`attach`、`accept` 和 `discard` 只接收工作树 id,并按名称顺序在 `root` 下的每个仓库中搜索该记录,因为记录自身的 `repoRoot` 之后会为每一条后续 git 命令提供所属仓库。无法作为仓库读取的目录项,以及记录目录中名称不是工作树 id 的 `.json` 文件,会被跳过并记录一条警告;而所请求 id 对应的记录文件若存在但无法读取、已损坏或不一致,仍会立即报错。

`accept` 的 `testCommand` 与 `reviewer` 覆盖项仅限操作者使用:`session` 所有者只要设置其中任何一个,就会在提交任何内容之前被拒绝。每个接收工作树 id 的方法,都会在据此构造任何路径之前,先用导出的 `assertWorktreeId`(`wt-` 后跟八位小写十六进制数字)校验它;从磁盘读取的每条记录,还会与其文件名、工作树目录、分支以及完整的提交 id(40 位十六进制数字,SHA-256 仓库中为 64 位)进行核对,不一致时立即报错。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明该服务背后的设计决策,以及[使用本包](#use-this-package)中所述行为的由来。

### 设计概念

每个工作树、其持久化的 JSON 记录及其一次性的评审检出目录,都存放在以仓库名称及其 git 公共目录哈希值为键的单个按仓库划分的目录下,因此互不相关的两个仓库永远不会冲突,同一仓库的所有关联工作树共用一个记录目录、合并锁和 `maxWorktrees` 计数,工作树也永远不会存在于它所隔离的仓库内部。每条记录仍以创建它的那个检出目录作为合并目标。一条记录会在 `open → reviewing → open | merged` 与 `open → discarded` 之间迁移;向 `reviewing` 与 `discarded` 的迁移以及 `attach`,都在该记录自身的写者锁之下检查状态与正在运行的工作者,而不是在获取锁之前检查,因为只有这把锁才能串行化并发的操作。当任何操作下一次读取某条 `reviewing` 记录时,若其接受进程已不再存在,则会被视为 `open`(崩溃恢复),除非其工作树仍恰好保持被评审的提交且该提交已经在基础检出目录的历史中,此时它会被记为 `merged`。`merged` 与 `discarded` 记录已关闭:对它们可以重复执行 `discard` 以清除遗留物,但没有任何操作会重新打开它们。

<a id="run-flow"></a>
### 运行流程:`accept`

1. 拒绝设置了 `testCommand` 或 `reviewer` 的 `session` 所有者,然后加载记录并鉴权调用者。
2. 若记录是接受进程已不存在的 `reviewing`,其最后一次评审结果为通过,其工作树仍恰好保持被评审的提交(其 `HEAD` 就是该提交,且没有被修改、已暂存或未跟踪的内容),并且该提交已是基础检出目录 `HEAD` 的祖先,说明之前的某次 accept 在合并落地之后才崩溃:将其记为 `merged` 并记录使其落地的提交,在设置了 `removeOnMerge` 时清除遗留物,并返回 `merged`,不再进行第二次评审或合并。工作树中若还有更多内容,则不会被恢复,其较新的工作与其他工作一样接受评审。这次“落地提交”的读取会先在调用者的信号上尝试一次,再在全新信号上重试一次,与合并路径自身的读取完全一致,因为失败往往正是调用者的取消所致;若两次都失败,记录仍会以 `merged` 关闭——不带 `mergedCommit`,失败写入宿主日志——并抛出一个说明合并已经落地的错误,因为若把记录留在 `reviewing`,之后每一次 `accept` 都会因一次可能永远不会成功的读取而失败。
3. 在记录锁之下检查记录是否为 `open`(或其接受进程已不存在的 `reviewing`),以及已挂接工作者的 Agent 是否仍在运行,然后迁移到 `reviewing` 并记录接受进程的 id。评审可能持续数分钟,期间工作者可能重新启动,因此对运行中工作者的检查会在 `git add` 之前和 `git merge` 之前各重复一次。
4. 提交:执行 `git add -A`,仅当确有内容被暂存时才提交(仅当配置了 `commitAuthorName`/`commitAuthorEmail` 时才附加 `-c user.name=`/`-c user.email=`)。若得到的提交与工作树的基础提交相同,则结果为 `empty`,记录回到 `open`。
5. 若针对这一确切提交已记录过通过的评审结果,则直接跳到合并步骤——对未产生新改动的被阻塞或冲突的合并重试,不必为此再付出一次评审的代价。
6. 否则,在该提交处的一个一次性分离检出目录中(会先清理同一工作树遗留的过期检出目录):在 `checkTimeoutMs` 限制下运行已配置的检查命令(如果有)——非零退出码或超时即为 `checks-failed`,评审者不会启动——然后通过 `ctx.subagents.start('spawn', …)` 启动评审子智能体,其提示词中包含有边界的 diff 与该工作树的任务描述,并在宿主代码中校验其结构化结果是否符合评审结果 schema。缺失或无效的结果,或者停止原因不是 `completed` 的运行,都会被视为 `fail` 评审结果,并附带结论 `the reviewer returned no structured verdict`——即失败关闭(fail closed),绝不会抛出异常,也绝不会视为通过。
7. `fail` 评审结果会得到 `rejected`;工作树回到 `open`。`pass` 评审结果会在按仓库划分的合并锁之下尝试对基础检出目录执行 `git merge --no-ff --no-edit`,最多等待十分钟以让另一次 accept 的合并完成(并行的工作者从同一基础分支而来,因此在第一次合并之后,后续任何分支都无法再进行快进合并)。尝试开始前会先检查:若基础检出目录已有正在进行的合并(存在 `MERGE_HEAD`)或 `HEAD` 已分离,则不运行 `git merge`,直接报告 `blocked`;被取消或失败的探测会抛出异常,而不会被当作一个答案。`git merge` 失败时由基础检出目录的状态来判定,因为 git 的退出码无法区分拒绝与错误。退出码 128 既表示 git 在什么都没开始时就已中止——最常见的原因是基础检出目录里已有另一场合并正在进行——也表示开始之后的部分失败(`write_merge_state()` 可能在 `MERGE_HEAD` 写好后中止,`finish()` 可能在合并已应用后中止),因此要按它留下的 `MERGE_HEAD` 分类:没有 `MERGE_HEAD` 且检出目录干净时,若被评审提交已在基础检出目录的历史中(`git merge-base --is-ancestor`,也就是 `finish()` 在合并已应用后中止时所留下的状态),则为 `merged`;否则为 `blocked`——当检出目录存在未合并路径时,以其他操作留下的冲突作为原因,否则附带有边界的 git 消息——而无法回答这两个问题中任何一个的探测会抛出异常,而不会被当作一个答案(对这些未合并路径的扫描失败时同样如此);指向另一个提交时为 `blocked`,并让那场合并保持原状;指向本次 accept 正在合并的那个提交时则保持原状并抛出异常,因为无法把它与另一场针对同一提交发起的合并区分开,而 git 对后者也会以同样的方式拒绝且不做任何改动——错误会说明必须在基础检出目录中用 `git merge --abort` 完成或中止它,而绝对路径与提交只写入宿主日志。其他失败的合并仍按其状态分类:属于本次 accept 自己的合并会在任何进一步探测之前先被中止,其中以冲突退出码停止的合并会先读取其未合并路径(中止会丢弃这些路径),以便报告为 `conflict` 并附带这些路径,同时保留该分支;这次读取与退出码 128 下的扫描都会显式要求包含子模块(`--ignore-submodules=none`),因此任何 git 配置都无法让一个只以子模块 gitlink 冲突的合并被读成“没有冲突”,并且读取失败或扫描失败都不会跳过中止——两者都会抛出 id 与一段固定描述,而 git 的消息(其中可能含有绝对路径)与绝对路径只写入宿主日志;存在本次 accept 未创建的冲突或 `MERGE_HEAD` 时报告 `blocked`,且保持原状;从未开始的合并(例如因为会覆盖本地改动)报告 `blocked` 并附带有边界的 git 消息;被终止或在开始后没有冲突却失败的合并会被中止——仅限本次 accept 自己发起的合并——并抛出异常。若中止未能清除 `MERGE_HEAD`,或中止及其检查失败,或合并失败后紧接着的 `MERGE_HEAD` 探测失败,则尝试会抛出异常,说明基础检出目录仍处于合并中途(或可能如此),必须在其中用 `git merge --abort` 中止,而不会返回声称没有合并任何内容的结果;若中止确实清除了本次 accept 的合并,但其后的检查发现 `MERGE_HEAD` 指向另一个提交,则尝试会抛出异常,说明本次 accept 的合并已被中止、而另一场合并正在进行,并且会保持那一场合并原状,不会去中止它;绝对路径只写入宿主日志。冲突与被阻塞这两种情况都会让记录保持 `open` 并保留评审结果。
8. 合并尝试一结束就释放该锁。一次成功的合并会先在一次写入中被记录——状态置为 `merged` 并写入 `mergedCommit`——然后 `removeOnMerge` 才会删除工作树及分支。`mergedCommit` 是把被评审提交列为父提交的合并提交;若没有这样的合并提交(它被快进合并,或 `git merge` 发现它已被包含),则为被评审的提交本身,绝不会是无关的较新 `HEAD`;这些合并提交按拓扑顺序从新到旧列出,因此一个合并绝不会被列在它所派生的合并之前,而列出被评审提交的最后一行就是它在 DAG 顺序中最早的落地,无论各提交的日期如何;当基础检出目录的历史长于该命令的字节上限时,保留下来的是其中最旧的那些——答案恰在其中——并且会丢弃这种被截断列表里可能不完整的第一行,而被截断的列表里若没有任何一行列出被评审提交,则会抛出异常,而不是用被评审提交本身作答——该 id 很可能就在被裁掉的那部分里。自 `git merge` 退出码为 0 起,记录就绝不会被重新打开。读取该提交失败时会重试一次;若仍无法读取,则记录 `merged` 但不带该提交,并抛出一个说明合并已经落地的错误。写入 `merged` 状态失败会尽力释放 accept 的占有标记,使下一次 `accept` 或 `discard` 能把这条过期记录识别为已落地,并抛出一个说明合并已经落地的错误。删除失败只会被记录日志并返回 `removed: false` 的 `merged` 结果,随后由 `discard` 完成清理。
9. 合并落地之前抛出的任何错误,以及每一种未合并的结果(`empty`、`checks-failed`、`rejected`、`conflict`、`blocked`),都会让记录回到 `open`。只有仍处于 `reviewing` 的记录才会重新打开,并同时放弃其 accept 占有标记;期间已被丢弃或记为 `merged` 的记录则保持存储时的样子。抛出错误之后这一尽力而为的恢复操作本身若失败,只会被记录日志,绝不会掩盖原始错误,并且重新打开的写入失败时会尽力释放 accept 的占有标记,使仍存活的进程 id 不会钉住该记录。

在调用者取消之后仍必须执行的清理——中止本次 accept 自己发起的合并、删除评审检出目录、删除已合并的工作树,以及删除因 `create` 失败而已置备的工作树——每条 git 命令都会各自申请一个全新的 30 秒信号,而不是使用请求自身的信号,因为在已中止的信号上启动的 git 命令永远不会运行,而超时的命令也不能中止其后的命令。

### 源码结构

| 文件 | 角色 |
|---|---|
| [`src/types.ts`](src/types.ts) | 公开的请求、记录与结果类型(仅包含类型) |
| [`src/text.ts`](src/text.ts) | 逐字的工作者简报、评审者提示词,以及评审者的评审结果 schema |
| [`src/bounds.ts`](src/bounds.ts) | 面向持久化文本与模型可见文本的字节、字符与行数边界:在 UTF-8 字符边界处截取的评审 diff 前缀、检查与合并输出的诊断尾部,以及基础检出目录的脏改动状态摘要 |
| [`src/index.ts`](src/index.ts) | `SubagentWorktrees` 服务:`Config` 接口与 schema、精简的方法体、导出的 `assertWorktreeId`,以及构造函数——它在加载时一次性解析 `root`、评审者路由与提交作者(`create` 与 `list` 则在每次调用时通过 `repoIdentityOf` 解析仓库) |
| [`src/config.ts`](src/config.ts) | 在加载时一次性解析并校验扁平化的评审者路由与提交作者 `Config` 字段;`Config` 本身声明在 `src/index.ts` 中 |
| [`src/worktree-id.ts`](src/worktree-id.ts) | `wt-` id 格式:在每个公开方法处以及据 id 构造任何路径之前使用的 `assertWorktreeId`,以及记录列表用来跳过无关文件的、不抛异常的 `isWorktreeId` |
| [`src/guards.ts`](src/guards.ts) | 存储记录校验与评审结果校验共用的结构化类型守卫(`isPlainObject`、`isStringArray`) |
| [`src/git.ts`](src/git.ts) | 通过 `ctx.subprocess` 执行的 argv 形式 git 命令,带有经过清理的非交互式环境、有边界的输出、对需要解析的输出的有损捕获检查、唯一一处接受“被字节上限截断到只剩尾部”的列表的读取,以及 `cleanupSignal`——每条清理命令各自运行所用的、全新且有时限的信号 |
| [`src/check-command.ts`](src/check-command.ts) | 在时限内运行已配置的(非 git)检查命令并收集其合并输出 |
| [`src/paths.ts`](src/paths.ts) | 纯粹的目录布局计算:按仓库划分的键及其下的每一条路径 |
| [`src/fs-util.ts`](src/fs-util.ts) | `pathExists`,记录与工作树目录查找共用的存在性探测:`stat` 成功时为 `true`,遇到 `ENOENT` 时为 `false`,其他任何失败则抛出异常 |
| [`src/records.ts`](src/records.ts) | 持久化的按工作树划分的 JSON 记录:schema 与完整性校验、原子化的加锁写入、按 id 的跨仓库查找与按仓库的列表(两者都会跳过无关条目并给出警告),以及所有者/状态的断言 |
| [`src/workers.ts`](src/workers.ts) | `accept` 与 `discard` 共用的、对正在运行的已挂接工作者的拒绝逻辑 |
| [`src/repo.ts`](src/repo.ts) | `repoIdentityOf`:仓库身份(顶层检出目录与共享的 git 公共目录)解析,由 `create` 与 `list` 在每次调用时使用 |
| [`src/create.ts`](src/create.ts) | `create` 流程:仓库解析、`maxWorktrees`、失败时带清理的置备过程、基础检出目录的脏改动摘要——按未跟踪目录各一条读取,因此一个含有数万个未跟踪文件的基础检出目录仍能在捕获上限之内给出摘要,而不会让 `create` 直接失败 |
| [`src/review.ts`](src/review.ts) | 评审子智能体:限定 diff 的边界、启动它,并校验其结构化结果 |
| [`src/merge.ts`](src/merge.ts) | `--no-ff` 合并尝试:开始前的拒绝检查、依据基础检出目录状态对失败合并的分类(也包括退出码 128,它同样可能出现在合并已开始之后,因此指向同一提交的 `MERGE_HEAD` 会保持原状并抛出异常,而已在基础检出目录历史中的提交则经由 `git merge-base --is-ancestor` 判为 `merged`)、未合并路径读取及其 `--ignore-submodules=none`、仅中止本次 accept 自己发起的合并、读取失败的原因写入宿主日志而不进入错误消息,以及 `landedCommitOf`——使被评审提交落地的那个提交,按拓扑顺序从新到旧从其列表最旧的一端读取,因此无论是被回填日期的再次落地,还是长于输出上限的历史,都无法藏起最早的那次落地,且当被截断的列表里没有任何一行列出被评审提交时会抛出异常 |
| [`src/landed.ts`](src/landed.ts) | 对所评审提交已经落地、且工作树仍恰好保持该提交的过期 `reviewing` 记录的恢复(即使无法读取使它落地的提交,也会以 `merged` 关闭;该读取会在全新信号上重试一次,失败则记录日志),以及 `accept` 与 `discard` 共用的、对工作树目录、注册信息与分支的清扫——其分支探测若没有给出答案就会抛出异常 |
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

本服务本身不添加任何工具,也不添加任何系统提示词片段;它从不在模型自身的回合内部运行。它拥有两段逐字的、面向模型的文本,由某个消费方代表它发送:`renderWorkerBrief` 说明工作树的路径、分支和基础提交,并要求工作者不要运行会产生写入的 git 命令,该文本会被添加到委派消费方发给工作者的第一条消息之前;`renderReviewerPrompt` 说明评审检出目录、提交范围、任务内容,以及一段有字节边界的改动 `git diff`,并要求评审子智能体调用 `structured_output` 工具,给出 `pass` 或 `fail` 的评审结果、一段摘要、它运行过的检查,以及每个问题各一条结论。在隔离提供有效期间,每个提供方具备 `cwd` 能力的委派工具的 `subagent` 工具中也会出现 `isolation: "worktree"` 参数,包括由 agent 预设挂载的工具;该参数自身的措辞归属于该工具的文档。

#### Token 影响

工作者简报会在工作者收到的第一条消息中,添加一段固定的提示文字,以及该工作树自身的路径、分支和提交 id。评审者提示词对应每一次需要评审的 `accept` 都是一次新的、独立的智能体运行:其主要的可变开销是 diff,上限为 `Config.reviewDiffMaxBytes`(默认 48 KiB),被截断时会附带一条截断提示。若某个提交此前已记录过通过的评审结果,则会完全跳过评审者,不产生额外的 token 开销。在隔离提供有效期间,每个受影响的 `subagent` 工具定义在每次请求中都会带上新增的 `isolation` 参数;没有有效提供时则不会增加任何内容。

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
- **被中断的 discard 会留下遗留物**——`discard` 在删除任何东西之前先占有记录,因此中途失败会让记录保持 `discarded`,而工作树或分支仍然存在;排除原因后对它再次运行 `discard`,即可清除剩余部分。
- **无法中止的合并需要操作者介入**——当 `git merge --abort` 失败或无法确认时,`accept` 会抛出异常,说明基础检出目录仍处于合并中途,并重新打开该工作树;操作者需要在基础检出目录中运行 `git merge --abort`,因为在此之前,之后的每次 `accept` 都会被这场进行中的合并阻塞。
- **并非由本框架发起的合并绝不会被中止**——退出码 128 既表示 git 在什么都没开始时就已中止(最常见的原因是基础检出目录中已有另一场合并正在进行),也表示开始合并之后的部分失败,因此在该退出码下:`MERGE_HEAD` 指向另一个提交时报告 `blocked` 并完全保持原样;指向本次 accept 正在合并的那个提交时则保持原样并抛出异常,因为无法把本次 accept 自己半途应用的合并与另一场针对同一提交发起的合并区分开,而 git 对后者也会以同样的方式拒绝且不做任何改动,错误会说明必须在基础检出目录中完成或中止这场合并。没有 `MERGE_HEAD` 且没有未合并路径的退出码 128,则由 `git merge-base --is-ancestor` 来判定:在 `finish()` 中、合并结果已应用之后中止的合并会被算作 `merged`——与退出码为 0 的合并走完全相同的路径,包括 `onLanded`——因此之后的 `accept` 不会再去合并它一次,只有不在基础检出目录历史中的提交才会报告 `blocked` 并附上 git 的消息。本次 accept 自己那次中止之后的检查,也可能在其中发现替换进来的、属于另一个提交的 `MERGE_HEAD`。两种情况都会让该仓库中之后的每次 `accept` 都被那场合并阻塞,直到发起它的那一方完成为止。
- **恢复探测失败会阻塞 `accept`,但不会阻塞 `discard`**——用于判断一条过期 `reviewing` 记录是否已经合入的探测(`git merge-base --is-ancestor`、`rev-parse HEAD`、`status --porcelain`)都有各自约定的退出码;被取消的探测,或以其他任何退出码结束的探测,都会抛出带工作树 id(绝不含路径)的错误,而不会被当作“未合并”读取,其中包括 verdict 指向一个 git 已无法解析的提交(即退出码 128)的情况。没有答案时 `accept` 无法安全地合并或标记状态,因此记录会完全保持原样,不会被加上任何占用标记,并且此后会一直以同样方式失败,直到操作者修复 git 状态或清掉该记录。`discard` 则会记录这次失败(含路径),并继续把记录标记为 `discarded` 并清扫它:删除正是 `discard` 的全部目的,而任何确实已经合入的合并都留在基础检出目录的历史中。
- **状态读取会被要求看到 `git add -A` 会暂存的内容**——恢复用的干净性检查会传入 `--untracked-files=all --ignore-submodules=none`,`create` 的 `baseDirty` 读取会传入 `--untracked-files=normal --ignore-submodules=none`(摘要只需按未跟踪目录各一条,这也让一个未跟踪的构建产物或 virtualenv 含有数万个文件的基础检出目录仍处于捕获上限之内,而不会让 `create` 直接失败),`accept` 的空变更检查会传入 `--ignore-submodules=none`(`git diff` 接受该选项;`--untracked-files` 是 `git status` 的选项),未合并路径的读取同样会传入 `--ignore-submodules=none`,因此 `status.showUntrackedFiles=no`、`status.ignoreSubmodules=all`、`submodule.<name>.ignore=all` 与 `diff.ignoreSubmodules=all` 都无法向它们隐藏改动或冲突。当该忽略设置导致 `git commit` 自身拒绝提交它所隐藏的已暂存改动时,`accept` 会以 `git commit failed` 立即报错并保留工作树,而不是报告 `empty`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

无。

</details>
