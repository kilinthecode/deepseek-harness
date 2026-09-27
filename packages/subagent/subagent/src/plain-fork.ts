/**
 * Classify an exact live Agent as a plain fork of another exact live Agent,
 * from durable session data alone, so the check works identically right
 * after creation and after a cold resume.
 *
 * @module @deepseek-ai/dsh-subagent/plain-fork
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { foldSubagentDescriptor } from './descriptor.ts'

/**
 * Resolve the exact live delegating parent of a plain fork: a child seeded
 * with the parent's inherited history through `subagent_fork` (the one-shot
 * driver, or a continuable fork including a cold resume), with no persona
 * and no tool filter declared.
 *
 * A runtime-gated installer that adds prompt sections or tools on
 * `agent.ctx`, keyed on some property of the agent rather than on its
 * composed preset, must also install them on a plain fork of a qualifying
 * agent. Otherwise the fork's first request omits them while its inherited
 * history still matches the parent's, and a provider prompt cache keyed on
 * the exact prefix misses the whole request instead of covering the shared
 * history.
 *
 * Identity (`header.isSeeded`, `header.origin`, `header.parentSession`) is
 * set synchronously in `childSessionMeta()` before either child shape
 * publishes, so it is already readable from `agent/created`. A one-shot
 * `subagent/descriptor` is instead appended lazily, inside the child's first
 * `agent/pre-step` — strictly after `agent/created` and after that step's own
 * prompt assembly, so a caller classifying from `agent/created` can race a
 * one-shot fork's descriptor. This function therefore never requires the
 * descriptor to be present: it reads one when already logged, purely to
 * exclude a continuable fork's declared persona or tool filter (the only
 * shape that records them — `descriptor.ts` omits both for `mode:
 * 'one-shot'`, because a one-shot child is never resumed). A persona- or
 * toolFilter-scoped one-shot fork is therefore indistinguishable here from a
 * plain one, because the one-shot descriptor never records those fields.
 * @param agent - the exact live candidate fork.
 * @returns the exact live delegating parent, or `undefined` when `agent` is
 *   not a plain fork, its recorded parent is not currently live, or its
 *   descriptor is logged but fails to parse. A Team roster child seeded
 *   through `spawn_teammate`'s `context: 'fork'` also satisfies this shape
 *   and resolves its parent; that is harmless because a caller resolving
 *   Team membership matches the child as a roster member first and never
 *   reaches this function for it.
 */
export function plainForkParentOf(agent: Agent): Agent | undefined {
  const header = agent.session.header
  if (!header.isSeeded || header.origin !== 'subagent' || header.parentSession === undefined) return undefined
  let descriptor: ReturnType<typeof foldSubagentDescriptor>
  try {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    descriptor = foldSubagentDescriptor(agent.session.snapshotEvents(agent.session.inheritedEventCount))
  } catch (_error: unknown) {
    // A structurally invalid current-version descriptor (for example a damaged
    // cold-resumed continuable fork payload, see archive-admission.spec.ts's
    // fixture) throws here. This runs from the `agent/created` listener inside
    // AgentRegistry#announce()'s serial dispatch, so propagating would reject
    // the whole chain and veto the agent's creation or resume; treat an
    // unclassifiable descriptor as not a plain fork instead.
    return undefined
  }
  if (descriptor?.mode === 'continuable' && (descriptor.persona !== undefined || descriptor.toolFilter !== undefined)) {
    return undefined
  }
  return agent.ctx.agents.get(header.parentSession)
}
