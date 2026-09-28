/**
 * Pure schema/render coverage: every {@link AcceptOutcome} kind, the discard
 * and list projections, and the exact verbatim text each renders. No Context
 * is booted here; `tool-subagent-worktree.spec.ts` covers the tool wiring.
 */

import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AcceptOutcome, WorktreeId } from '@deepseek-ai/dsh-subagent-worktree'
import {
  renderAcceptToolValue,
  renderDiscardToolValue,
  renderListToolValue,
  toAcceptToolValue,
  toDiscardToolValue,
  toListToolValue,
} from '../src/values.ts'
import { COMMIT as commit, MERGE_COMMIT as mergeCommit, testRecord as baseRecord, testVerdict as baseVerdict, WORKTREE_ID as id } from './fixtures.ts'

describe('accept_worktree values', () => {
  it('declares the removed field and appends the removal notice only when true', () => {
    const removed: AcceptOutcome = {
      kind: 'merged',
      record: baseRecord({ state: 'merged' }),
      commit,
      mergeCommit,
      verdict: baseVerdict({ summary: 'looks good' }),
      removed: true,
    }
    const kept: AcceptOutcome = {
      kind: 'merged',
      record: baseRecord({ state: 'merged' }),
      commit,
      mergeCommit,
      verdict: baseVerdict({ summary: 'looks good' }),
      removed: false,
    }

    const removedValue = toAcceptToolValue(removed)
    expect(removedValue).toEqual({
      kind: 'merged',
      id,
      repoRoot: '/repo',
      commit,
      mergeCommit,
      reviewer: { provider: 'test-provider', model: 'test-model' },
      summary: 'looks good',
      removed: true,
    })
    expect(renderAcceptToolValue(removedValue)).toBe(
      'Merged worktree wt-1 into /repo: commit 1234567 as merge abcdef1. Reviewer test-provider/test-model passed it: '
      + 'looks good The worktree was removed; start a new child for further work.',
    )

    const keptValue = toAcceptToolValue(kept)
    expect(keptValue).toMatchObject({ removed: false })
    expect(renderAcceptToolValue(keptValue)).toBe(
      'Merged worktree wt-1 into /repo: commit 1234567 as merge abcdef1. Reviewer test-provider/test-model passed it: looks good',
    )
  })

  it('renders a rejected outcome with every finding and the resend instruction', () => {
    const outcome: AcceptOutcome = {
      kind: 'rejected',
      record: baseRecord(),
      commit,
      verdict: baseVerdict({ verdict: 'fail', summary: 'needs work', findings: ['fix the thing', 'fix another thing'] }),
    }
    const value = toAcceptToolValue(outcome)
    expect(value).toEqual({
      kind: 'rejected',
      id,
      commit,
      reviewer: { provider: 'test-provider', model: 'test-model' },
      summary: 'needs work',
      findings: ['fix the thing', 'fix another thing'],
    })
    expect(renderAcceptToolValue(value)).toBe(
      'Review failed for worktree wt-1 at commit 1234567 (reviewer test-provider/test-model): needs work\n'
      + 'Findings:\n- fix the thing\n- fix another thing\n'
      + 'Send these findings to the child with send_message, wait for it to finish, then accept again.',
    )
  })

  it('renders checks-failed with a numeric exit code and preserves argv/output', () => {
    const outcome: AcceptOutcome = {
      kind: 'checks-failed',
      record: baseRecord(),
      commit,
      argv: ['pnpm', 'test'],
      exitCode: 1,
      output: 'FAIL some-test',
    }
    const value = toAcceptToolValue(outcome)
    expect(value).toEqual({ kind: 'checks-failed', id, commit, argv: ['pnpm', 'test'], exitCode: 1, output: 'FAIL some-test' })
    expect(renderAcceptToolValue(value)).toBe(
      'Checks failed for worktree wt-1 at commit 1234567: `pnpm test` exited 1.\nFAIL some-test',
    )
  })

  it('omits exitCode from the value for a signal-killed check and renders "exited null"', () => {
    const outcome: AcceptOutcome = {
      kind: 'checks-failed',
      record: baseRecord(),
      commit,
      argv: ['pnpm', 'test'],
      exitCode: null,
      output: 'killed',
    }
    const value = toAcceptToolValue(outcome)
    expect(value).toEqual({ kind: 'checks-failed', id, commit, argv: ['pnpm', 'test'], output: 'killed' })
    expect('exitCode' in value).toBe(false)
    expect(renderAcceptToolValue(value)).toBe(
      'Checks failed for worktree wt-1 at commit 1234567: `pnpm test` exited null.\nkilled',
    )
  })

  it('renders a conflict outcome naming every conflicted file and the branch', () => {
    const outcome: AcceptOutcome = {
      kind: 'conflict',
      record: baseRecord({ branch: 'dsh/worktree/wt-1' }),
      commit,
      verdict: baseVerdict(),
      files: ['a.ts', 'b.ts'],
    }
    const value = toAcceptToolValue(outcome)
    expect(value).toEqual({ kind: 'conflict', id, commit, branch: 'dsh/worktree/wt-1', files: ['a.ts', 'b.ts'] })
    expect(renderAcceptToolValue(value)).toBe(
      'Worktree wt-1 passed review at commit 1234567 but conflicts with your checkout in: a.ts, b.ts. '
      + 'Nothing was merged. Merge branch dsh/worktree/wt-1 yourself and resolve the conflicts, or discard the worktree.',
    )
  })

  it('renders a blocked outcome with the git refusal reason', () => {
    const outcome: AcceptOutcome = {
      kind: 'blocked',
      record: baseRecord(),
      commit,
      verdict: baseVerdict(),
      reason: 'local changes would be overwritten',
    }
    const value = toAcceptToolValue(outcome)
    expect(value).toEqual({ kind: 'blocked', id, commit, reason: 'local changes would be overwritten' })
    expect(renderAcceptToolValue(value)).toBe(
      'Worktree wt-1 passed review at commit 1234567, but the merge could not start: local changes would be overwritten. '
      + 'Commit or set aside the conflicting changes in your checkout, then accept again.',
    )
  })

  it('renders an empty outcome', () => {
    const outcome: AcceptOutcome = { kind: 'empty', record: baseRecord() }
    const value = toAcceptToolValue(outcome)
    expect(value).toEqual({ kind: 'empty', id })
    expect(renderAcceptToolValue(value)).toBe('Worktree wt-1 has no changes to accept.')
  })
})

