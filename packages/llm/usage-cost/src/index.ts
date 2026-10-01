/**
 * Priced usage rollups from the durable session index: validation for the
 * per-route price table and the pure rollup that prices one time window of
 * session-index records, without replaying session logs.
 *
 * @module @deepseek-ai/dsh-usage-cost
 */

export type * from './types.ts'
export {
  parseUsageCostRates,
  priceUsage,
  rollupUsageCost,
  usageCostRatesSchema,
} from './rollup.ts'
export type { UsageCostRatesTable } from './rollup.ts'
