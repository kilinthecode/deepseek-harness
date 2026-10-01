/**
 * Pure folds for durable provider-reported token usage and context occupancy.
 */

import { z } from 'zod'
import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContextPressureProjection, TokenUsageProjection } from './projection.ts'
import { foldSurfaceProjection } from './surface-projection.ts'

const zeroBuckets = (): TokenUsageProjection => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const bucketsFrom = (usage: TokenUsage): TokenUsageProjection => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
})

const bucketsEqual = (left: TokenUsageProjection, right: TokenUsageProjection): boolean =>
  left.uncachedInputTokens === right.uncachedInputTokens
  && left.outputTokens === right.outputTokens
  && left.cacheReadTokens === right.cacheReadTokens
  && left.cacheWriteTokens === right.cacheWriteTokens

const addReplacing = (
  totals: TokenUsageProjection,
  previous: TokenUsageProjection | undefined,
  next: TokenUsageProjection,
): TokenUsageProjection => ({
  uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
  outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
  cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
})

/** Add one sample to a running total that owns no replacement slot for it. */
const addBuckets = (totals: TokenUsageProjection, next: TokenUsageProjection): TokenUsageProjection =>
  addReplacing(totals, undefined, next)

const projectionSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

/**
 * The token-usage unit's state schema — the one definition of the state
 * shape; the state type is inferred from it.
 */
const tokenUsageStateSchema = z.object({
  /** Events before this offset came from a fork parent, so their usage is the parent's to report. */
  inheritedEventCount: z.number().int().nonnegative(),
  totals: projectionSchema,
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    buckets: projectionSchema,
  }).nullable(),
}).strict()

type TokenUsageState = z.infer<typeof tokenUsageStateSchema>

const pressureSchema: z.ZodType<ContextPressureProjection> = z.object({
  pressureTokens: z.number().int().nonnegative().optional(),
  projectedTokens: z.number().int().nonnegative().optional(),
  contextWindow: z.number().int().positive().optional(),
}).strict().transform(({ pressureTokens, projectedTokens, contextWindow }) => ({
  ...pressureTokens === undefined ? {} : { pressureTokens },
  ...projectedTokens === undefined ? {} : { projectedTokens },
  ...contextWindow === undefined ? {} : { contextWindow },
}))

/** Prompt-side pressure of one request: input plus cache traffic, no output. */
const pressureFrom = (usage: TokenUsage): number =>
  usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)

/** The usage one durable Assistant settlement reports for its attempt, if any. */
function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    tokenUsage: TokenUsageState
    contextPressure: ContextPressureState
    usageByRoute: UsageByRouteState
  }
}

/** The route key usage samples attribute to: `provider/model`.
 * @param config - provider and model identifying the route.
 * @returns the `provider/model` route key.
 */
export const routeKeyOf = (config: { provider: string; model: string }): string =>
  `${config.provider}/${config.model}`

/** Route bucket a settled attempt falls into when no `request/header` named one. */
export const UNATTRIBUTED_ROUTE = 'unattributed'

/** Per-route durable usage folded from logged requests and settlements. */
export interface UsageByRouteState {
  /** Events before this offset came from a fork parent, so their usage is the parent's to report. */
  inheritedEventCount: number
  /** Route of the newest `request/header` this session owns; null before the first. */
  route: string | null
  /** Token buckets per {@link routeKeyOf} route, summed over settled attempts. */
  routes: Record<string, TokenUsageProjection>
  /** Newest settled attempt's slot; a same-step resample replaces it. */
  last: {
    turn: number
    step: number
    route: string
    buckets: TokenUsageProjection
  } | null
}

const usageByRouteStateSchema: z.ZodType<UsageByRouteState> = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  route: z.string().nullable(),
  routes: z.record(z.string(), projectionSchema),
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    route: z.string(),
    buckets: projectionSchema,
  }).nullable(),
}).strict()

/** The context-pressure state schema and source of its inferred type. */
const contextPressureStateSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  pressureTokens: z.number().int().nonnegative().optional(),
  surfaceTokens: z.number().int().nonnegative(),
  sampledSurfaceTokens: z.number().int().nonnegative().optional(),
  claim: z.object({
    start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
    end: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
    tokens: z.number().int().nonnegative(),
  }).optional(),
}).strict()

type ContextPressureState = z.infer<typeof contextPressureStateSchema>

/** One settled attempt's slot and the usage sample it contributed. */
interface SettledUsageSlot {
  readonly turn: number
  readonly step: number
  readonly usage: TokenUsage
}

