# Agent Note: 委派树共享的提供方缓存路由键

Status: implemented

[English](2026-09-27-delegation-tree-cache-key.md) | 中文

## 问题

委派树中的每个会话都把自身会话 id 作为唯一的提供方缓存路由信号发送出去。`dsh-llm-pi-ai` 把该 id 映射到 pi-ai 的会话级路由上（一个逐会话的 WebSocket、`session-id` 请求头，以及 OpenAI 的 `prompt_cache_key`），`dsh-llm-deepseek` 则把它映射到 `x-deepseek-harness-session-id` 请求头。OpenAI 按请求前导字节的哈希加该路由键来命中缓存，因此同一父级的兄弟与 fork 子级——即使共享同一段请求前缀——也从未落在同一条缓存记录上：每个子级的首次请求都要按未命中缓存的全价支付输入成本。DeepSeek 的缓存是账户级全局缓存，不受会话身份影响，因此这项成本只属于 OpenAI 系路由。

## 决策

`GenerateOptions`（`packages/llm/llm/src/types.ts`）新增 `cacheKey?: string`，文档说明其为提供方缓存路由提示：永不对模型可见、永不记录；且是普通字符串而非带品牌的会话 id，因为它是循环如今推导出的路由值，还不是其他代码经会话注册表解析的身份标识（这与 `sessionId` 本身是本地声明的品牌类型而非导入 `dsh-session` 的 `SessionId`——那样会产生循环依赖——出于同一原因）。

`dsh-session` 导出 `delegationTreeRoot(header, lookupHeader)`（`packages/core/session/src/delegation.ts`）：顶层会话（无 `parentSession`）即为其自身根节点；被委派子会话沿 `parentSession` 向上遍历，每一跳调用 `lookupHeader`。遍历在 `lookupHeader` 仍能解析的最远祖先处停止——某祖先无法解析（已结束，或当前进程未加载）时，就把该祖先自身的 id 作为返回的根，即本进程仍能确认的最近祖先——遇到重复 id（谱系出现环；正常创建路径不会产生环，但即便存在，遍历也不会挂起）同样停止。该函数只接受一个表头与一个查找回调，从不接受活跃的父级 `Agent`，因此冷恢复的子会话与活跃兄弟一样，仅凭自身持久化的表头谱系即可算出其根——而非依据进程内的活跃状态。`dsh-agent-loop`（`agent.ts`）与 `dsh-compaction-basic`（`summarizer.ts`）都在每个请求上于 `sessionId` 旁标注 `cacheKey: String(delegationTreeRoot(session.header, id => ctx.sessions.get(id)?.header))`；`ctx.sessions` 是进程内的活跃会话注册表，因此该查找只能看到当前进程已加载的会话——它不是一次持久化存储读取，因此若两次调用之间某祖先的活跃状态发生变化，同一会话解析出的根也可能不同（见"影响"）。`summarizeWithLlm`（`summarizer.ts:146-162`）发送的是 `[...input.messages, COMPACTION_INSTRUCTION]`——即该会话自身回放出的对话前缀（含其 `toolHistory` 与 `tools`）外加一条追加的用户消息——因此它必须携带该会话自身的 `cacheKey`，才能落在与该会话普通请求相同的已缓存前缀上（PR #10 就是靠这一复用测得 3200 个已缓存 token）。会话标题生成仍只使用 `sessionId`，且刻意不标注该字段：其请求是固定指令加上该会话自身消息的 JSON 封装转储，是与对话完全无关的结构，不与任何内容共享前缀，共享键在此无前缀可路由。

