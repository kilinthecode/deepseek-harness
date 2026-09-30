---
description: "Priced per-route usage rollups over the durable session index, so token and cost comparisons between time windows come from recorded sessions instead of log replay."
kind: "package-library"
---

# @deepseek-ai/dsh-usage-cost

English | [中文](README.zh.md)

## Summary

This library prices recorded model usage into token and cost totals for any time window of sessions. The rollup reads the durable session index rows that `@deepseek-ai/dsh-token-meter` already folds, so a before/after comparison never replays session logs. A caller brings a validated per-route price table and gets whole-window tokens, per-route costs, and coverage counts back. Prices stay with the caller because provider rates change outside this repository.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Reach for this package in measurement scripts and cost reports that compare recorded sessions across time windows, such as judging a compaction-threshold change. A consumer loads projection records from the durable session index and prices them here. Read session logs directly only when a question needs per-request evidence the index does not fold.

### Entry point

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

Success returns the window's token buckets, one priced rollup per route in key order, and the `sessions` and `pricedSessions` coverage counts. `parseUsageCostRates` throws on a malformed entry, and `rollupUsageCost` throws when the window carries usage for a route the table does not price, so a misconfigured price table fails instead of producing an undercounted report.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The rollup is a pure function over `UsageIndexRecord` values: projection-cache rows carrying `tokenUsage` whole-session totals and `usageByRoute` per-route buckets, both folded from the durable log by token-meter. A record belongs to a window when its `identity.createdAt` falls inside the half-open interval. Pricing multiplies each token bucket against its per-million-token rate and rounds each product to whole micros, so every priced sum stays an integer.

| Source | Role |
| --- | --- |
| `src/rollup.ts` | Rate-table validation, bucket pricing, and the window rollup. |
| `src/types.ts` | Durable record shape and priced result types. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [token-meter](../token-meter/README.md) owns the projection units that record usage into the durable index.
- [session-projection-cache](../../session/session-projection-cache/README.md) owns the records the rollup reads and the cold reads that fold new units.
- [compaction-basic](../../compaction/compaction-basic/README.md) owns the compaction gates these figures help evaluate.

-----

<a id="model-experience"></a>
## Model Experience

None, as the usage-cost rollup prices already-logged usage for callers and registers nothing model-facing.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Windows attribute whole sessions by creation time: a session that spans a window boundary belongs entirely to the window that created it.
- Per-route cost covers only sessions the `usageByRoute` unit has folded; `pricedSessions` reports that share, and earlier sessions contribute `tokenUsage` totals without route cost.
- The package ships no prices; each caller supplies its rate table.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
