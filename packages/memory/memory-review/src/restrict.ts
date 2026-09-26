/**
 * Child-only tool and step restrictions for an unattended memory review.
 * @module @deepseek-ai/dsh-memory-review/src/restrict
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { MemoryRecord, MemoryScope, MemoryStore, MemoryVisible } from '@deepseek-ai/dsh-memory'
import { MEMORY_SCOPES } from '@deepseek-ai/dsh-memory'
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
 * Listeners are registered on that child's own `ctx` so they apply only to it.
 * @param agent - the published review child.
 * @param maxReviewSteps - reject `agent/pre-step` when `step` is greater than this value.
 * @param memory - the process store used to see whether a write name already exists.
 */
export function installReviewRestrictions(agent: Agent, maxReviewSteps: number, memory: MemoryStore): void {
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
