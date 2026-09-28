# Agent Note: 委派树共享的提供方缓存路由键

Status: implemented

[English](2026-09-27-delegation-tree-cache-key.md) | 中文

## 问题

委派树中的每个会话都把自身会话 id 作为唯一的提供方缓存路由信号发送出去。`dsh-llm-pi-ai` 把该 id 映射到 pi-ai 的会话级路由上（一个逐会话的 WebSocket、`session-id` 请求头，以及 OpenAI 的 `prompt_cache_key`），`dsh-llm-deepseek` 则把它映射到 `x-deepseek-harness-session-id` 请求头。OpenAI 按请求前导字节的哈希加该路由键来命中缓存，因此同一父级的兄弟与 fork 子级——即使共享同一段请求前缀——也从未落在同一条缓存记录上：每个子级的首次请求都要按未命中缓存的全价支付输入成本。DeepSeek 的缓存是账户级全局缓存，不受会话身份影响，因此这项成本只属于 OpenAI 系路由。

## 决策

`GenerateOptions`（`packages/llm/llm/src/types.ts`）新增 `cacheKey?: Branded<'SessionId'>`——与 `sessionId` 已经使用的同一个本地声明品牌类型，因为导入 `dsh-session` 的 `SessionId` 会造成循环依赖——文档说明其为本请求所共享的提供方侧已缓存前缀所属的会话 id。它是传输层元数据，永不对模型可见，因此会话日志不会记录它：`request/header` 事件只携带 `config`、`adapterDefaults`、`tools`。循环会为每个请求重新计算 `cacheKey`，而不是从日志中读回它。

`dsh-session` 导出 `delegationTreeRoot(header, lookupHeader)`（`packages/core/session/src/delegation.ts`）：遍历沿 `parentSession` 向上，经过 `lookupHeader` 能解析的表头，并返回第一个表头无法解析的祖先的 id（已结束，或当前进程未加载——该 id 由最后一个可解析表头自身的 `parentSession` 字段得知，即便这个祖先自身的表头无法加载）；若一路向上每个表头都能解析，则返回顶层祖先自身的 id。因此已释放的根仍能作为整棵树的键，因为它的子级早已知道它的 id；而一个未加载的中间祖先则只能作为其自身子树的键，因为遍历无法看到它之外的部分。该函数只接受一个表头与一个查找回调，从不接受活跃的父级 `Agent`，因此除了 `lookupHeader` 自身查询的内容之外，它不依赖任何进程内活跃状态。`dsh-agent-loop`（`agent.ts`）与 `dsh-compaction-basic`（`summarizer.ts`）都在每个请求上于 `sessionId` 旁标注 `cacheKey: delegationTreeRoot(session.header, id => ctx.sessions.get(id)?.header)`；`ctx.sessions` 是进程内的活跃会话注册表，因此这一具体查找只能看到当前进程已加载的会话，若两次调用之间某祖先的活跃状态发生变化，同一会话解析出的根也可能不同（见"影响"）。`summarizeWithLlm`（`summarizer.ts:146-162`）发送的是 `[...input.messages, COMPACTION_INSTRUCTION]`——即该会话自身回放出的对话前缀（含其 `toolHistory` 与 `tools`）外加一条追加的用户消息——因此它必须携带该会话自身的 `cacheKey`，才能落在与该会话普通请求相同的已缓存前缀上（PR #10 就是靠这一复用测得 3200 个已缓存 token）。会话标题生成仍只使用 `sessionId`，且刻意不标注该字段：其请求是固定指令加上该会话自身消息的 JSON 封装转储，是与对话完全无关的结构，不与任何内容共享前缀，共享键在此无前缀可路由。

