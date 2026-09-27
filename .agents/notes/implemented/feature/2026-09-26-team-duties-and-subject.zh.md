# Agent Note：规划者与执行者分工以及 Team 主题

Status: implemented

[English](2026-09-26-team-duties-and-subject.md) | 中文

## 问题

Agent Teams 让 Lead 创建 teammate，并通过 mailbox 与共享任务板协调它们，但每个 teammate 都可以互相替换：任何成员都可以创建、claim、提交和验证任务，没有任何机制区分应当决定做什么的成员与应当动手做的成员。想要常见的先规划后执行分工的用户，每次都得用文字描述一遍，而且没有任何机制阻止负责规划的成员自己去修改文件。

Team 也没有说明它为何存在。启动 Team 只能写一条普通的首条消息，会话标题来自自动生成，Web 面板也无法说明 roster 与任务服务于哪个目标。

## 决定

创建 teammate 时可以指定分工（duty）：`planner` 或 `executor`，即 `@deepseek-ai/dsh-experimental-agent-team` 中名为 `TeamDuty` 的封闭联合类型。`role` 这个名字已经表示 `lead` 或 `teammate` 权限，因此新概念命名为 `duty`。分工在 `spawn_teammate`、`SpawnTeammateRequest`、持久 `team/member` 快照、roster 视图与 `agentTeam` 投影上都是可选的；没有分工的 teammate 沿用不受限制的规则，因此现有的每份 Team 日志都保持有效。分工记录在第一条 provisioning 记录上，投影会拒绝对它的任何改动。

Team 服务在做出每项决定的操作中执行分工规则。`TeamMembership` 携带来自持久成员记录的分工；任务板以 `TEAM_DUTY_UNAUTHORIZED` 拒绝 executor 的 `create` 与 `verify`、planner 的 `claim`，以及 Lead 把任务重新分配给 planner。planner 可以对无 owner 且处于 pending 的任务执行 `edit`、`set_dependencies` 与 `delete`，因为如果计划的作者不能在执行开始前修订计划，每次修正都得由 Lead 来做。teammate 的 `submit` 会通知 Team 中处于 active 的 planner，由它来验证；没有 active planner 时，通知照旧发给 Lead。

planner 的只读性来自它保留的继承工具，而不是提示词文本。`@deepseek-ai/dsh-experimental-tool-agent-team` 在其 `Config` 中拥有 `duties.<duty>.instructions` 与 `duties.<duty>.tools`；`tools` 取值为 `all` 或允许列表，planner 的默认列表只包含读取工具。创建时，该列表会缩小为 Lead 可见的工具，并作为 `SpawnTeammateRequest.toolFilter` 传入；Team 服务把它转交给 subagent provider，provider 在 child 的创建窗口内用 `tools.restrict()` 应用它，并在每次恢复时根据 child 的 descriptor 重新应用。允许列表在失败时保持关闭：部署日后新增的可写工具，在有人把它列入之前对 planner 保持隐藏。Team 工具是 scoped 注册，因此受限的 planner 仍保留它们。

Lead 通过 `setSubject` 记录主题，它会追加一条仅日志的 `team/subject` 事件；以最新记录为准，主题最多 200 个字符，与任务标题相同。工具包中的 `/team <subject>` 命令记录主题，通过 `sessionTitle.rename` 固定 Session 标题，并把主题作为用户消息 steer 给 Lead。Team 有主题期间，每个成员共享的 `team:policy` 段落末尾都会附上一段说明，写明该主题以及 Lead 执行的先规划后执行流程。`@deepseek-ai/dsh-experimental-client-ui-agent-team` 中的 Web 启动栏从空白 Lead 会话发送同一条命令，Team 面板则在 roster 上方显示该主题。

`/team` 还接受可选的 `--members <planner|executor,...> <subject>` roster。Host 命令会先校验 spec——每个 token 必须是 `planner` 或 `executor`，最多一个 planner——以及请求数量是否符合 `TeamService.remainingCapacity()`，全部通过后才会有任何改动；然后像普通形式一样记录主题；接着按顺序为每个请求的分工调用与 `spawn_teammate` 相同的、经 Lead 授权的 `spawnTeammate` 事务，使用确定性的名字（`planner`，随后是 `executor-1`、`executor-2`……，跳过已被占用的名字）与简短的分工专属启动任务；最后把主题连同一句额外说明 steer 给 Lead，说明谁已启动，以及 Lead 领导他们。若批次中途某次 spawn 失败，批次会停止，并在命令结果中报告部分 roster，而不会像所有人都已加入那样 steer Lead。启动任务与额外的 steer 说明都不携带新的 event 类型：两者都搭载普通主题已经使用的持久 `team/member` 记录与 `user/message` event，因此 Session 格式 4 保持不变。

## 考虑过的替代方案

