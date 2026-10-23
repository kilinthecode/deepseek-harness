/**
 * The operator root Agent: a Session in the invoking directory, created the
 * same way `dsh-headless` creates its Agent, that never takes a model turn.
 * `run` and `accept` use it only as the delegating `parent` for worker,
 * fixer, and reviewer children.
 * @module @deepseek-ai/dsh-agents/operator
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorktreeRoute } from '@deepseek-ai/dsh-subagent-worktree'
import { toModelSelection } from './route.ts'

/**
 * Resolve the invoking directory through the mounted filesystem provider, or
 * the process directory when no filesystem service is mounted, matching
 * `dsh-headless`'s own resolution so a worktree's recorded `baseDir` agrees
 * with any other cwd-scoped composition in the same process.
 * @param ctx - plugin context optionally carrying the filesystem service.
 * @returns the absolute invoking directory.
 */
export async function resolveCwd(ctx: Context): Promise<string> {
  const fs = ctx.get('fs')
  return fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
}

/**
 * Create the operator's root Agent: a fresh Session in `cwd` on `route`,
 * never given a model turn. Its only uses are as the `parent` of delegated
 * worker, fixer, and reviewer children and as the caller route
 * {@link SubagentWorktrees.resolveReviewer} falls back to. The caller owns
 * the returned handle: flush the Session and call `dispose()` once every
 * delegated child has settled, on both the success and the failure path.
 * @param ctx - plugin context carrying the Agent registry.
 * @param cwd - the invoking directory, recorded as the Session's `cwd`.
 * @param route - the route the operator Agent is created with.
 * @returns the created Agent's handle.
 */
export async function createOperatorAgent(ctx: Context, cwd: string, route: WorktreeRoute): Promise<AgentHandle> {
  const agentOptions = toModelSelection(route)
  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: agentOptions, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
  return ctx.agents.create({
    sessionId,
    meta: { cwd },
    agentOptions,
    setup,
  })
}

/**
 * Flush the operator's Session and release its Agent handle. Call this from a
 * `finally` around the operator's whole delegated-child lifecycle so it runs
 * on both the success and the failure path.
 * @param ctx - plugin context carrying the Session store.
 * @param handle - the operator handle {@link createOperatorAgent} returned.
 */
export async function releaseOperatorAgent(ctx: Context, handle: AgentHandle): Promise<void> {
  await ctx.sessions.flush(handle.agent.session)
  await handle.dispose()
}
