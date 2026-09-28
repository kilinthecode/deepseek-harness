/**
 * `dsh agents accept`: commit, check, review, and merge one existing
 * worktree, without creating or starting anything.
 * @module @deepseek-ai/dsh-agents/accept
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorktreeId } from '@deepseek-ai/dsh-subagent-worktree'
import { performAccept } from './accept-cycle.ts'
import type { AgentsIo } from './io.ts'
import { createOperatorAgent, releaseOperatorAgent, resolveCwd } from './operator.ts'
import { required, resolveReviewerOverride, splitTestCommand } from './route.ts'
import type { AgentsStartupValues } from './startup.ts'

/**
 * Accept one existing worktree and exit `0` (merged) or `2` (every other
 * outcome). The operator Agent created here is only the reviewer's `parent`;
 * it never takes a model turn. It is flushed and released in a `finally`, on
 * both the success and the failure path (for example a bad worktree id or a
 * `resolveReviewer` rejection inside `accept`).
 * @param ctx - plugin context carrying `ctx.subagentWorktrees`, `ctx.subagents`, and `ctx.agentDefaultModel`.
 * @param config - the parsed `accept` verb values.
 * @param io - process-facing effects.
 */
export async function acceptVerb(ctx: Context, config: AgentsStartupValues, io: AgentsIo): Promise<void> {
  const id = brandString<WorktreeId>(required(config.id, 'agents-runner: accept config is missing its worktree id'))
  const reviewer = resolveReviewerOverride(config.reviewer, config.reviewerEffort)
  const cwd = await resolveCwd(ctx)
  const operatorRoute = ctx.agentDefaultModel.currentSelection()
  const handle = await createOperatorAgent(ctx, cwd, operatorRoute)
  try {
    const controller = new AbortController()
    const { exitCode } = await performAccept(ctx, {
      id,
      owner: { kind: 'operator' },
      parent: handle.agent,
      ...reviewer === undefined ? {} : { reviewer },
      ...config.test === undefined ? {} : { testCommand: splitTestCommand(config.test) },
      signal: controller.signal,
    }, io, config.json)
    io.exit(exitCode)
  } finally {
    await releaseOperatorAgent(ctx, handle)
  }
}
