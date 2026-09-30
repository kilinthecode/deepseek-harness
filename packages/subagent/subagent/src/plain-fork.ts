/**
 * Classify an exact live Agent as a plain fork of another exact live Agent,
 * from its own in-process composition record, so the check works identically
 * right after creation and after a cold resume, with no session history read.
 *
 * @module @deepseek-ai/dsh-subagent/plain-fork
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { isChildCompositionScoped } from './child-agent.ts'

/**
 * Resolve the exact live delegating parent of a plain fork: a child seeded
 * with the parent's inherited history through `subagent_fork` (the one-shot
 * driver, or a continuable fork including a cold resume) whose composition
 * installed no persona, tool filter, or structured-output runtime.
 *
 * Identity (`header.isSeeded`, `header.origin`, `header.parentSession`) is
 * set synchronously in `childSessionMeta()` before either child shape
 * publishes, so it is already readable from `agent/created`. Scoping is
 * established the same way: `applyChildComposition` runs inside the same
 * unpublished creation window — for a fresh one-shot or continuable child and
 * for every continuable cold resume alike — and records there whether it
 * installed a persona, tool filter, or structured-output runtime. Both facts
 * this function reads are therefore already settled by the time a caller
 * classifies from `agent/created`, in every mode, with no descriptor to race.
 * @param agent - the exact live candidate fork.
 * @returns the exact live delegating parent, or `undefined` when `agent` is
 *   not seeded from a subagent origin, its composition installed a persona,
 *   tool filter, or structured-output runtime, or its recorded parent is not
 *   currently live. A Team roster child seeded through `spawn_teammate`'s
 *   `context: 'fork'` also satisfies this shape and resolves its parent; that
 *   is harmless because a caller resolving Team membership matches the child
 *   as a roster member first and never reaches this function for it.
 */
export function plainForkParentOf(agent: Agent): Agent | undefined {
  const header = agent.session.header
  if (!header.isSeeded || header.origin !== 'subagent' || header.parentSession === undefined) return undefined
  if (isChildCompositionScoped(agent.ctx)) return undefined
  return agent.ctx.agents.get(header.parentSession)
}
