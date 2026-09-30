/**
 * Host-only `memoryReview` fold: user-kind messages increment the count;
 * memory tool calls and this plugin's catalog label reset it.
 * @module @deepseek-ai/dsh-memory-review/src/projection
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import { REVIEW_LABEL } from './prompt.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** User-kind turns since the last memory tool call or memory-review catalog row. */
    memoryReview: MemoryReviewState
  }
}

const MEMORY_TOOLS = new Set(['memory_write', 'memory_recall', 'memory_forget'])

const memoryReviewStateSchema = zod.object({
  turnsSinceReset: zod.number().int().nonnegative(),
})

/** Folded review-interval state on one session. */
export type MemoryReviewState = zod.infer<typeof memoryReviewStateSchema>

/**
 * Whether an idle parent is due to start a review.
 * @param state - folded `memoryReview` state, or `undefined` when the unit is not registered.
 * @param interval - `reviewEveryUserTurns`; `0` disables reviews.
 * @returns true when a review should start.
 */
export function dueForReview(state: MemoryReviewState | undefined, interval: number): boolean {
  if (interval === 0 || state === undefined) return false
  return state.turnsSinceReset >= interval
}

/**
 * Register the `memoryReview` projection. Host-only: there is no `wire` view.
 * @param ctx - plugin context carrying `sessionProjections`; the registration disposes with it.
 */
export function registerMemoryReviewProjection(ctx: Context): void {
  ctx.sessionProjections.register({
    key: 'memoryReview',
    stateVersion: 1,
    stateSchema: memoryReviewStateSchema,
    init: () => ({ turnsSinceReset: 0 }),
    apply: (state, event) => {
      if (event.type === 'user/message') {
        if (event.data.source.kind !== 'user') return state
        return { turnsSinceReset: state.turnsSinceReset + 1 }
      }
      if (event.type === 'tool/call') {
        if (!MEMORY_TOOLS.has(event.data.name)) return state
        return state.turnsSinceReset === 0 ? state : { turnsSinceReset: 0 }
      }
      if (event.type === 'subagent/catalog') {
        if (event.data.label !== REVIEW_LABEL) return state
        return state.turnsSinceReset === 0 ? state : { turnsSinceReset: 0 }
      }
      return state
    },
  })
}
