/**
 * Bundled `agent-crew` skill provider.
 *
 * @module @deepseek-ai/dsh-skill-agent-crew
 */

import type { Context } from '@deepseek-ai/cordis'
import { bundledSkillProvider } from '@deepseek-ai/dsh-skill'

const provider = bundledSkillProvider({
  name: 'agent-crew',
  description: 'Split a goal across worker agents that each work in their own git worktree, with an independent reviewer checking every change before it merges. Use for work with two or more separable parts or when a change needs independent verification; skip it for small single-step edits.',
  body: new URL('../assets/agent-crew.md', import.meta.url),
  resources: new URL('../assets/', import.meta.url),
})

/** Cordis plugin name. */
export const name = 'skill-agent-crew'
/** Service required by the bundled provider. */
export const inject = ['skills']

/** Register the bundled `agent-crew` provider on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
