/**
 * The shared accept step: `run`'s fix-round loop and the standalone `accept`
 * verb both call {@link SubagentWorktrees.accept} once and report its result
 * the same way.
 * @module @deepseek-ai/dsh-agents/accept-cycle
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent-worktree'
import type { AcceptOutcome, AcceptWorktreeRequest } from '@deepseek-ai/dsh-subagent-worktree'
import type { AgentsIo } from './io.ts'
import { writeLine } from './io.ts'
import { exitCodeForOutcome, outcomeEvent, outcomeLine, outcomeVerdict, reviewEvent, reviewLine } from './render.ts'

/** One accept call's settled outcome and the exit code it maps to. */
export interface AcceptCycleResult {
  readonly outcome: AcceptOutcome
  readonly exitCode: 0 | 2
}

/**
 * Commit, check, review, and merge (or not) one worktree, reporting the
 * reviewer's verdict (when one ran) and the outcome on `io`.
 * @param ctx - plugin context carrying `ctx.subagentWorktrees`.
 * @param request - the accept request.
 * @param io - process-facing effects.
 * @param json - whether this invocation asked for the machine-readable stream.
 * @returns the settled outcome and its exit code.
 */
export async function performAccept(
  ctx: Context,
  request: AcceptWorktreeRequest,
  io: AgentsIo,
  json: boolean,
): Promise<AcceptCycleResult> {
  const outcome = await ctx.subagentWorktrees.accept(request)
  const verdict = outcomeVerdict(outcome)
  if (verdict !== undefined) writeLine(io, json, reviewEvent(verdict), reviewLine(verdict))
  writeLine(io, json, outcomeEvent(outcome), outcomeLine(outcome))
  return { outcome, exitCode: exitCodeForOutcome(outcome) }
}
