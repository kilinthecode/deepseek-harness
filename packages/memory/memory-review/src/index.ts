/**
 * Cache-parity background memory review: when a parent agent becomes idle
 * after enough user-kind turns, start an in-process fork child with the
 * review task. The child may only add new memories. Named exports preserve
 * loader injection metadata.
 * @module @deepseek-ai/dsh-memory-review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-memory'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { REVIEW_LABEL, REVIEW_PROMPT } from './prompt.ts'
import { dueForReview, registerMemoryReviewProjection } from './projection.ts'
import { installReviewRestrictions } from './restrict.ts'

export { REVIEW_DENY_OTHER_TOOL, REVIEW_DENY_OVERWRITE, REVIEW_LABEL, REVIEW_PROMPT } from './prompt.ts'
export { dueForReview } from './projection.ts'
export type { MemoryReviewState } from './projection.ts'
export { reviewWriteTarget } from './restrict.ts'

/** Cordis plugin name; also the `subagent/catalog` label of every review child. */
export const name = 'memory-review'

/** Services the projection, idle trigger, and fork start read. */
export const inject = ['memory', 'tools', 'subagents', 'sessionProjections', 'agents']

/** Review-interval configuration. Invalid values fail plugin load. */
export interface Config {
  /**
   * User-kind parent messages between reviews. `0` disables reviews while the
   * plugin stays mounted; a negative value fails load.
   */
  reviewEveryUserTurns: number
  /**
   * Inclusive cap on the review child's `agent/pre-step` `step`. Step
   * `maxReviewSteps + 1` is rejected. Values below `1` fail load.
   */
  maxReviewSteps: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  reviewEveryUserTurns: z.number().step(1).min(0).required(),
  maxReviewSteps: z.number().step(1).min(1).required(),
})

/**
 * Register the review projection, idle trigger, and child restrictions.
 *
 * `memory_write` and the `fork` provider are registered by sibling plugins'
 * own `apply()` calls, not by the `tools` and `subagents` services this
 * plugin injects: `EntryGroup.update()` in `vendor/loader/src/config/group.ts`
 * activates sibling Loader entries concurrently through `Promise.all`, so a
 * bundle row order that lists this plugin after `@deepseek-ai/dsh-tool-memory`
 * and the fork provider does not guarantee their registrations already ran
 * when this `apply()` runs. Presence is therefore checked at the earliest
 * self-contained resolvable point instead: when a review becomes due, in
 * {@link startReview}.
 * @param ctx - registrant context; every registration disposes with it.
 * @param config - review interval and child step cap.
 */
export function apply(ctx: Context, config: Config): void {
  registerMemoryReviewProjection(ctx)

  const inflight = new Map<SessionId, AbortController>()
  const dispatching = new Set<SessionId>()
  const warnedMissingDependency = new Set<string>()
  ctx.effect(() => () => {
    for (const controller of inflight.values()) controller.abort()
  }, 'memory-review.abortOnUnload')

  ctx.on('agent/disposed', ({ agent }) => {
    const controller = inflight.get(agent.session.id)
    controller?.abort()
    // `startReview`'s own settlement also releases this entry once `run.result`
    // rejects from the abort; releasing it here too keeps a disposed parent's
    // guard cleared immediately instead of waiting on that async settlement.
    // `releaseInflight` only removes the entry if it still belongs to this
    // controller: a fresh agent re-created on the same (disposed) session id
    // may already have started its own review and hold a newer entry.
    releaseInflight(inflight, agent.session.id, controller)
  })

  ctx.on('agent/created', ({ agent }) => {
    const parentSession = agent.session.header.parentSession
    // Gated on `dispatching`, not `inflight`: `inflight` spans the whole
    // review (start through settlement), so any later sibling the parent
    // creates for an unrelated reason while a review is running would
    // otherwise be wrongly restricted. `dispatching` covers only the review
    // child's own `agent/created`, fired synchronously inside `start()`.
    if (parentSession === undefined || !dispatching.has(parentSession)) return
    installReviewRestrictions(agent, config.maxReviewSteps, ctx.memory)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    void startReview(ctx, agent, config, inflight, dispatching, warnedMissingDependency)
  })
}

