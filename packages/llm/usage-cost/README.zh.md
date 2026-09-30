---
description: "基于持久会话索引的分路由用量成本汇总，让时间窗口间的用量与成本对比来自已记录的会话而非日志重放。"
kind: "package-library"
---

# @deepseek-ai/dsh-usage-cost

[English](README.md) | 中文

## 概述

这个库把已记录的模型用量计价为任意会话时间窗口的用量与成本合计。汇总读取 `@deepseek-ai/dsh-token-meter` 已经折叠进持久会话索引的行，因此前后对比无需重放会话日志。调用方带来一份经校验的分路由价格表，并得到整窗口用量、分路由成本与覆盖计数。价格由调用方持有，因为供应商费率的变化发生在本仓库之外。

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

### 何时选择

在需要按时间窗口对比已记录会话的度量脚本与成本报告中使用，例如评估一次压缩阈值变更。调用方从持久会话索引加载投影记录，再在此计价。只有当问题需要索引没有折叠的逐请求证据时，才直接读取会话日志。

### 入口

```ts
import { parseUsageCostRates, rollupUsageCost } from '@deepseek-ai/dsh-usage-cost'
import type { UsageIndexRecord } from '@deepseek-ai/dsh-usage-cost'

const rates = parseUsageCostRates({
  'deepseek-official/deepseek-flash': {
    inputMicros: 300,
    cacheReadMicros: 30,
    cacheWriteMicros: 600,
    outputMicros: 1_200,
  },
})

// Records come from the durable session index; see Further Exploration.
declare const records: Iterable<UsageIndexRecord>

const rollup = rollupUsageCost(records, { from: Date.UTC(2026, 8, 21), to: Date.UTC(2026, 8, 26) }, rates)
```

成功时返回窗口的用量桶、按路由键顺序排列的分路由计价汇总，以及 `sessions` 与 `pricedSessions` 覆盖计数。`parseUsageCostRates` 遇到畸形条目即抛错；`rollupUsageCost` 在窗口含有价格表未计价路由的用量时抛错，使错误配置的价格表立即失败，而不是产出被低估的报告。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

汇总是对 `UsageIndexRecord` 值的纯函数：这些投影缓存行带有 `tokenUsage` 全会话合计与 `usageByRoute` 分路由桶，两者都由 token-meter 从持久日志折叠而来。当记录的 `identity.createdAt` 落在半开区间内时，它属于该窗口。计价把每个用量桶乘以其每百万词元费率，并把每项乘积取整到整微，使每个计价合计保持整数。

| Source | Role |
| --- | --- |
| `src/rollup.ts` | 价格表校验、用量桶计价与窗口汇总。 |
| `src/types.ts` | 持久记录结构与计价结果类型。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [token-meter](../token-meter/README.zh.md) 拥有把用量记录进持久索引的投影单元。
- [session-projection-cache](../../session/session-projection-cache/README.zh.md) 拥有汇总读取的记录与折叠新单元的冷读取。
- [compaction-basic](../../compaction/compaction-basic/README.zh.md) 拥有这些数字帮助评估的压缩闸门。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 usage-cost 汇总为调用方计价已写入日志的用量，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 窗口按创建时间归属整段会话：跨越窗口边界的会话完全属于创建它的那个窗口。
- 分路由成本只覆盖 `usageByRoute` 单元折叠过的会话；`pricedSessions` 报告该占比，更早的会话只贡献 `tokenUsage` 合计而不贡献路由成本。
- 这个包不内置价格；每个调用方提供自己的价格表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
