/**
 * Priced usage rollups over the durable session index: whole-session token
 * totals from the `tokenUsage` unit, per-route priced cost from the
 * `usageByRoute` unit, and the validated rate table both are priced with.
 * The rollup is pure — it reads records a caller already loaded from the
 * projection cache and never consults session logs.
 *
 * @module @deepseek-ai/dsh-usage-cost/rollup
 */

import { z } from 'zod'
import { UNATTRIBUTED_ROUTE } from '@deepseek-ai/dsh-token-meter'
import type {
  UsageCostBuckets,
  UsageCostRates,
  UsageCostRollup,
  UsageCostRouteRollup,
  UsageIndexRecord,
  UsageWindow,
} from './types.ts'

/**
 * Per-million-token prices keyed by the per-route unit's route key:
 * `provider/model` for routed usage, {@link UNATTRIBUTED_ROUTE} for samples
 * that arrived before any request header.
 */
export type UsageCostRatesTable = Record<string, UsageCostRates>

const ratesSchema = z.object({
  inputMicros: z.number().int().min(0),
  cacheReadMicros: z.number().int().min(0),
  cacheWriteMicros: z.number().int().min(0),
  outputMicros: z.number().int().min(0),
}).strict()

/**
 * Validated rate table: every price is a non-negative integer micro count.
 * Route-key form is checked by {@link parseUsageCostRates}.
 */
export const usageCostRatesSchema: z.ZodType<UsageCostRatesTable> = z.record(
  z.string().min(1),
  ratesSchema,
)

/**
 * Validate an untrusted rate table (a deployment config file, a CLI input).
 * @param value - untrusted rates value to parse.
 * @returns the validated table.
 * @throws Error naming the malformed entry; a table the schema refuses is a
 * misconfiguration and must fail loud at the boundary.
 */
export function parseUsageCostRates(value: unknown): UsageCostRatesTable {
  const parsed = usageCostRatesSchema.parse(value)
  for (const route of Object.keys(parsed)) {
    if (route !== UNATTRIBUTED_ROUTE && !route.includes('/')) {
      throw new Error(`usage-cost: rates key "${route}" is neither a provider/model route key nor "${UNATTRIBUTED_ROUTE}"`)
    }
  }
  return parsed
}

/**
 * Price one route's token buckets at one rate set.
 * Each bucket rounds to whole micros; the sum stays an exact integer.
 * @param tokens - token buckets to price.
 * @param rates - per-million-token micro prices.
 * @returns the price in micros.
 */
export function priceUsage(tokens: UsageCostBuckets, rates: UsageCostRates): number {
  return Math.round(tokens.uncachedInputTokens * rates.inputMicros / 1_000_000)
    + Math.round(tokens.cacheReadTokens * rates.cacheReadMicros / 1_000_000)
    + Math.round(tokens.cacheWriteTokens * rates.cacheWriteMicros / 1_000_000)
    + Math.round(tokens.outputTokens * rates.outputMicros / 1_000_000)
}

const zeroBuckets = (): UsageCostBuckets => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const addBuckets = (sum: UsageCostBuckets, next: UsageCostBuckets): UsageCostBuckets => ({
  uncachedInputTokens: sum.uncachedInputTokens + next.uncachedInputTokens,
  outputTokens: sum.outputTokens + next.outputTokens,
  cacheReadTokens: sum.cacheReadTokens + next.cacheReadTokens,
  cacheWriteTokens: sum.cacheWriteTokens + next.cacheWriteTokens,
})

/** Whether these buckets carry anything a provider can bill. */
const hasBillableTokens = (buckets: UsageCostBuckets): boolean =>
  buckets.uncachedInputTokens > 0
  || buckets.outputTokens > 0
  || buckets.cacheReadTokens > 0
  || buckets.cacheWriteTokens > 0

/**
 * Roll one window of durable session-index records into priced usage.
 *
 * Whole-session totals come from `tokenUsage`, so every covered record
 * contributes tokens even when the per-route unit has not folded it; per-route
 * cost comes from `usageByRoute`, and {@link UsageCostRollup.pricedSessions}
 * reports how many covered records that unit reached. A route whose window
 * buckets are all zero — a same-step resample leaves its former route at zero —
 * needs no price and takes no rollup line, so a price table has to cover only
 * the routes the window actually billed.
 *
 * @param records - session-index records to cover.
 * @param window - half-open window over `identity.createdAt`.
 * @param rates - per-route price table.
 * @returns the priced rollup for the window.
 * @throws Error naming a route that billed usage the rate table does not price.
 */
export function rollupUsageCost(
  records: Iterable<UsageIndexRecord>,
  window: UsageWindow,
  rates: UsageCostRatesTable,
): UsageCostRollup {
  const tokens = zeroBuckets()
  const routeTokens = new Map<string, UsageCostBuckets>()
  let sessions = 0
  let pricedSessions = 0

  for (const record of records) {
    const { createdAt } = record.identity
    if (createdAt < window.from || createdAt >= window.to) continue
    sessions += 1
    const totals = record.rows.tokenUsage?.val.totals
    if (totals !== undefined) {
      Object.assign(tokens, addBuckets(tokens, totals))
    }
    const routes = record.rows.usageByRoute?.val.routes
    if (routes === undefined) continue
    pricedSessions += 1
    for (const [route, buckets] of Object.entries(routes)) {
      routeTokens.set(route, addBuckets(routeTokens.get(route) ?? zeroBuckets(), buckets))
    }
  }

  const rollupRoutes: UsageCostRouteRollup[] = []
  let costMicros = 0
  for (const route of [...routeTokens.keys()].sort()) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- route came from this map's keys, so its value exists.
    const routeBuckets = routeTokens.get(route)!
    if (!hasBillableTokens(routeBuckets)) continue
    const routeRates = rates[route]
    if (routeRates === undefined) {
      throw new Error(`usage-cost: no prices for route "${route}"; add it to the usage-cost rate table`)
    }
    const routeCost = priceUsage(routeBuckets, routeRates)
    costMicros += routeCost
    rollupRoutes.push({ route, tokens: routeBuckets, costMicros: routeCost })
  }

  return { sessions, pricedSessions, tokens, routes: rollupRoutes, costMicros }
}