/**
 * Remove `sessionId`'s in-flight guard entry only if it still belongs to
 * `controller`. A parent disposed mid-review can be re-created on the same
 * session id before this review's own settlement runs; that later review
 * installs its own controller, and an unconditional delete here would clear
 * its guard entry instead of this review's, letting a third review overlap it.
 * Exported for direct testing: the in-process fork driver ties a review
 * child's own cordis scope to its parent's, so disposing the parent always
 * settles that review's `run.result` before the parent's own `dispose()`
 * returns, leaving no window to observe a second review's entry surviving
 * the first's settlement through the full agent loop alone.
 * @param inflight - the sole one-review-per-parent guard.
 * @param sessionId - parent session id whose entry may be released.
 * @param controller - controller identifying the review that owns the entry.
 */
export function releaseInflight(
  inflight: Map<SessionId, AbortController>,
  sessionId: SessionId,
  controller: AbortController | undefined,
): void {
  if (controller !== undefined && inflight.get(sessionId) === controller) inflight.delete(sessionId)
}

/**
 * Log a missing-dependency error once per parent and dependency for the
 * plugin's lifetime, instead of on every due-but-skipped idle notification.
 * Keying by dependency keeps a second, distinct missing dependency loud
 * after the first was already reported for the same parent.
 * @param ctx - plugin context whose logger receives the message.
 * @param key - parent session id plus the missing dependency the warning is scoped to.
 * @param warned - parent/dependency pairs that have already been warned.
 * @param message - error text to log the first time.
 */
function warnMissingDependencyOnce(ctx: Context, key: string, warned: Set<string>, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  ctx.logger.error(message)
}

/**
 * Start one review for an idle parent when the interval is due.
 * The caller must not await this from the `agent/status` listener. Fails
 * loudly and skips the review, without starting it, when `memory_write` or
 * the `fork` provider are not registered yet: see {@link apply} for why this
 * plugin cannot assume either is present by the time it applies.
 * @param ctx - plugin context.
 * @param agent - agent that just became idle.
 * @param config - review interval and child step cap.
 * @param inflight - parents that already have a review running; the sole
 * one-review-per-parent guard.
 * @param dispatching - parents whose review child is being created right
 * now; the `agent/created` restriction gate reads this, not `inflight`.
 * @param warnedMissingDependency - parent/dependency pairs already warned
 * about a missing `memory_write` tool or `fork` provider, so each warning logs once.
 */
async function startReview(
  ctx: Context,
  agent: Agent,
  config: Config,
  inflight: Map<SessionId, AbortController>,
  dispatching: Set<SessionId>,
  warnedMissingDependency: Set<string>,
): Promise<void> {
  if (agent.session.header.parentSession !== undefined) return
  if (inflight.has(agent.session.id)) return
  if (!dueForReview(ctx.sessionProjections.stateOf(agent.session, 'memoryReview'), config.reviewEveryUserTurns)) {
    return
  }
  if (ctx.tools.get('memory_write', agent) === undefined) {
    warnMissingDependencyOnce(
      ctx, `${agent.session.id}:memory_write`, warnedMissingDependency,
      'memory-review: the memory_write tool is not registered; mount @deepseek-ai/dsh-tool-memory before memory-review',
    )
    return
  }
  if (!ctx.subagents.list().includes('fork')) {
    warnMissingDependencyOnce(
      ctx, `${agent.session.id}:fork`, warnedMissingDependency,
      'memory-review: the fork subagent provider is not registered; mount @deepseek-ai/dsh-subagent-fork-in-process before memory-review',
    )
    return
  }
  const controller = new AbortController()
  inflight.set(agent.session.id, controller)
  try {
    let run: SubagentRun
    dispatching.add(agent.session.id)
    try {
      run = await ctx.agents.withInitiator(agent, () => ctx.subagents.start('fork', {
        parent: agent,
        prompt: [{ type: 'text', text: REVIEW_PROMPT }],
        label: REVIEW_LABEL,
        signal: controller.signal,
      }))
    } finally {
      dispatching.delete(agent.session.id)
    }
    if (run.localAgent === undefined) {
      releaseInflight(inflight, agent.session.id, controller)
      // No waiter owns this run; swallow the settlement so disposal can finish.
      void run.result.catch(() => undefined)
      await run.dispose()
      throw new Error('memory-review requires an in-process fork child')
    }
    const settle = (): void => {
      releaseInflight(inflight, agent.session.id, controller)
      void run.dispose()
    }
    const settleAfterFailure = (error: unknown): void => {
      settle()
      ctx.logger.warn(`memory-review: review child failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    void run.result.then(settle, settleAfterFailure)
  } catch (error: unknown) {
    releaseInflight(inflight, agent.session.id, controller)
    ctx.logger.warn(`memory-review: ${error instanceof Error ? error.message : String(error)}`)
  }
}
