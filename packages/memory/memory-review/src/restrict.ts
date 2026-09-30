/**
 * Child-only tool and step restrictions for an unattended memory review.
 * @module @deepseek-ai/dsh-memory-review/src/restrict
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { MemoryRecord, MemoryScope, MemoryStore, MemoryVisible } from '@deepseek-ai/dsh-memory'
import { MEMORY_SCOPES } from '@deepseek-ai/dsh-memory'
import { createMemoryWriteTool } from '@deepseek-ai/dsh-tool-memory'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { REVIEW_DENY_OTHER_TOOL, REVIEW_DENY_OVERWRITE } from './prompt.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function flattenVisible(visible: MemoryVisible): MemoryRecord[] {
  return [...visible.global, ...visible.project?.records ?? []]
}

/**
 * Read the name and scope a `memory_write` call would use.
 * @param args - parsed tool arguments.
 * @returns the target when `name` is a string and `scope` is `global` or `project`; otherwise `undefined`.
 */
export function reviewWriteTarget(args: unknown): { name: string; scope: MemoryScope } | undefined {
  if (!isRecord(args)) return undefined
  if (typeof args.name !== 'string') return undefined
  if (args.scope !== MEMORY_SCOPES[0] && args.scope !== MEMORY_SCOPES[1]) return undefined
  return { name: args.name, scope: args.scope }
}

/**
 * Install add-only tool policy and the step cap on one review child.
 * Listeners and the scoped tool are registered on that child's own `ctx` so
 * they apply only to it.
 *
 * Add-only is enforced twice, in different places, for different reasons.
 * The scoped `memory_write` registered here shadows the global (replacing)
 * definition for this child alone (`ToolRegistry.get(name, scope)` resolves
 * the nearest scope's own registration first) and its `execute` passes
 * `ifAbsent: true`, so `MemoryStore.write` itself rejects a name that another
 * call already created between this call's `tools/pre-execute` check and its
 * own turn in the store's serialized write section — the operation that owns
 * the decision enforces it. The `tools/pre-execute` check below still runs
 * first, so an existing name gets the clear `REVIEW_DENY_OVERWRITE` reason
 * instead of the store's more general `already-exists` message.
 * @param agent - the published review child.
 * @param maxReviewSteps - reject `agent/pre-step` when `step` is greater than this value.
 * @param memory - the process store used to see whether a write name already exists.
 */
export function installReviewRestrictions(agent: Agent, maxReviewSteps: number, memory: MemoryStore): void {
  agent.ctx.tools.register(createMemoryWriteTool(memory, { ifAbsent: true }))
  agent.ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    if (exec.name === 'memory_recall') return decision
    if (exec.name === 'memory_forget') return { kind: 'deny', reason: REVIEW_DENY_OVERWRITE }
    if (exec.name === 'memory_write') {
      const target = reviewWriteTarget(exec.arguments)
      if (target === undefined) return { kind: 'deny', reason: REVIEW_DENY_OVERWRITE }
      const records = flattenVisible(await memory.visible(exec.agent?.session.header.cwd))
      if (records.some(record => record.name === target.name && record.scope === target.scope)) {
        return { kind: 'deny', reason: REVIEW_DENY_OVERWRITE }
      }
      return decision
    }
    return { kind: 'deny', reason: REVIEW_DENY_OTHER_TOOL }
  })
  agent.ctx.on('agent/pre-step', async ({ step }, next): Promise<PreStepDecision> => {
    if (step > maxReviewSteps) return { kind: 'reject' }
    return next()
  })
}
