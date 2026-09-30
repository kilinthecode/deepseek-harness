import { describe, expect, it } from 'vitest'
import { UNATTRIBUTED_ROUTE } from '@deepseek-ai/dsh-token-meter'
import { parseUsageCostRates, priceUsage, rollupUsageCost } from '../src/rollup.ts'
import type { UsageCostBuckets, UsageIndexRecord } from '../src/types.ts'

const RATES = {
  'deepseek-official/deepseek-flash': {
    inputMicros: 300,
    cacheReadMicros: 30,
    cacheWriteMicros: 600,
    outputMicros: 1_200,
  },
}

const buckets = (
  uncachedInputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): UsageCostBuckets => ({ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })

const record = (
  createdAt: number,
  rows: UsageIndexRecord['rows'] = {},
): UsageIndexRecord => ({ identity: { createdAt }, rows })

const usageRow = (totals: UsageCostBuckets): UsageIndexRecord['rows'] => ({
  tokenUsage: { val: { totals } },
})

const routeRow = (routes: Record<string, UsageCostBuckets>): UsageIndexRecord['rows'] => ({
  usageByRoute: { val: { route: null, routes, last: null } },
})

describe('parsing the rate table', () => {
  it('accepts provider/model and unattributed keys with integer micro prices', () => {
    const table = parseUsageCostRates({
      ...RATES,
      [UNATTRIBUTED_ROUTE]: {
        inputMicros: 0,
        cacheReadMicros: 0,
        cacheWriteMicros: 0,
        outputMicros: 0,
      },
    })

    expect(Object.keys(table).sort()).toEqual([UNATTRIBUTED_ROUTE, 'deepseek-official/deepseek-flash'].sort())
  })

  it('rejects a key that is neither a route key nor the unattributed key', () => {
    expect(() => parseUsageCostRates({
      flash: { inputMicros: 1, cacheReadMicros: 0, cacheWriteMicros: 0, outputMicros: 0 },
    })).toThrow(/neither a provider\/model route key nor "unattributed"/)
  })

  it('rejects fractional, negative, and missing prices', () => {
    const valid = { inputMicros: 1, cacheReadMicros: 0, cacheWriteMicros: 0, outputMicros: 0 }
    expect(() => parseUsageCostRates({ 'a/b': { ...valid, inputMicros: 0.5 } })).toThrow()
    expect(() => parseUsageCostRates({ 'a/b': { ...valid, outputMicros: -1 } })).toThrow()
    expect(() => parseUsageCostRates({ 'a/b': { ...valid, cacheReadMicros: undefined } })).toThrow()
  })

  it('rejects unknown rate keys and non-table values', () => {
    const valid = { inputMicros: 1, cacheReadMicros: 0, cacheWriteMicros: 0, outputMicros: 0 }
    expect(() => parseUsageCostRates({ 'a/b': { ...valid, typoMicros: 1 } })).toThrow()
    expect(() => parseUsageCostRates('rates')).toThrow()
  })
})

describe('pricing one route', () => {
  it('prices each bucket at its per-million-token micro rate', () => {
    expect(priceUsage(buckets(2_000_000, 500_000, 4_000_000, 1_000_000), {
      inputMicros: 300,
      cacheReadMicros: 30,
      cacheWriteMicros: 600,
      outputMicros: 1_200,
    })).toBe(1_920)
  })

  it('rounds each bucket to whole micros', () => {
    expect(priceUsage(buckets(1, 1, 1, 1), {
      inputMicros: 1,
      cacheReadMicros: 1,
      cacheWriteMicros: 1,
      outputMicros: 1,
    })).toBe(0)
    expect(priceUsage(buckets(3, 0, 0, 0), {
      inputMicros: 1_000_000,
      cacheReadMicros: 0,
      cacheWriteMicros: 0,
      outputMicros: 0,
    })).toBe(3)
  })
})

