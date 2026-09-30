/**
 * Durable inputs and priced outputs of the usage-cost rollup: the one home for
 * the record shape read from the durable session index and the priced result
 * a window produces. Token buckets reuse the per-route unit's shape; rates are
 * integer micros so priced sums stay exact in JSON.
 *
 * @module @deepseek-ai/dsh-usage-cost/types
 */

import type { UsageByRouteState } from '@deepseek-ai/dsh-token-meter'

/** Token buckets one route accumulated, identical to the per-route unit's values. */
export type UsageCostBuckets = UsageByRouteState['routes'][string]

/**
 * One durable session-index record: the identity and projection rows the
 * projection cache stored for a session. Both rows are optional because a
 * record may predate the unit that owns them. Rows report the usage the session
 * itself produced, so a forked session's inherited prefix is not counted here
 * as well as in its parent's record.
 */
export interface UsageIndexRecord {
  /** Session identity the projection cache stamped on the record. */
  identity: {
    /** Session creation time (epoch milliseconds); the window's only time input. */
    createdAt: number
  }
  /** Projection rows by unit key. */
  rows: {
    /** Whole-session usage totals of the events this session owns. */
    tokenUsage?: {
      val: {
        totals: UsageCostBuckets
      }
    }
    /** Per-route usage, once the unit has folded this session: the rows the rollup prices. */
    usageByRoute?: {
      val: {
        routes: Record<string, UsageCostBuckets>
      }
    }
  }
}

/**
 * One half-open window over session creation time: a record belongs to the
 * window when `from <= identity.createdAt < to`.
 */
export interface UsageWindow {
  /** Inclusive lower bound (epoch milliseconds). */
  from: number
  /** Exclusive upper bound (epoch milliseconds). */
  to: number
}

/** Per-million-token prices in integer micros of one currency unit. */
export interface UsageCostRates {
  /** Price of one million uncached input tokens. */
  inputMicros: number
  /** Price of one million cache-read tokens. */
  cacheReadMicros: number
  /** Price of one million cache-write tokens. */
  cacheWriteMicros: number
  /** Price of one million output tokens. */
  outputMicros: number
}

/** Priced usage of one route inside a window. */
export interface UsageCostRouteRollup {
  /** Route key exactly as the per-route unit folds it. */
  route: string
  /** Token buckets the window's sessions attributed to the route. */
  tokens: UsageCostBuckets
  /** Price of {@link tokens} at the route's rates, in micros. */
  costMicros: number
}

/** Priced usage of every session created inside one window. */
export interface UsageCostRollup {
  /** Records the window covers. */
  sessions: number
  /** Records carrying per-route usage, whose tokens reach {@link routes}. */
  pricedSessions: number
  /** `tokenUsage` totals of every covered record, priced or not. */
  tokens: UsageCostBuckets
  /** Per-route usage of {@link pricedSessions}, keyed and priced per route. */
  routes: UsageCostRouteRollup[]
  /** Sum of {@link UsageCostRouteRollup.costMicros} over {@link routes}. */
  costMicros: number
}
