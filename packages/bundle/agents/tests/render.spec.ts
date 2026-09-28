/** Human text and `--json` event payloads for every worktree, worker, review, and outcome shape. */

import { describe, expect, it } from 'vitest'
import type { AcceptOutcome, WorktreeVerdict } from '@deepseek-ai/dsh-subagent-worktree'
import {
  discardEvent,
  discardLine,
  errorEvent,
  errorLine,
  exitCodeForOutcome,
  isFixable,
  listEvent,
  listLine,
  outcomeEvent,
  outcomeLine,
  outcomeVerdict,
  reviewEvent,
  reviewLine,
  workerEvent,
  workerLine,
  worktreeEvent,
  worktreeLine,
} from '../src/render.ts'

const record = { id: 'wt-aaaaaaaa' as never, path: '/worktrees/wt-aaaaaaaa', branch: 'dsh/worktree/wt-aaaaaaaa', baseCommit: '0123456789abcdef' }

const verdict: WorktreeVerdict = {
  verdict: 'pass',
  summary: 'looks correct',
  checks: ['pnpm test: pass'],
  findings: [],
  commit: 'abcdef0123456789',
  reviewerSessionId: 'session-reviewer' as never,
  reviewerRoute: { provider: 'anthropic', model: 'opus' },
  at: 0,
}

describe('worktreeEvent / worktreeLine', () => {
  it('reports a freshly created worktree without baseDirty', () => {
    expect(worktreeEvent(record, false)).toEqual({
      type: 'worktree', id: record.id, path: record.path, branch: record.branch, baseCommit: record.baseCommit, reused: false,
    })
    expect(worktreeLine(record, false)).toBe(
      `Created worktree ${record.id} at ${record.path} (branch ${record.branch}, base 0123456).`,
    )
  })

  it('reports a reused worktree', () => {
    expect(worktreeEvent(record, true).reused).toBe(true)
    expect(worktreeLine(record, true)).toContain('Reusing worktree')
  })

  it('appends the dirty-checkout note when baseDirty is present', () => {
    const dirty = { entries: [' M a.ts'], total: 3 }
    expect(worktreeEvent(record, false, dirty)).toMatchObject({ baseDirty: dirty })
    expect(worktreeLine(record, false, dirty)).toContain('Your checkout has 3 uncommitted change(s) that the worktree does not contain.')
  })
})

describe('workerEvent / workerLine', () => {
  it('reports the settled worker', () => {
    const route = { provider: 'p', model: 'm' }
    expect(workerEvent('session-1', route, 'completed')).toEqual({ type: 'worker', sessionId: 'session-1', route, stopReason: 'completed' })
    expect(workerLine('session-1', route, 'completed')).toBe('Worker session-1 (p/m) finished: completed.')
  })
})

describe('reviewEvent / reviewLine', () => {
  it('reports the reviewer verdict', () => {
    expect(reviewEvent(verdict)).toEqual({
      type: 'review', verdict: 'pass', commit: verdict.commit, reviewer: 'anthropic/opus', summary: verdict.summary, findings: [],
    })
    expect(reviewLine(verdict)).toBe('Reviewer anthropic/opus at abcdef0: pass — looks correct')
  })
})

describe('outcomeVerdict', () => {
  it('extracts the verdict from every kind that carries one', () => {
    const merged: AcceptOutcome = { kind: 'merged', record: record as never, commit: 'c', mergeCommit: 'm', verdict, removed: false }
    const rejected: AcceptOutcome = { kind: 'rejected', record: record as never, commit: 'c', verdict }
    const conflict: AcceptOutcome = { kind: 'conflict', record: record as never, commit: 'c', verdict, files: [] }
    const blocked: AcceptOutcome = { kind: 'blocked', record: record as never, commit: 'c', verdict, reason: 'r' }
    for (const outcome of [merged, rejected, conflict, blocked]) expect(outcomeVerdict(outcome)).toBe(verdict)
  })

  it('is undefined for checks-failed and empty', () => {
    const checksFailed: AcceptOutcome = { kind: 'checks-failed', record: record as never, commit: 'c', argv: ['x'], exitCode: 1, output: '' }
    const empty: AcceptOutcome = { kind: 'empty', record: record as never }
    expect(outcomeVerdict(checksFailed)).toBeUndefined()
    expect(outcomeVerdict(empty)).toBeUndefined()
  })
})

