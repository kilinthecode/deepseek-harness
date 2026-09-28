/** Attached-worker liveness check shared by `accept` and `discard`. */

import type AgentRegistry from '@deepseek-ai/dsh-agent'
import type { WorktreeId, WorktreeRecord } from './types.ts'

/**
 * Refuse when any attached worker's live Agent is still running. A worker
 * absent from the live registry — never started in this process, or already
 * disposed — does not block: only a currently-driving turn does. Call it
 * inside the record lock's updater so the check and the state transition it
 * guards cannot be separated by a worker restarting in between.
 * @param agents - the live Agent registry; only `get` is read.
 * @param record - the record whose attached workers are checked.
 * @param id - the worktree id, named in the thrown message.
 * @throws when an attached worker's Agent has `status === 'running'`.
 */
export function assertNoRunningWorkers(
  agents: Pick<AgentRegistry, 'get'>, record: Pick<WorktreeRecord, 'workerSessionIds'>, id: WorktreeId,
): void {
  for (const sessionId of record.workerSessionIds) {
    if (agents.get(sessionId)?.status === 'running') {
      throw new Error(`subagent-worktree: worker ${sessionId} of worktree ${id} is still running; wait for it to finish`)
    }
  }
}
