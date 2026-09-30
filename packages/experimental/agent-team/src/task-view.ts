/** Pure task-view derivation shared by the task board and the client projection. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamState } from './projection.ts'
import type { TeamTaskSnapshot, TeamTaskView } from './types.ts'

/**
 * Whether two normalized file or directory prefixes overlap on path components.
 * @param left - normalized write scope.
 * @param right - normalized write scope.
 * @returns whether either scope contains the other.
 */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * Whether every current blocker of one task completed.
 * @param state - Team state supplying sibling tasks.
 * @param task - durable task snapshot to test.
 * @returns whether the task has no incomplete blockers.
 */
export function taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
  return task.blockedBy.every(id => state.tasks.find(candidate => candidate.id === id)?.status === 'completed')
}

/**
 * Whether one task is submitted and still waiting for a peer verdict.
 * @param task - durable task snapshot to test.
 * @returns whether the task carries a verification without a verdict.
 */
export function awaitingVerification(task: TeamTaskSnapshot): boolean {
  return task.verification !== undefined && task.verification.verdict === undefined
}

/**
 * Resolve one member id to its Team name, or `lead` for the Lead Session.
 * @param state - Team state supplying members.
 * @param id - member Session id, when one is recorded.
 * @returns the member name, or undefined when absent or unknown.
 */
function memberName(state: TeamState, id: SessionId | undefined): string | undefined {
  if (id === undefined) return undefined
  if (id === brandString<SessionId>(state.id)) return 'lead'
  return state.members.find(member => member.id === id)?.name
}

/**
 * Derive one task view with owner name, readiness, advisory write overlaps, and
 * the recorded peer verification. A submitted task without a verdict reports
 * status `verifying`.
 * A committing caller may pass its pre-append state because `task` supplies the
 * new value explicitly; owner names, blocker readiness, and other task scopes
 * do not change when that snapshot is appended.
 * @param state - Team state supplying members and sibling tasks.
 * @param task - durable task snapshot to view.
 * @returns a detached task view.
 */
export function projectTaskView(state: TeamState, task: TeamTaskSnapshot): TeamTaskView {
  const ownerName = memberName(state, task.ownerId)
  const warnings = new Set<string>()
  for (const other of state.tasks) {
    if (other.id === task.id || other.status !== 'in_progress') continue
    if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
      warnings.add(`write scopes overlap with ${other.id}`)
    }
  }
  const verification = task.verification
  const verifierName = memberName(state, verification?.verifierId)
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: awaitingVerification(task) ? 'verifying' : task.status,
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ...ownerName === undefined ? {} : { ownerName },
    ready: task.status === 'pending' && taskReady(state, task),
    writeScopeWarnings: [...warnings],
    ...verification === undefined ? {} : {
      verification: {
        submittedRevision: verification.submittedRevision,
        ...verifierName === undefined ? {} : { verifierName },
        ...verification.verdict === undefined ? {} : { verdict: verification.verdict },
        ...verification.reason === undefined ? {} : { reason: verification.reason },
      },
    },
  }
}
