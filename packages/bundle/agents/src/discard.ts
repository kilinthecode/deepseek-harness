/**
 * `dsh agents discard`: delete one worktree and its branch without merging.
 * @module @deepseek-ai/dsh-agents/discard
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorktreeId } from '@deepseek-ai/dsh-subagent-worktree'
import type { AgentsIo } from './io.ts'
import { writeLine } from './io.ts'
import { discardEvent, discardLine } from './render.ts'
import { required } from './route.ts'
import type { AgentsStartupValues } from './startup.ts'

/**
 * Discard one worktree and exit `0`, or propagate the service's rejection
 * (for example an attached worker still running, or a terminal state) for the
 * caller's generic error handling.
 * @param ctx - plugin context carrying `ctx.subagentWorktrees`.
 * @param config - the parsed `discard` verb values.
 * @param io - process-facing effects.
 */
export async function discardVerb(ctx: Context, config: AgentsStartupValues, io: AgentsIo): Promise<void> {
  const id = brandString<WorktreeId>(required(config.id, 'agents-runner: discard config is missing its worktree id'))
  const controller = new AbortController()
  const record = await ctx.subagentWorktrees.discard({ id, owner: { kind: 'operator' }, signal: controller.signal })
  writeLine(io, config.json, discardEvent(record.id, record.branch), discardLine(record.id, record.branch))
  io.exit(0)
}