describe('discard_worktree values', () => {
  it('renders the discarded worktree id and branch', () => {
    const record = baseRecord({ state: 'discarded', branch: 'dsh/worktree/wt-1' })
    const value = toDiscardToolValue(record)
    expect(value).toEqual({ id, branch: 'dsh/worktree/wt-1' })
    expect(renderDiscardToolValue(value)).toBe('Discarded worktree wt-1 and branch dsh/worktree/wt-1.')
  })
})

describe('list_worktrees values', () => {
  it('renders the no-open-worktrees sentence for an empty list', () => {
    expect(toListToolValue([])).toEqual([])
    expect(renderListToolValue([])).toBe('No open worktrees.')
  })

  it('renders one line per record, falling back to "not reviewed" without a verdict', () => {
    const reviewed = baseRecord({
      id: brandString<WorktreeId>('wt-1'),
      state: 'open',
      branch: 'dsh/worktree/wt-1',
      label: 'fix bug',
      lastVerdict: baseVerdict({ verdict: 'pass' }),
    })
    const unreviewed = baseRecord({
      id: brandString<WorktreeId>('wt-2'),
      state: 'reviewing',
      branch: 'dsh/worktree/wt-2',
      label: 'add feature',
    })
    const value = toListToolValue([reviewed, unreviewed])
    expect(value).toEqual([
      { id: 'wt-1', state: 'open', branch: 'dsh/worktree/wt-1', label: 'fix bug', verdict: 'pass' },
      { id: 'wt-2', state: 'reviewing', branch: 'dsh/worktree/wt-2', label: 'add feature' },
    ])
    expect(renderListToolValue(value)).toBe(
      'wt-1  open  dsh/worktree/wt-1  fix bug  pass\n'
      + 'wt-2  reviewing  dsh/worktree/wt-2  add feature  not reviewed',
    )
  })
})