`dsh-llm-pi-ai`（`adapter.ts`）导出 `sharesPromptCacheKey(model)`、`overridePromptCacheKey(cacheKey)` 与 `resolveCacheKeyOverride(options)`。`sharesPromptCacheKey` 只依据 pi-ai 自身的 `openai` 与 `openai-codex` *提供方 id* 判定，绝不依据解析出的路由主机：pi-ai 真实的 `openai-codex` 提供方（ChatGPT/Codex 登录路由）解析到的是 `chatgpt.com/backend-api`，而非 `api.openai.com`，因此主机判定会悄悄排除本功能的主要目标路由。`overridePromptCacheKey` 构建 pi-ai 的 `onPayload` 钩子，`streamWithSnapshot` 只在 `resolveCacheKeyOverride` 找到与本请求自身 `sessionId` 不同的 `cacheKey` 时才安装它；该钩子仅在请求体已经带有一个已定义的 `prompt_cache_key` 时才替换它。这条”只替换、绝不新增”的规则，使得同一个钩子无需重新推导 pi-ai 不同 API 模块各自的内部判断即可保持正确：`cacheRetention: 'none'` 会让每个模块都省略该字段（`dist/api/openai-completions.js`、`openai-responses.js` 与 `openai-codex-responses.js` 各自独立读取该值），`openai-completions` 在此之外还会在其解析主机不是 OpenAI 平台 API 时额外省略该字段，本钩子服从 pi-ai 已经做出的那个判断。在 pi-ai 0.85.1 的 `dist/api/openai-codex-responses.js` 中，该钩子作用于 `body`（第 171-175 行），发生在其 SSE 与 WebSocket 两种传输共用的那一次 `JSON.stringify(body)`（第 179 行）之前，因此覆盖结果在结构上会到达任一传输方式；WebSocket 请求 id 与 `session-id` 请求头则始终使用 `codexSessionId`（本请求自身的会话 id），不受该钩子影响。`sessionId` 本身在所有场合都不受影响：pi-ai 自身的逐会话 WebSocket 路由与 `session-id` 请求头继续使用请求自身的 id，因此连续性与回放区分不受影响。`dsh-llm-deepseek` 完全忽略 `cacheKey`；DeepSeek 的缓存是账户级全局缓存，没有会话范围的路由可言。

## 备选方案

**让 `sharesPromptCacheKey` 依据解析出的路由主机判定。** 早期实现额外要求 `model.baseUrl.includes('api.openai.com')`。对照 pi-ai 真实的提供方表核实后予以否决：`openai-codex`（ChatGPT 登录，正是最初测量的目标）解析到的是 `chatgpt.com/backend-api`，因此主机判定恰好使覆盖机制在它本应生效的那条路由上失效。提供方 id 才是 pi-ai 自身目录按路由固定下来的东西；主机不是。

**把子级自身的 `sessionId`直接设为委派树的根，而不新增 `cacheKey`。** 这样无需新增字段，但 `sessionId` 同时也是 pi-ai 的逐会话 WebSocket 键、其 `session-id` 请求头、DeepSeek 的会话请求头，以及循环自身的回放游标区分依据；把树中每个子级都折叠到同一个 `sessionId` 上，会把这些互不相关的路由与回放关切与缓存路由一并合并。

**在祖先无法解析或谱系出现环时失败报错。** `delegationTreeRoot` 是在请求组装的热路径上被调用的，其设计定位是路由提示而非事关正确性的身份标识。在此处硬失败会把一项缓存优化变成一次服务中断；回退到最近的已知祖先（环的情形则回退到遍历第二次到达的第一个祖先 id）能让每个请求始终可路由。

**从活跃的父级 `Agent` 对象推导根节点。** 循环在组装请求那一刻只掌握当前会话自身的表头以及活跃会话注册表；一个被恢复的子会话的父会话完全可能并未在本进程中运行。`delegationTreeRoot` 本身接受的是表头与查找回调，因此无论调用方的查找恰好能否找到某个祖先处于活跃状态，它的行为方式都相同，完全不需要活跃的父级引用。

## 影响

- 同一委派树中的兄弟与 fork 子级，在 `openai`／`openai-codex` 路由上会路由到同一个提供方侧已缓存前缀，而不是各自以自身会话 id 各起一份；DeepSeek 及其他一切路由不受影响。
- `cacheKey` 仅凭一个表头加一个查找函数即可推导与测试（`packages/core/session/tests/delegation.spec.ts`），不依赖活跃的父级 `Agent` 对象——但循环仍是逐请求地从进程内活跃会话注册表重新计算它，而非从持久化存储读取。只要每个祖先都保持活跃，整棵树就解析到同一个根 id；一旦某个中间祖先不再活跃（已释放，或冷恢复后尚未加载），遍历就会退回到它仍能确认的最近祖先 id。因此同一会话自身前后两次请求解析出的键可能不同，冷恢复的子会话也可能与同一棵树中活跃的兄弟落在不同的键上。
- 本功能证明的是自身组装出的请求选项以及由此产生的 pi-ai 请求体，而非提供方一侧的缓存命中；提供方侧行为仍在这些测试所能观测的范围之外，这与 [fork 子级保持一次性 Agent Note](../architecture/2026-08-10-fork-children-stay-one-shot.zh.md) 中同类的已接受风险一致。
- 谱系损坏或出现环时会退化为最近的已知祖先（环的情形则为遍历第二次到达的第一个祖先 id），而不是使请求失败；这是把缓存路由提示当作提示、而非硬性不变量的既定取舍。
