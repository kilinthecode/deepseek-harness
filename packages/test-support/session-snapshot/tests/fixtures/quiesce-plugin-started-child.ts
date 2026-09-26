/**
 * Bridge a plugin-started (not tool-started) child's own quiescence into its
 * parent's `whenIdle()`. A background side effect that a global
 * `agent/status` listener starts with `void`, fire-and-forget, when an agent
 * goes idle — an unattended memory review, for example — races a one-shot
 * process that exits as soon as its own top-level agent reports idle:
 * nothing links that fire-and-forget start back to the caller awaiting
 * `whenIdle()`, so the process can dispose the child mid-turn.
 *
 * Mounting this fixture in a scenario's composition closes that gap
 * deterministically, with no elapsed-time assumption: every idle transition
 * of a top-level (non-child) agent opens a maintenance window — see
 * `Agent.runMaintenance` — that settles only once a local subagent whose
 * `parentSession` names that agent also reaches its own `whenIdle()`. The
 * scenario that mounts this fixture must guarantee a local subagent follows
 * every top-level idle transition it drives through this bridge; otherwise
 * the opened maintenance window never settles.
 * @module @deepseek-ai/dsh-session-snapshot/tests/fixtures/quiesce-plugin-started-child
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'quiesce-plugin-started-child'
export const inject = ['agents', 'subagents']

/**
 * Install the bridge described in the module doc.
 * @param ctx - plugin context carrying the agent registry and subagent lifecycle events.
 */
export function apply(ctx: Context): void {
  const pendingChild = new Map<SessionId, PromiseWithResolvers<Agent>>()

  /** Get or lazily create the deferred a parent's bridge awaits. */
  const deferredFor = (parentId: SessionId): PromiseWithResolvers<Agent> => {
    let entry = pendingChild.get(parentId)
    if (entry === undefined) {
      entry = Promise.withResolvers<Agent>()
      pendingChild.set(parentId, entry)
    }
    return entry
  }

  ctx.on('subagent/start', (info) => {
    if (!info.local) return
    const child = ctx.agents.get(info.id)
    const parentId = child?.session.header.parentSession
    if (child === undefined || parentId === undefined) return
    deferredFor(parentId).resolve(child)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || agent.session.header.parentSession !== undefined) return
    const parentId = agent.session.id
    try {
      void agent.runMaintenance(async (signal) => {
        const child = await Promise.race([
          deferredFor(parentId).promise,
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('quiesce-plugin-started-child: aborted before a local subagent started'))
            }, { once: true })
          }),
        ])
        pendingChild.delete(parentId)
        await child.whenIdle()
      }).catch((error: unknown) => {
        ctx.logger.warn(
          `quiesce-plugin-started-child: maintenance window ended without a plugin-started child: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    } catch (error: unknown) {
      // Another synchronous `agent/status` listener ahead of this one already
      // left the idle phase (e.g. a wake) before this ran; nothing to bridge.
      ctx.logger.warn(
        `quiesce-plugin-started-child: could not open a maintenance window: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}