describe('outcomeEvent / outcomeLine', () => {
  it('renders merged, noting removal only when removed', () => {
    const merged: AcceptOutcome = { kind: 'merged', record: record as never, commit: 'commit1234567', mergeCommit: 'merge1234567', verdict, removed: true }
    expect(outcomeEvent(merged)).toEqual({ type: 'outcome', kind: 'merged', id: record.id, commit: 'commit1234567', mergeCommit: 'merge1234567', removed: true })
    expect(outcomeLine(merged)).toBe(`Merged worktree ${record.id}: commit commit1 as merge merge12. The worktree was removed; start a new one for further work.`)
    expect(outcomeLine(merged)).toContain('The worktree was removed')

    const keptOpen: AcceptOutcome = { ...merged, removed: false }
    expect(outcomeLine(keptOpen)).not.toContain('removed')
  })

  it('renders rejected with its findings', () => {
    const rejected: AcceptOutcome = {
      kind: 'rejected', record: record as never, commit: 'commit1234567',
      verdict: { ...verdict, verdict: 'fail', findings: ['finding one', 'finding two'] },
    }
    expect(outcomeEvent(rejected)).toEqual({
      type: 'outcome', kind: 'rejected', id: record.id, commit: 'commit1234567', summary: verdict.summary, findings: ['finding one', 'finding two'],
    })
    const line = outcomeLine(rejected)
    expect(line).toContain('Review failed for worktree')
    expect(line).toContain('- finding one')
    expect(line).toContain('- finding two')
  })

  it('reports "none reported" for a rejected outcome with no findings', () => {
    const rejected: AcceptOutcome = { kind: 'rejected', record: record as never, commit: 'c', verdict: { ...verdict, verdict: 'fail', findings: [] } }
    expect(outcomeLine(rejected)).toContain('Findings: none reported.')
  })

  it('renders checks-failed with argv, exit code, and output', () => {
    const outcome: AcceptOutcome = { kind: 'checks-failed', record: record as never, commit: 'commit1234567', argv: ['pnpm', 'test'], exitCode: 1, output: 'FAIL' }
    expect(outcomeEvent(outcome)).toEqual({ type: 'outcome', kind: 'checks-failed', id: record.id, commit: 'commit1234567', argv: ['pnpm', 'test'], exitCode: 1, output: 'FAIL' })
    const line = outcomeLine(outcome)
    expect(line).toContain('`pnpm test` exited 1')
    expect(line).toContain('FAIL')
  })

  it('renders conflict with the conflicted files', () => {
    const outcome: AcceptOutcome = { kind: 'conflict', record: record as never, commit: 'commit1234567', verdict, files: ['a.ts', 'b.ts'] }
    expect(outcomeEvent(outcome)).toEqual({ type: 'outcome', kind: 'conflict', id: record.id, commit: 'commit1234567', files: ['a.ts', 'b.ts'] })
    expect(outcomeLine(outcome)).toContain('conflicts with your checkout in: a.ts, b.ts')
  })

  it('renders blocked with the reason', () => {
    const outcome: AcceptOutcome = { kind: 'blocked', record: record as never, commit: 'commit1234567', verdict, reason: 'local changes would be overwritten' }
    expect(outcomeEvent(outcome)).toEqual({ type: 'outcome', kind: 'blocked', id: record.id, commit: 'commit1234567', reason: outcome.reason })
    expect(outcomeLine(outcome)).toContain('local changes would be overwritten')
  })

  it('renders empty with just the id', () => {
    const outcome: AcceptOutcome = { kind: 'empty', record: record as never }
    expect(outcomeEvent(outcome)).toEqual({ type: 'outcome', kind: 'empty', id: record.id })
    expect(outcomeLine(outcome)).toBe(`Worktree ${record.id} has no changes to accept.`)
  })

  it('rejects an outcome kind outside the closed union', () => {
    const bogus = { kind: 'bogus' } as unknown as AcceptOutcome
    expect(() => outcomeEvent(bogus)).toThrow('unknown accept outcome kind')
    expect(() => outcomeLine(bogus)).toThrow('unknown accept outcome kind')
  })
})

describe('discardEvent / discardLine', () => {
  it('reports the discarded worktree and branch', () => {
    expect(discardEvent('wt-1', 'dsh/worktree/wt-1')).toEqual({ type: 'outcome', kind: 'discarded', id: 'wt-1', branch: 'dsh/worktree/wt-1' })
    expect(discardLine('wt-1', 'dsh/worktree/wt-1')).toBe('Discarded worktree wt-1 and branch dsh/worktree/wt-1.')
  })
})

describe('errorEvent / errorLine', () => {
  it('carries the message through both forms', () => {
    expect(errorEvent('boom')).toEqual({ type: 'error', message: 'boom' })
    expect(errorLine('boom')).toBe('dsh: boom')
  })
})

describe('listLine / listEvent', () => {
  const fullRecord = { ...record, state: 'open', label: 'add the parser', lastVerdict: undefined }

  it('reports "not reviewed" when no verdict was recorded', () => {
    expect(listLine(fullRecord as never)).toBe(`${record.id}  open  ${record.branch}  add the parser  not reviewed`)
    expect(listEvent(fullRecord as never)).toEqual({
      type: 'worktree', id: record.id, path: record.path, branch: record.branch, baseCommit: record.baseCommit, state: 'open', label: 'add the parser',
    })
  })

  it('reports the latest verdict when one was recorded', () => {
    const reviewed = { ...fullRecord, lastVerdict: verdict }
    expect(listLine(reviewed as never)).toContain('pass')
    expect(listEvent(reviewed as never)).toMatchObject({ verdict: 'pass' })
  })
})

describe('exitCodeForOutcome', () => {
  it('is 0 only for merged, 2 for every other kind', () => {
    expect(exitCodeForOutcome({ kind: 'merged' } as never)).toBe(0)
    for (const kind of ['rejected', 'checks-failed', 'conflict', 'blocked', 'empty']) {
      expect(exitCodeForOutcome({ kind } as never)).toBe(2)
    }
  })
})

describe('isFixable', () => {
  it('is true only for rejected and checks-failed', () => {
    expect(isFixable({ kind: 'rejected' } as never)).toBe(true)
    expect(isFixable({ kind: 'checks-failed' } as never)).toBe(true)
    for (const kind of ['merged', 'conflict', 'blocked', 'empty']) {
      expect(isFixable({ kind } as never)).toBe(false)
    }
  })
})