/** One compaction summary's provider usage and the route that reported it. */
interface SummaryUsageSample {
  readonly route: string
  readonly usage: TokenUsage
}

/** State face both usage units share: the fork prefix they exclude and the newest settled slot. */
interface UsageFoldState {
  /** Events before this offset were inherited from a fork parent, whose own session reports their usage. */
  readonly inheritedEventCount: number
  readonly last: { turn: number; step: number } | null
}

/**
 * Fold the per-event policy both usage projections share.
 *
 * Only events this session owns are counted. A fork seeds its log with a copy
 * of its parent's events, and those requests are the parent's billed usage —
 * the parent's own record reports them, so folding them here too would bill one
 * request once per descendant of the fork tree.
 *
 * `llm/retry-started` closes the slot it names so the retried attempt counts
 * again instead of resampling the attempt that never settled. A message-
 * producing event carrying a usage sample reaches `settle`; a compaction
 * summary carrying one reaches `absorb`, because a summary call is billed by
 * the provider but settles no attempt slot of its own. Every other event leaves
 * the state unchanged.
 *
 * @param state - projection state whose `last` records the newest settled slot.
 * @param event - committed session event to fold.
 * @param settle - projection-specific settlement of one accepted attempt sample.
 * @param absorb - projection-specific addition of one compaction summary sample.
 * @returns the next state, or the unchanged state when this event settles nothing.
 */
function foldSettledUsage<S extends UsageFoldState>(
  state: S,
  event: SessionEvent,
  settle: (state: S, slot: SettledUsageSlot) => S,
  absorb: (state: S, sample: SummaryUsageSample) => S,
): S {
  if (event.seq < state.inheritedEventCount) return state
  if (event.type === 'llm/retry-started') {
    const last = state.last
    return last?.turn === event.data.turn && last.step === event.data.step
      ? { ...state, last: null }
      : state
  }
  if (event.type === 'compaction/summary') {
    const usage = event.data.usage
    return usage === undefined ? state : absorb(state, { route: routeKeyOf(event.data), usage })
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
  const sample = usageOf(event)
  if (sample === undefined) return state
  return settle(state, { turn: event.data.turn, step: event.data.step, usage: sample })
}

/**
 * Token-meter's session projection unit.
 *
 * Each v2 Assistant settlement contributes the last usage sample embedded in
 * its stream, and each `compaction/summary` the provider usage of the
 * summarization call it logged. `llm/retry-started` closes the replacement slot
 * so the retried attempt adds to the total. A seeded (forked) session counts
 * only the events it produced, so an inherited prefix is never billed twice.
 */
export const tokenUsageProjectionDefinition = {
  key: 'tokenUsage',
  stateVersion: 3,
  stateSchema: tokenUsageStateSchema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, totals: zeroBuckets(), last: null }),
  apply: (state, event) => foldSettledUsage(state, event, (current, slot) => {
    const buckets = bucketsFrom(slot.usage)
    const previous = current.last !== null
      && current.last.turn === slot.turn
      && current.last.step === slot.step
      ? current.last.buckets
      : undefined
    if (previous !== undefined && bucketsEqual(previous, buckets)) return current

    return {
      ...current,
      totals: addReplacing(current.totals, previous, buckets),
      last: { turn: slot.turn, step: slot.step, buckets },
    }
  }, (current, sample) => ({
    ...current,
    totals: addBuckets(current.totals, bucketsFrom(sample.usage)),
  })),
  wire: { viewSchema: projectionSchema, view: state => state.totals },
} satisfies ProjectionDefinition<'tokenUsage', TokenUsageState>

/**
 * Token-meter's context-occupancy projection unit.
 *
 * Independent last-wins slots: the newest usage sample supplies the provider
 * numerator, the newest `request/context` record the denominator. Both are
 * whole values, so replay order alone decides the result and no cross-field
 * consistency is claimed — the pair is explicitly not one atomic request
 * observation (see {@link ContextPressureProjection}).
 *
 * `pressureTokens` is prompt-side only, so it holds still while a turn streams
 * and steps forward once the next request reports its usage. Because nothing
 * but a request reports usage, it also cannot see a compaction: the fold
 * therefore carries a running surface total alongside it and publishes
 * `projectedTokens` — the sample plus the surface's signed movement since it
 * was taken — so occupancy answers for the next request rather than the last
 * one. The total rides {@link foldSurfaceProjection}, so the state stays O(1)
 * and a replacement shrinks it by its logged shadow price. A replacement
 * without a claim preserves the previous total. A usage sample is stamped
 * BEFORE the same event joins the surface, so an `assistant/message` anchors
 * against the surface its own request saw.
 */
