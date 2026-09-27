# Agent Note: Subagent 默认子级路由

Status: implemented

[English](2026-09-26-subagent-default-child-route.md) | 中文

## Problem

Web `subagent` 工具的模型选择设置([用户授权的 subagent 模型路由](2026-08-24-user-authorized-subagent-model-routes.zh.md))让用户可以授权一份精确的路由允许列表，但每次没有指定路由的调用仍会继承父 Agent 自己的路由。某个部署希望子级默认运行在更便宜或订阅制的路由上——同时仍允许主 Agent 按任务选择其他已授权路由——却没有办法表达这项默认值，除非把 `tool-subagent` 挂载进 profile patch，而 Web 预设行并不会把它暴露给 Settings。

## Decision

`SubagentModelSelectionConfig` 新增可选的 `defaultModel: { provider, model, reasoningEffort? }`，在每个持久边界都会校验：折叠逻辑总是校验其形状，并且只在设置层的 `enabled` 开关打开时才校验其列表归属；`current()` 同样只在启用时执行这项列表校验，禁用时则完全省略该字段，因此关闭功能后遗留的、已过期或不在列表中的默认值绝不会让 Session 组合失败。持久的 `subagent/model-selection-policy` 事件及其 stateVersion 2 投影会把默认值和路由列表一起携带，因此全新顶层 Session 只采样一次，之后每个子级都继承这份已记录的确切决定，绝不重新采样设置。

路由优先级，从高到低依次为：显式的模型请求；工具自身已配置的 `agentOptions` 路由；已记录的默认值；提供方自有的 `agentRouteDefaults`；父 Agent 的路由。`index.ts` 为每个工具实例计算一次这份"有效默认值"——只有当工具已配置的 `agentOptions` 没有指定路由时，已记录的默认值才会生效——并在模型可见文本、`list_subagent_models` 的标记、`requiresRoutePreflight` 以及传给 `requestedAgentOptions` 的合并逻辑中统一复用这同一个值，使措辞与行为不会出现分歧。提供方自有的 `agentRouteDefaults` 保持其原本独立运作的行为完全不变，仍在 `index.ts` 中合并进工具已配置的选项，但仅在不存在有效默认值时才这样做；`requestedAgentOptions`(`model-selection.ts`)随后只在工具已配置的选项没有指定路由时应用有效默认值，提供 provider/model，并且只要默认值本身命名了推理强度，就无条件使用该强度。只有默认值没有强度时，与路由无关的已配置强度才会保留，而且仅限默认值相对父级没有改变路由的情形——这与显式模型请求那一层早已遵循的"路由改变但未指定强度就清除它"规则相同。仅凭有效默认值本身就会触发 `requiresRoutePreflight`，因此一次既没有请求字段、也没有已配置路由的调用，仍会在子级启动前经由实时 LLM 适配器解析并校验生效路由。

工具描述里的选择语句，以及 `provider`、`model`、`reasoning_effort` 参数描述，会把有效默认值表述为具体效果("Omit `provider` and `model` to run the child on `<provider>/<model>`[ at reasoning effort `<effort>`]"),取代泛泛的"使用已配置的子级默认值"措辞；`list_subagent_models` 也会用 `(default)` 标记默认路由。没有有效默认值时，上述每一段文本都与没有记录默认值的组合逐字节保持一致。对于没有强度的默认值，`reasoning_effort` 的描述会直接陈述两种可能的结果(默认路由与父级相同时继承兼容的父级强度，否则使用所选模型自身的默认值),而不是一个在路由改变时会失真的单一断言。

Plugins 设置卡新增一个默认路由选择项，从当前已勾选的允许路由中挑选，或选择"与调用方 Agent 相同"表示不设默认；还新增一个强度选择项，其来源与路由勾选框已经在读取的实时模型目录相同；取消勾选正是默认值的那条路由会清除该默认值。三个字段作为一次带 revision 栅栏的 mutation 一起保存。

## Alternatives considered

**只在路由未改变时才应用默认值的强度。** 不采用：Host 管理员记录默认值正是因为想要那个确切的行为，而不是隐式依赖父级恰好在跑哪条路由；把默认值的强度视为始终生效，保持了一条可预测的规则，而不是两条只在恰好还存在一个与路由无关的已配置强度时才产生分歧的路径。

**让提供方自有的 `agentRouteDefaults` 排在已记录默认值之前生效。** 不采用：Host 级别的默认值存在的意义正是为了把委派引导离开提供方或父级原本会选择的路由，这也包括提供方自身的静态接线方式(例如 DSH SDK 后端已配置的实例路由)；如果默认值的优先级低于 `agentRouteDefaults`，恰恰会在最可能声明它的那些提供方上悄悄让这项功能失效。因此 `index.ts` 会先计算出有效默认值，再决定是否要把 `agentRouteDefaults` 合并进工具已配置的选项。

**当只有默认值提供路由时跳过预检。** 不采用：Host 记录默认值的意义正是为了触达一个用户从未键入过的路由，跳过校验会让一个陈旧或拼写错误的默认值未经检查就到达 `runtimeCtx.subagents.start()`——而这恰恰是 `preflightChildLlmRoute` 为其他每一种路由来源存在的意义。

## Consequences

- 部署方可以引导默认委派的成本或能力，既不需要主 Agent 在每次调用时都指定路由，也不需要使用 Web 预设无法触达的 profile patch 逃生口。
- 只有在真正记录了有效默认值时，模型可见文本才会改变；每一个没有默认值的既有组合都逐字节不受影响，由 `model-selection.spec.ts` 固定验证。
- `subagentModelSelectionPolicy` 投影的 `stateVersion` 从 1 升到 2：旧单元的持久化缓存行会被丢弃并重新折叠，而不是被当作新的 `{ allowedModels, defaultModel? }` 形状直接前向应用；一个 v1 写入的事件(没有 `defaultModel` 键)仍会折叠为一份没有默认值的策略。
- 单元测试覆盖了完整的优先级矩阵(模型请求、已配置路由、仅已配置强度、有/无强度的默认值、父级)、默认值优先于提供方自有的 `agentRouteDefaults`、已配置的工具路由优先于已记录的默认值、仅凭默认值触发预检、有/无默认值时逐字节固定的模型可见文本、设置与事件校验(格式错误、不在列表中、按启用状态校验列表归属)、深度为二的继承，以及客户端控制器/字段的默认路由与强度暂存。

## Related decisions

路由允许列表、Session 取样与继承、固定的 `list_subagent_models` schema 仍由[用户授权的 subagent 模型路由](2026-08-24-user-authorized-subagent-model-routes.zh.md)负责；路由参数、适配器预检与 fork 缓存限制仍由[模型选择的 subagent 路由](2026-08-18-model-selected-subagent-routes.zh.md)负责。
