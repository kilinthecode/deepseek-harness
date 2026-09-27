# Agent Note: Subagent 默认子级路由

Status: implemented

[English](2026-09-26-subagent-default-child-route.md) | 中文

## Problem

Web `subagent` 工具的模型选择设置([用户授权的 subagent 模型路由](2026-08-24-user-authorized-subagent-model-routes.zh.md))让用户可以授权一份精确的路由允许列表，但每次没有指定路由的调用仍会继承父 Agent 自己的路由。某个部署希望子级默认运行在更便宜或订阅制的路由上——同时仍允许主 Agent 按任务选择其他已授权路由——却没有办法表达这项默认值，除非把 `tool-subagent` 挂载进 profile patch，而 Web 预设行并不会把它暴露给 Settings。

## Decision

`SubagentModelSelectionConfig` 新增可选的 `defaultModel: { provider, model, reasoningEffort? }`，在每个持久边界(设置读取、事件折叠)都会针对 `allowedModels` 校验。持久的 `subagent/model-selection-policy` 事件及其 stateVersion 2 投影会把默认值和路由列表一起携带，因此全新顶层 Session 只采样一次，之后每个子级都继承这份已记录的确切决定，绝不重新采样设置。

`requestedAgentOptions`(`model-selection.ts`)把默认值作为一层，严格加在工具已配置的 `agentOptions`(包括先合并进来的提供方自有 `agentRouteDefaults`)之下、父级之上：已配置的路由直接获胜；否则默认值提供 provider/model，并且只要默认值本身命名了推理强度，就无条件使用该强度——因为 Host 记录的默认值是一次刻意、具体的选择，会覆盖此功能出现之前遗留下来的、与路由无关的已配置强度。只有默认值没有强度时，与路由无关的已配置强度才会保留，而且仅限默认值相对父级没有改变路由的情形——这与显式模型请求那一层早已遵循的"路由改变但未指定强度就清除它"规则相同。仅凭默认值本身就会触发 `requiresRoutePreflight`，因此一次既没有请求字段、也没有已配置路由的调用，仍会在子级启动前经由实时 LLM 适配器解析并校验生效路由。

工具描述里的选择语句，以及 `provider`、`model`、`reasoning_effort` 参数描述，会把已记录的默认值表述为具体效果("Omit `provider` and `model` to run the child on `<provider>/<model>`[ at reasoning effort `<effort>`]"),取代泛泛的"使用已配置的子级默认值"措辞；`list_subagent_models` 也会用 `(default)` 标记默认路由。没有已记录默认值时，上述每一段文本都与此功能之前逐字节保持一致。

Plugins 设置卡新增一个默认路由选择项，从当前已勾选的允许路由中挑选，或选择"与调用方 Agent 相同"表示不设默认；还新增一个强度选择项，其来源与路由勾选框已经在读取的实时模型目录相同；取消勾选正是默认值的那条路由会清除该默认值。三个字段作为一次带 revision 栅栏的 mutation 一起保存。

## Alternatives considered

**只在路由未改变时才应用默认值的强度。** 不采用：Host 管理员记录默认值正是因为想要那个确切的行为，而不是隐式依赖父级恰好在跑哪条路由；把默认值的强度视为始终生效，保持了一条可预测的规则，而不是两条只在恰好还存在一个与路由无关的已配置强度时才产生分歧的路径。

**让默认值排在提供方自有的 `agentRouteDefaults` 之前生效。** 不采用：声明自有路由默认值的提供方已经承诺了一种具体的进程内接线方式(例如 DSH SDK 后端已配置的实例路由)；Host 级别的用户偏好不应覆盖提供方自身断言的能力，而且 `index.ts` 中既有的已配置选项合并逻辑早已把 `agentRouteDefaults` 当作"已配置"的一部分，因此无需额外的优先级代码。

**当只有默认值提供路由时跳过预检。** 不采用：Host 记录默认值的意义正是为了触达一个用户从未键入过的路由，跳过校验会让一个陈旧或拼写错误的默认值未经检查就到达 `runtimeCtx.subagents.start()`——而这恰恰是 `preflightChildLlmRoute` 为其他每一种路由来源存在的意义。

## Consequences

- 部署方可以引导默认委派的成本或能力，既不需要主 Agent 在每次调用时都指定路由，也不需要使用 Web 预设无法触达的 profile patch 逃生口。
- 只有在真正记录了默认值时，模型可见文本才会改变；每一个没有默认值的既有组合都逐字节不受影响，由 `model-selection.spec.ts` 固定验证。
- `subagentModelSelectionPolicy` 投影的 `stateVersion` 从 1 升到 2：旧单元的持久化缓存行会被丢弃并重新折叠，而不是被当作新的 `{ allowedModels, defaultModel? }` 形状直接前向应用；一个 v1 写入的事件(没有 `defaultModel` 键)仍会折叠为一份没有默认值的策略。
- 单元测试覆盖了完整的优先级矩阵(模型请求、已配置路由、仅已配置强度、有/无强度的默认值、父级)、仅凭默认值触发预检、有/无默认值时逐字节固定的模型可见文本、设置与事件校验(格式错误、不在列表中)、深度为二的继承，以及客户端控制器/字段的默认路由与强度暂存。

## Related decisions

路由允许列表、Session 取样与继承、固定的 `list_subagent_models` schema 仍由[用户授权的 subagent 模型路由](2026-08-24-user-authorized-subagent-model-routes.zh.md)负责；路由参数、适配器预检与 fork 缓存限制仍由[模型选择的 subagent 路由](2026-08-18-model-selected-subagent-routes.zh.md)负责。