**用单独的消息承载启动指示。** 已拒绝，因为消息需要 source kind，而在持久消息 source 联合类型中新增变体会改变已定稿的 Session 格式 4，仅为一条命令就得升级格式。若用一条用户消息同时承载主题与指示，指示就会出现在用户自己的气泡中。策略段落让第一条用户消息恰好等于主题，记录在每次请求的 system 消息中，并且对每个成员渲染相同，因此 fork teammate 保留 Lead 的前缀。

**拒绝可写工具，而不是允许读取工具。** 已拒绝，因为拒绝列表在失败时保持开放：`workflow` 会启动拥有完整工具的子代理，`job_kill` 会停止同伴的作业，部署日后新增的任何可写工具也会对 planner 保持可见。Schemastery 还会把省略的数组物化为空数组，因此可选列表会把缺省设置变成“不保留任何工具”；`'all'` 或显式列表让每个物化后的取值都名副其实。

**只通过指示执行分工。** 已拒绝，因为提示词不是执行机制；修改文件的 planner 或验证同伴成果的 executor 都不会被发现。服务检查每个任务操作，工具限制拒绝执行，测试也通过各自真实的操作验证这两种拒绝。

**在 schema 中隐藏被分工拒绝的 Team 工具。** 已拒绝，因为 Team schema 在成员之间保持一致，fork teammate 因而保留 Lead 的前缀；而且省略 schema 并不能阻止直接调用，服务端的拒绝才是执行点。

**由部署定义分工名称。** 已拒绝，因为没有使用方需要第三种分工，而封闭联合类型让服务、投影与面板可以对其做穷尽式判断；部署只配置两种固定分工的指示与工具。

**为启动表单新增 `agentTeams` Remote 方法。** 已拒绝，因为 Host 命令已经能为空白 Session 解析 Lead Agent、记录自身生命周期、通过 `commands/execute` 把处理器错误返回给客户端，并为支持命令的客户端提供同一个入口。

**让 Lead 模型自己 spawn 所请求的 roster。** 已拒绝，因为这会让 Lead 必须在自己的一次或多次 turn 中正确解析 `--members` 得到的 spawn 数量，把 token 和一次模型调用花在一个机械的批处理上，且无法保证顺序、名字，也无法保证 all-or-nothing 的失败报告。命令本身已经能解析 Lead Agent、校验容量，并可以调用与工具相同的 `spawnTeammate`；把批处理留在命令里能让 roster 创建保持确定性且可测试，而不必在小巧的 `remainingCapacity` 查询之外再增加服务方法。

## 测试

`team.spec.ts` 覆盖持久的分工记录、child descriptor 中被转交的限制、与无分工成员及 Lead 并存时的每条分工规则、仅限无 owner 且 pending 任务的计划修订、发给 planner 的提交通知以及唯一 planner 创建失败时回落到 Lead，还覆盖主题的记录、长度上限与仅限 Lead 的权限。`projection-events.spec.ts` 覆盖分工不可变、封闭的分工集合、以最新为准与空主题拒绝、仅主题变化时重新发布的视图，以及严格检查点的往返。`tool-team.spec.ts` 覆盖提醒文本、缩小后的允许列表及其在执行时的拒绝、配置的工具列表与空列表、加载时的指示校验、Lead 与 teammate 共享的主题段落，以及 `/team` 的每种结果。客户端测试覆盖启动栏的可见性规则、单次提交与原位拒绝提示、命令映射，以及面板的主题标题与分工标签。`apps/cli/tests/agent-team-headless.e2e.ts` 通过发布的 headless profile 运行一个 planner 与一个 executor，所用的免密钥适配器一旦发现 planner 看到可写工具就会失败；`apps/web/tests/agent-team-start.e2e.ts` 在组装好的浏览器中通过启动栏启动 Team。

## 后果

先规划后执行的分工成为产品行为，而不是提示词习惯：planner 无法通过继承工具修改文件或接手工作，executor 无法重新定义计划或批准成果，planner 无需 Lead 转交就能收到每次提交。以主题启动的 Team 拥有固定的标题、面板中的标题行，以及恰好等于用户输入内容的第一条消息。

代价是：有主题的 Team 中，每个成员的每次请求都多出约 90 个 token 的主题段落；每个有分工的 teammate 一次性多出约 100 个 token 的分工指示；受限 planner 的工具 schema 以及请求前缀与 Lead 不同。在 Lead 第一次请求之后才记录的主题，会使每个成员的 Team 段落改变一次。`/team` 只存在于组合了命令注册表的地方，因此把任务作为用户消息发送的一次性 headless runner 无法以主题启动 Team。Team 投影检查点布局升到版本 6，持久化记录 `2026-09-26-team-duty-and-subject` 在不改变 Session 格式的前提下确认了可选的 duty 属性与新事件类型。
