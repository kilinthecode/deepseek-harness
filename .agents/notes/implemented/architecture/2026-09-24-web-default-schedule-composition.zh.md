# Agent Note: 默认 Web 组合中的 Schedule

Status: implemented

[English](2026-09-24-web-default-schedule-composition.md) | 中文

## Problem

自动化任务页面、Session 提醒目录以及 `schedule_*` 工具此前只能通过 `--patch apps/cli/config/examples/schedule/cordis.yml` 进入某个 Web 部署：`packages/bundle/web-app/cordis.patch.yml` 里的 `ui-schedule` 客户端行带 `disabled: true`，而宿主行 `time-context` 与 `schedule` 只存在于那个 overlay 中。因此运行发布版 `web` profile 的人既看不到自动化任务入口，也拿不到提醒工具；同时每个需要它们的消费者都要重复同样的三行：仓库预览镜像自行维护了一份 overlay 列表，两个 Web 测试套件各自硬编码了 overlay 路径。

## Decision

`packages/bundle/web-app/cordis.patch.yml` 在其宿主行列表中插入 `schedule`，并让 `ui-schedule` 保持启用。因此 `web` profile 会交付自动化任务页面、Session 页头的提醒时钟、空闲 Session 行的时钟标记与悬停列表，以及右侧栏任务页签。`standard`、`cordis` 和 `ptc` preset 声明 `@deepseek-ai/dsh-tool-schedule` 与 `@deepseek-ai/dsh-time-context`；`minimal` 两者都不声明。[按 preset 提供工具](2026-09-24-preset-scoped-schedule-tools.zh.md)与[按 preset 提供时钟](2026-09-24-preset-scoped-time-context.zh.md)决策负责该归属。`packages/bundle/web-app/package.json` 声明服务、工具及时钟包，供裸包名解析使用。

`apps/cli/config/examples/schedule/cordis.yml` 已删除。`applyEntryPatches` 追加 `insert` 列表时不对 id 去重，保留该 overlay 会再次挂载 `schedule`，并增加一条覆盖整个 profile 的 `time-context` 行；原本引用它的两个 Web 测试套件与预览打包器现在只组合发布版 profile。

`time-context` 随 Schedule 一起发布，因为提醒请求本身给出的是墙上时钟目标。该插件在符合条件的步骤按配置的最小间隔追加一条持久 user 消息，包含采样瞬时、附加到当前开放请求的浏览器时区，以及自前一条模型可见消息以来的经过时长。正是采样瞬时让模型能把「明天九点」这类请求落成带偏移量的 `at` 值；该解释边界及其要求的显式时区由 [Schedule 子系统](../../../../docs/subsystems/schedule.zh.md)负责。

本决策让 Schedule 保持在发布版 Web 组合中。任务存储、激活、投递与投递记录仍由[宿主定时消息决策](2026-09-16-host-schedule-storage.zh.md)负责；preset 归属决策细化哪些 Agent 会收到工具与时钟读数。

## Recorded sessions

使用包含 `time-context` 的 preset 的 Web 场景按配置的最小间隔记录读数；其已提交的 Session 夹具与页头 sidecar 记录这些消息。一条读数中的采样瞬时、浏览器时区与经过时长是易变值，`apps/web/tests/scaffold.ts` 的 `normalizeWebSessionVolatiles` 会把它们替换为 `{{timeContextTimestamp}}`、`{{clientTimeZone}}` 和 `{{elapsed}}`。turn 与 step 序号以及"前一条事件"的基线保持可读，因此夹具仍能显示模型收到的内容。重刷会在已保留的上一代旁写入当前 writer 代次（`session.v4.jsonl`），旧代次继续作为已提交的回放基线保留。

## Alternatives considered

**保留 overlay，不做任何改动。** 发布版界面会继续与描述该自动化任务入口的产品文档相矛盾，而每个消费者都要各自保留那三行的副本。overlay 也无法满足「默认 `dsh web` 进程不带 flag 就暴露该页面」这一要求。

**只发布 Schedule 两行，不带 `time-context`。** 模型将没有自己的采样瞬时，于是提醒请求中未明确限定时区的日期或时间要依赖另一个时钟来源；overlay 当初正是为此把两行配对。

**另建一个可选 bundle。** `OPTIONAL_BUNDLES` 面向的是用户在插件管理器里主动开启的 bundle，与 overlay 是同一种 opt-in 形态；本决策要的是默认 Web 界面自己拥有该页面与这些工具。

## Consequences

- `standard`、`cordis` 与 `ptc` 请求头携带四个提醒工具 schema，其符合条件的步骤按配置的最小间隔追加持久时钟读数。使用这些 preset 的对话即使从不创建提醒也承担这份 token 成本；`minimal` 不承担这两项成本。
- 时钟读数对模型可见且持久，因此它与其他 user 消息一样参与回放、压缩，并出现在导出的 Session 日志中。
- 部署在自己的 profile patch 中通过 `schedule` 与 `ui-schedule` 两行禁用宿主服务和客户端页面。移除或改配时钟及模型工具需要编辑对应 preset 的 `config.plugins`，因为这些声明不属于覆盖整个 profile 的行。
- 完整预设表的 `cordis_inspect_query` `listTools` 答案现在超过基础组合配置的内联预算，因此 spill 策略改为保留该答案的首尾并给出 spill 路径，而不是完整 JSON。
- 仓库预览镜像与两个 Web 测试套件都不再传 overlay 参数，一处组合改动即同时作用于所有界面。