describe('rolling up one window', () => {
  it('covers only records whose creation time falls in the half-open window', () => {
    const records = [
      record(100, usageRow(buckets(1, 0))),
      record(200, usageRow(buckets(10, 0))),
      record(300, usageRow(buckets(100, 0))),
    ]

    const rollup = rollupUsageCost(records, { from: 100, to: 300 }, RATES)

    expect(rollup.sessions).toBe(2)
    expect(rollup.tokens.uncachedInputTokens).toBe(11)
    expect(rollup.tokens).toEqual(buckets(11, 0))
  })

  it('sums whole-session totals from every covered record, priced or not', () => {
    const records = [
      record(100, { ...usageRow(buckets(10, 2, 30, 5)), ...routeRow({
        'deepseek-official/deepseek-flash': buckets(1_000_000, 0),
      }) }),
      record(150, usageRow(buckets(1, 1))),
    ]

    const rollup = rollupUsageCost(records, { from: 0, to: 1_000 }, RATES)

    expect(rollup.sessions).toBe(2)
    expect(rollup.pricedSessions).toBe(1)
    expect(rollup.tokens).toEqual(buckets(11, 3, 30, 5))
    expect(rollup.costMicros).toBe(300)
  })

  it('prices each route separately and lists routes in key order', () => {
    const records = [
      record(100, routeRow({
        'deepseek-official/deepseek-v4-pro': buckets(1_000_000, 0),
        'deepseek-official/deepseek-flash': buckets(2_000_000, 0),
      })),
      record(150, routeRow({
        'deepseek-official/deepseek-flash': buckets(1_000_000, 0),
      })),
    ]

    const rollup = rollupUsageCost(records, { from: 0, to: 1_000 }, {
      ...RATES,
      'deepseek-official/deepseek-v4-pro': {
        inputMicros: 100,
        cacheReadMicros: 0,
        cacheWriteMicros: 0,
        outputMicros: 0,
      },
    })

    expect(rollup.routes.map(route => route.route)).toEqual([
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-v4-pro',
    ])
    expect(rollup.routes[0]).toEqual({
      route: 'deepseek-official/deepseek-flash',
      tokens: buckets(3_000_000, 0),
      costMicros: 900,
    })
    expect(rollup.routes[1]!.costMicros).toBe(100)
    expect(rollup.costMicros).toBe(1_000)
  })

  it('prices the unattributed route from its own rate entry', () => {
    const rollup = rollupUsageCost(
      [record(100, routeRow({ [UNATTRIBUTED_ROUTE]: buckets(1_000_000, 0) }))],
      { from: 0, to: 1_000 },
      {
        ...RATES,
        [UNATTRIBUTED_ROUTE]: {
          inputMicros: 500,
          cacheReadMicros: 0,
          cacheWriteMicros: 0,
          outputMicros: 0,
        },
      },
    )

    expect(rollup.routes[0]).toEqual({
      route: UNATTRIBUTED_ROUTE,
      tokens: buckets(1_000_000, 0),
      costMicros: 500,
    })
    expect(rollup.costMicros).toBe(500)
  })

  it('fails loud when a present route has no prices', () => {
    const records = [record(100, routeRow({ 'other/provider-model': buckets(1, 0) }))]

    expect(() => rollupUsageCost(records, { from: 0, to: 1_000 }, RATES))
      .toThrow(/no prices for route "other\/provider-model"/)
  })

  it('counts a record with no rows without pricing it', () => {
    const rollup = rollupUsageCost([record(100)], { from: 0, to: 1_000 }, RATES)

    expect(rollup).toEqual({
      sessions: 1,
      pricedSessions: 0,
      tokens: buckets(0, 0),
      routes: [],
      costMicros: 0,
    })
  })

  it('returns zeroed totals for a window covering no record', () => {
    expect(rollupUsageCost([record(100, usageRow(buckets(1, 1)))], { from: 500, to: 600 }, RATES))
      .toEqual({
        sessions: 0,
        pricedSessions: 0,
        tokens: buckets(0, 0),
        routes: [],
        costMicros: 0,
      })
  })
})
