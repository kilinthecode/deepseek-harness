/**
 * `dsh agents list`: the repository's worktrees from the operator's cwd, in
 * every owner's view.
 * @module @deepseek-ai/dsh-agents/list
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent-worktree'
import type { AgentsIo } from './io.ts'
import { resolveCwd } from './operator.ts'
import { listEvent, listLine } from './render.ts'
import type { AgentsStartupValues } from './startup.ts'

/**
 * List the repository's worktrees and exit `0`. Never fails on an empty
 * result: an empty repository is not an error.
 * @param ctx - plugin context carrying `ctx.subagentWorktrees` and, optionally, `ctx.fs`.
 * @param config - the parsed `list` verb values.
 * @param io - process-facing effects.
 */
export async function listVerb(ctx: Context, config: AgentsStartupValues, io: AgentsIo): Promise<void> {
  const baseDir = await resolveCwd(ctx)
  const records = await ctx.subagentWorktrees.list({ baseDir, includeClosed: config.all === true })
  if (config.json) {
    for (const record of records) io.stdout.write(`${JSON.stringify(listEvent(record))}\n`)
  } else if (records.length === 0) {
    io.stdout.write(config.all === true ? 'No worktrees.\n' : 'No open worktrees.\n')
  } else {
    for (const record of records) io.stdout.write(`${listLine(record)}\n`)
  }
  io.exit(0)
}