`dsh-llm-pi-ai`（`adapter.ts`）导出 `sharesPromptCacheKey(model)`、`overridePromptCacheKey(cacheKey)` 与 `resolveCacheKeyOverride(options)`。`sharesPromptCacheKey` 只依据 pi-ai 自身的 `openai` 与 `openai-codex` *提供方 id* 判定，绝不依据解析出的路由主机：pi-ai 真实的 `openai-codex` 提供方（ChatGPT/Codex 登录路由）解析到的是 `chatgpt.com/backend-api`，而非 `api.openai.com`，因此主机判定会悄悄排除本功能的主要目标路由。`overridePromptCacheKey` 构建 pi-ai 的 `onPayload` 钩子，`streamWithSnapshot` 只在 `resolveCacheKeyOverride` 找到与本请求自身 `sessionId` 不同的 `cacheKey` 时才安装它；该钩子仅在请求体已经带有一个已定义的 `prompt_cache_key` 时才替换它。这条“只替换、绝不新增”的规则，使得同一个钩子无需重新推导 pi-ai 不同 API 模块各自的内部判断即可保持正确：`openai-completions` 在其解析主机不是 OpenAI 平台 API 时省略该字段，`openai-responses` 与 `openai-codex-responses` 仅在 `cacheRetention: 'none'` 时省略它，本钩子服从 pi-ai 已经做出的那个判断。在 pi-ai 0.85.1 的 `dist/api/openai-codex-responses.js` 中，该钩子作用于 `body`（第 171-175 行），发生在其 SSE 与 WebSocket 两种传输共用的那一次 `JSON.stringify(body)`（第 179 行）之前，因此覆盖结果在结构上会到达任一传输方式；WebSocket 请求 id 与 `session-id` 请求头则始终使用 `codexSessionId`（本请求自身的会话 id），不受该钩子影响。`sessionId` 本身在所有场合都不受影响：pi-ai 自身的逐会话 WebSocket 路由与 `session-id` 请求头继续使用请求自身的 id，因此连续性与回放区分不受影响。`dsh-llm-deepseek` 完全忽略 `cacheKey`；DeepSeek 的缓存是账户级全局缓存，没有会话范围的路由可言。

## 备选方案

**让 `sharesPromptCacheKey` 依据解析出的路由主机判定。** 早期实现额外要求 `model.baseUrl.includes('api.openai.com')`。对照 pi-ai 真实的提供方表核实后予以否决：`openai-codex`（ChatGPT 登录，正是最初测量的目标）解析到的是 `chatgpt.com/backend-api`，因此主机判定恰好使覆盖机制在它本应生效的那条路由上失效。提供方 id 才是 pi-ai 自身目录按路由固定下来的东西；主机不是。

**把子级自身的 `sessionId`直接设为委派树的根，而不新增 `cacheKey`。** 这样无需新增字段，但 `sessionId` 同时也是 pi-ai 的逐会话 WebSocket 键、其 `session-id` 请求头、DeepSeek 的会话请求头，以及循环自身的回放游标区分依据；把树中每个子级都折叠到同一个 `sessionId` 上，会把这些互不相关的路由与回放关切与缓存路由一并合并。

**在祖先无法解析或谱系出现环时失败报错。** `delegationTreeRoot` 是在请求组装的热路径上被调用的，其设计定位是路由提示而非事关正确性的身份标识。在此处硬失败会把一项缓存优化变成一次服务中断；回退到最近的已知祖先（环的情形则回退到起点 id）能让每个请求始终可路由。

**从活跃的父级 `Agent` 对象推导根节点。** 循环在组装请求那一刻只掌握当前会话自身的表头以及活跃会话注册表；一个被恢复的子会话的父会话完全可能并未在本进程中运行。正是遍历持久化的表头谱系并借助注册表查找，才让冷恢复的子会话能算出与其活跃兄弟完全相同的根。

## 影响

- 同一委派树中的兄弟与 fork 子级，在 `openai`／`openai-codex` 路由上会路由到同一个提供方侧已缓存前缀，而不是各自以自身会话 id 各起一份；DeepSeek 及其他一切路由不受影响。
- `cacheKey` 仅凭一个表头加一个查找函数即可推导与测试（`packages/core/session/tests/delegation.spec.ts`），不依赖活跃的父级 `Agent` 对象——但循环仍是逐请求地从进程内活跃会话注册表重新计算它，而非从持久化存储读取。只要每个祖先都保持活跃，整棵树就解析到同一个根 id；一旦某个中间祖先不再活跃（已释放，或冷恢复后尚未加载），遍历就会退回到它仍能确认的最近祖先 id。因此同一会话自身前后两次请求解析出的键可能不同，冷恢复的子会话也可能与同一棵树中活跃的兄弟落在不同的键上。
- 本功能证明的是自身组装出的请求选项以及由此产生的 pi-ai 请求体，而非提供方一侧的缓存命中；提供方侧行为仍在这些测试所能观测的范围之外，这与 [fork 子级保持一次性 Agent Note](../architecture/2026-08-10-fork-children-stay-one-shot.zh.md) 中同类的已接受风险一致。
- 谱系损坏或出现环时会退化为最近的已知祖先（或起点 id），而不是使请求失败；这是把缓存路由提示当作提示、而非硬性不变量的既定取舍。