export const contextPressureProjectionDefinition = {
  key: 'contextPressure',
  stateVersion: 5,
  stateSchema: contextPressureStateSchema,
  init: () => ({ surfaceTokens: 0 }),
  apply: (state, event) => {
    const fold = foldSurfaceProjection(state.claim, event)
    let next = state
    if (event.type === 'request/context') {
      const contextWindow = event.data.contextWindow
      if (contextWindow !== state.contextWindow) {
        if (contextWindow !== undefined) {
          next = { ...next, contextWindow }
        } else {
          const { contextWindow: _removed, ...withoutContextWindow } = next
          next = withoutContextWindow
        }
      }
    }
    const usage = usageOf(event)
    if (usage !== undefined) {
      const pressureTokens = pressureFrom(usage)
      if (pressureTokens !== next.pressureTokens || next.sampledSurfaceTokens !== next.surfaceTokens) {
        next = { ...next, pressureTokens, sampledSurfaceTokens: next.surfaceTokens }
      }
    }
    if (fold.deltaTokens !== 0) {
      next = { ...next, surfaceTokens: next.surfaceTokens + fold.deltaTokens }
    }
    // A defined fold.claim is always freshly built, so presence decides claim
    // bookkeeping: no claim before or after this event leaves `next` as is.
    if (state.claim === undefined && fold.claim === undefined) return next
    const { claim: _expired, ...withoutClaim } = next
    return fold.claim === undefined ? withoutClaim : { ...withoutClaim, claim: fold.claim }
  },
  wire: {
    viewSchema: pressureSchema,
    view: ({ contextWindow, pressureTokens, surfaceTokens, sampledSurfaceTokens }) => ({
      ...contextWindow === undefined ? {} : { contextWindow },
      ...pressureTokens === undefined ? {} : { pressureTokens },
      ...pressureTokens === undefined || sampledSurfaceTokens === undefined
        ? {}
        : { projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens) },
    }),
  },
} satisfies ProjectionDefinition<'contextPressure', ContextPressureState>

/**
 * Token-meter's per-route usage unit.
 *
 * The newest `request/header` names the route its next settlement bills, so
 * every settled attempt's usage sample lands in that route's buckets. A
 * same-step resample moves its own previous contribution — possibly between
 * routes, when a retry changed the route — so only the replacement counts. A
 * sample arriving before any header falls into {@link UNATTRIBUTED_ROUTE}
 * rather than disappearing. A `compaction/summary` bills the route the summary
 * call itself reported, which is not necessarily the conversation's newest
 * request route. Only events the session owns are billed, so a forked session
 * prices its own requests and not the prefix it inherited.
 */
export const usageByRouteProjectionDefinition = {
  key: 'usageByRoute',
  stateVersion: 2,
  stateSchema: usageByRouteStateSchema,
  init: (_header, inheritedEventCount): UsageByRouteState => ({
    inheritedEventCount, route: null, routes: {}, last: null,
  }),
  apply: (state, event) => {
    if (event.type === 'request/header' && event.seq >= state.inheritedEventCount) {
      const route = routeKeyOf(event.data.header.config)
      return route === state.route ? state : { ...state, route }
    }
    return foldSettledUsage(state, event, (current, slot) => {
      const route = current.route ?? UNATTRIBUTED_ROUTE
      const buckets = bucketsFrom(slot.usage)
      const previous = current.last !== null
        && current.last.turn === slot.turn
        && current.last.step === slot.step
        ? current.last
        : undefined
      if (previous !== undefined && previous.route === route && bucketsEqual(previous.buckets, buckets)) {
        return current
      }
      const routes = { ...current.routes }
      if (previous !== undefined) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- The recorded slot created this route entry.
        routes[previous.route] = addReplacing(routes[previous.route]!, previous.buckets, zeroBuckets())
      }
      routes[route] = addReplacing(routes[route] ?? zeroBuckets(), undefined, buckets)
      return { ...current, routes, last: { turn: slot.turn, step: slot.step, route, buckets } }
    }, (current, sample) => ({
      ...current,
      routes: {
        ...current.routes,
        [sample.route]: addBuckets(current.routes[sample.route] ?? zeroBuckets(), bucketsFrom(sample.usage)),
      },
    }))
  },
  wire: {
    viewSchema: z.record(z.string(), projectionSchema),
    view: (state: UsageByRouteState): Record<string, TokenUsageProjection> => state.routes,
  },
} satisfies ProjectionDefinition<'usageByRoute', UsageByRouteState>
