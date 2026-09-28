# Agent Note: worktree 隔离式委派与独立评审

Status: implemented

[English](2026-09-27-worktree-isolated-delegation.md) | 中文

## Problem

Lead agent 已经可以把工作拆分给多个 subagent，但每个 child 都共享 Lead 的 checkout。并行写入者会彼此冲突：文件系统的陈旧版本检查只保护 edit 工具，而 Bash、formatter 与 generator 会静默地互相覆盖，[Agent Teams 记录](2026-08-05-agent-teams.zh.md)也把提示性 write scope 记为唯一的缓解手段。child 的工作在落地之前没有任何检查，唯一的证据是 child 自己的报告。想把任务交给更便宜的 Harness agent 的人与外部 agent（Claude Code、Codex）没有任何命令可用。

## Decision

被委派的 agent 可以在自己关联的 git worktree 中工作，而 worktree 的改动只能通过一个 harness 操作进入基础 checkout：该操作会先让独立的 reviewer 检查确切的 commit。

- **Seam.** `SubagentStartRequest.cwd` 会替换子级持久 `SessionHeader.cwd` 中父级的工作目录。文件工具、shell 工作目录与沙箱写入根目录都源自该 header，因此无需改动沙箱。一次性路径以 `cwd` 能力作为该字段的准入条件，而只有全新的 `spawn` 提供方声明该能力；continuation manager 会校验该目录，并以同一能力为准入条件。cwd 与父级不同的可继续 child 不会被告知父级与它共享工作区。
- **Service.** `@deepseek-ai/dsh-subagent-worktree` 拥有 `ctx.subagentWorktrees`：它用 `git worktree add -b` 从基础 checkout 的 `HEAD` 出发，在 `<DSH_HOME>/worktrees/<repository key>/` 下创建分支，为每个 worktree 保留一条经 schema 校验的记录，并在宿主域中通过 `ctx.subprocess` 运行 git，其 argv 只来自配置或 operator 输入。
- **Accept.** harness 会提交该 worktree（被限制在自身 worktree 内的 child 无法写入基础仓库 `.git` 的 index 与 object），为该 commit 创建一次性的分离 checkout，运行可选的已配置检查命令，并在那里以结构化的评审结果 schema 启动一个 reviewer child。reviewer 路由的解析顺序是 operator 覆盖、配置，然后是接受操作所属 agent 的路由，且默认必须与 worker 的路由不同。只有绑定到该确切 commit 的 `pass` 才会被合并，合并时在跨进程锁下使用 `--no-ff`；冲突会中止合并并保留该 branch。
- **Consumers.** 当 `subagent` 工具的 `worktreeIsolation` 配置开启时，它会新增一个 `isolation: "worktree"` 参数。后台 worker 会在启动之前以预留的 child id 记录到它自己的 worktree 上，因此 accept 绝不会与它看不到的活跃 worker 竞争。`accept_worktree`、`discard_worktree` 与 `list_worktrees` 只作用于调用 Session 自己创建的 worktree，并在模型边界校验 worktree id；`agent-crew` skill 负责传授任务拆分、更便宜的 worker 路由与评审循环。可选的 `Agent crew` bundle 会在 Plugins 页面开启这些。`dsh agents` 命令就是随发行版交付的 `agents` profile：operator Session 每次 `run` 运行一个 worker，以 operator 身份接受它，并可选启动会收到 worker brief 与发现的 fixer。
- **Lifecycle.** 可继续 child 的工作目录若已不存在（例如其 worktree 已被合并并删除），恢复时会以类型化错误失败，而不是恢复进一个缺失的目录。

## Placement outside the checkout

worktree 位于 Harness 主目录之下，而不是仓库内部。`glob` 工具会搜索被忽略与隐藏的文件，并按修改时间排序，因此嵌套的 worktree 会把仓库的一份新鲜副本排在 Lead 自己的文件之前；Lead 的 checkout 中的 `git status` 与 `git add -A` 也会看到它。沙箱根目录就是其 checkout 的 Lead 仍可以在外部 worktree 中提交并合并，因为每一次 git 写入都落在基础仓库的 `.git` 里；只有删除该目录需要 harness。

## Alternatives considered

**把 worktree 放在仓库内部（`.dsh/worktrees/`）。** 因上述搜索与 status 污染而拒绝。

**本地 clone。** 拒绝：它们会复制 object 与 ref，把落地变成从 child 可写仓库发起的一次 fetch，并让 child 得以写入 Lead 之后会执行的 git 配置与 hook。

**由 child 提交自己的工作。** 拒绝：在 `workspace-write` 下 child 无法写入基础仓库的 `.git`，而把它的根目录放宽到共享 object store 会让它可以改写其他 branch。

**靠 skill 教 Lead 执行 `git merge`。** 作为落地路径拒绝：只写在 prompt 文本里的校验并不会被强制执行。Lead 仍可以手工合并 branch；`accept_worktree` 是结果意味着「已评审」的那个操作。

**强制性的 harness 变更门禁。** 拒绝：回退整份改动也会一并删除它新增的测试，而把实现与测试文件分开是项目特有的。reviewer 会带着判断执行回退检查并报告结果；已配置的检查命令仍可作为确定性门禁使用。

**只允许 fast-forward 的合并。** 拒绝：并行 worker 从同一基础分支而来，因此第一次合并之后，后续 branch 都无法 fast-forward。

**在 Team 领域内实现隔离。** 不予采纳：[Agent Teams 记录](2026-08-05-agent-teams.zh.md)保留其共享 checkout 边界。这里的隔离是普通 `subagent` 工具上按每次委派显式提出的请求，而不是 Team 的推断。

## Consequences

每个 worker 与 reviewer 都在自己的 checkout 内安装项目依赖；本仓库的一次离线 pnpm install 在沙箱下只需几秒。Lead 未提交的改动不会带入 worktree，创建操作会报告它们。每次 accept 都要付出一次 reviewer 运行的代价；同一 commit 已经通过时则跳过。记录与 worktree 会跨越重启存活，直到被丢弃或合并。进程外提供方、workflow 工具的 `agent({ isolation })` 与非 git 后端仍然延后。

## Testing

seam 测试覆盖两条路径上对 cwd 的覆盖、校验与能力门禁。服务测试使用真实的临时仓库，覆盖创建、并行 `--no-ff` 合并、冲突、被阻塞的合并、评审结果门禁、失败关闭的评审结果解析、owner 检查与边界。工具、skill、bundle 与 CLI 测试固定模型可见文本与退出码；组合测试会通过 Loader 启动这些 bundle；一次真实模型的端到端运行会走通 worker、reviewer 与合并。
