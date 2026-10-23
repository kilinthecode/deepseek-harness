/** Shared `WorktreeRecord`/`WorktreeVerdict` builders for the worktree tool tests. */

import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorktreeId, WorktreeRecord, WorktreeVerdict } from '@deepseek-ai/dsh-subagent-worktree'

/** A realistic id, matching the service's `wt-` + eight lowercase hex digits shape. */
export const WORKTREE_ID = brandString<WorktreeId>('wt-1a2b3c4d')
/** A second realistic id, for tests that need to distinguish two records. */
export const OTHER_WORKTREE_ID = brandString<WorktreeId>('wt-5e6f7a8b')
export const COMMIT = '1234567890abcdef1234567890abcdef12345678'
export const MERGE_COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'

/** A complete `WorktreeRecord`, overridable per test. */
export function testRecord(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: WORKTREE_ID,
    repoRoot: '/repo',
    path: '/repo-worktrees/wt-1a2b3c4d',
    branch: 'dsh/worktree/wt-1a2b3c4d',
    baseCommit: '0000000000000000000000000000000000000000',
    owner: { kind: 'session', sessionId: SessionId('caller') },
    label: 'fix bug',
    task: 'fix the bug',
    state: 'open',
    createdAt: 0,
    workerSessionIds: [],
    workerRoute: { provider: 'worker-provider', model: 'worker-model' },
    ...overrides,
  }
}

/** A complete `WorktreeVerdict`, overridable per test. */
export function testVerdict(overrides: Partial<WorktreeVerdict> = {}): WorktreeVerdict {
  return {
    verdict: 'pass',
    summary: 'looks good',
    checks: [],
    findings: [],
    commit: COMMIT,
    reviewerSessionId: SessionId('reviewer'),
    reviewerRoute: { provider: 'test-provider', model: 'test-model' },
    at: 0,
    ...overrides,
  }
}
