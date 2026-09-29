/**
 * Pure schema/render coverage: every {@link AcceptOutcome} kind, the discard
 * and list projections, the exact verbatim text each renders, and that each
 * projected value actually satisfies its declared schema. No Context is
 * booted here; `tool-subagent-worktree.spec.ts` covers the tool wiring.
 */

import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptOutcome, WorktreeId } from '@deepseek-ai/dsh-subagent-worktree'
import { validateJsonSchemaValue, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  ACCEPT_VALUE_SCHEMA,
  DISCARD_VALUE_SCHEMA,
  LIST_VALUE_SCHEMA,
  renderAcceptToolValue,
  renderDiscardToolValue,
  renderListToolValue,
  toAcceptToolValue,
  toDiscardToolValue,
  toListToolValue,
} from '../src/values.ts'
import {
  COMMIT as commit,
  MERGE_COMMIT as mergeCommit,
  OTHER_WORKTREE_ID as otherId,
  testRecord as baseRecord,
  testVerdict as baseVerdict,
  WORKTREE_ID as id,
} from './fixtures.ts'

describe('accept_worktree values', () => {
  it('declares the removed field, terminates the summary sentence, and appends the removal notice only when true', () => {
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
      `Merged worktree ${id} into /repo: commit ${commit} as merge ${mergeCommit}. Reviewer test-provider/test-model passed it: `
      + 'looks good. The worktree was removed; start a new child for further work.',
    )

    const keptValue = toAcceptToolValue(kept)
    expect(keptValue).toMatchObject({ removed: false })
    expect(renderAcceptToolValue(keptValue)).toBe(
      `Merged worktree ${id} into /repo: commit ${commit} as merge ${mergeCommit}. Reviewer test-provider/test-model passed it: looks good.`,
    )
  })

  it('does not double a summary that already ends with terminal punctuation', () => {
    const outcome: AcceptOutcome = {
      kind: 'merged',
      record: baseRecord({ state: 'merged' }),
      commit,
      mergeCommit,
      verdict: baseVerdict({ summary: 'Verified the fix works!' }),
      removed: false,
    }
    const value = toAcceptToolValue(outcome)
    expect(renderAcceptToolValue(value)).toBe(
      `Merged worktree ${id} into /repo: commit ${commit} as merge ${mergeCommit}. Reviewer test-provider/test-model passed it: Verified the fix works!`,
    )
  })

  it('renders a rejected outcome with every finding and a fix path for both background and foreground children', () => {
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
      `Review failed for worktree ${id} at commit ${commit} (reviewer test-provider/test-model): needs work\n`
      + 'Findings:\n- fix the thing\n- fix another thing\n'
      + 'If the child is a background subagent, send these findings to it with send_message, wait for it to finish, then accept again. '
      + 'A foreground child cannot receive messages: discard the worktree and start a new background worker with the task and these findings.',
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
      `Checks failed for worktree ${id} at commit ${commit}: \`pnpm test\` exited 1.\nFAIL some-test`,
    )
  })

  it('quotes an argv element containing whitespace so the command can be reproduced', () => {
    const outcome: AcceptOutcome = {
      kind: 'checks-failed',
      record: baseRecord(),
      commit,
      argv: ['git', 'commit', '-m', 'fix the parser'],
      exitCode: 1,
      output: 'nothing to commit',
    }
    const value = toAcceptToolValue(outcome)
    expect(value).toMatchObject({ argv: ['git', 'commit', '-m', 'fix the parser'] })
    expect(renderAcceptToolValue(value)).toBe(
      `Checks failed for worktree ${id} at commit ${commit}: \`git commit -m "fix the parser"\` exited 1.\nnothing to commit`,
    )
  })

  it('omits exitCode from the value for a signal-killed check and renders that it was stopped', () => {
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
      `Checks failed for worktree ${id} at commit ${commit}: \`pnpm test\` was stopped before it exited.\nkilled`,
    )
  })

  it('renders a conflict outcome naming every conflicted file and the branch', () => {
    const outcome: AcceptOutcome = {
      kind: 'conflict',
      record: baseRecord({ branch: 'dsh/worktree/wt-1a2b3c4d' }),
      commit,
      verdict: baseVerdict(),
      files: ['a.ts', 'b.ts'],
    }
    const value = toAcceptToolValue(outcome)
    expect(value).toEqual({ kind: 'conflict', id, commit, branch: 'dsh/worktree/wt-1a2b3c4d', files: ['a.ts', 'b.ts'] })
    expect(renderAcceptToolValue(value)).toBe(
      `Worktree ${id} passed review at commit ${commit} but conflicts with your checkout in: a.ts, b.ts. `
      + 'Nothing was merged. Merge branch dsh/worktree/wt-1a2b3c4d yourself and resolve the conflicts, or discard the worktree.',
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
      `Worktree ${id} passed review at commit ${commit}, but the merge could not start: local changes would be overwritten. `
      + 'Commit or set aside the conflicting changes in your checkout, then accept again.',
    )
  })

  it('renders an empty outcome', () => {
    const outcome: AcceptOutcome = { kind: 'empty', record: baseRecord() }
    const value = toAcceptToolValue(outcome)
    expect(value).toEqual({ kind: 'empty', id })
    expect(renderAcceptToolValue(value)).toBe(`Worktree ${id} has no changes to accept.`)
  })
})

describe('discard_worktree values', () => {
  it('renders the discarded worktree id and branch', () => {
    const record = baseRecord({ state: 'discarded', branch: 'dsh/worktree/wt-1a2b3c4d' })
    const value = toDiscardToolValue(record)
    expect(value).toEqual({ id, branch: 'dsh/worktree/wt-1a2b3c4d' })
    expect(renderDiscardToolValue(value)).toBe(`Discarded worktree ${id} and branch dsh/worktree/wt-1a2b3c4d.`)
  })
})

describe('list_worktrees values', () => {
  it('renders the no-open-worktrees sentence for an empty list', () => {
    expect(toListToolValue([])).toEqual([])
    expect(renderListToolValue([])).toBe('No open worktrees.')
  })

  it('renders one labeled line per record, covering pass, fail, and not-reviewed', () => {
    const thirdId = brandString<WorktreeId>('wt-9c8d7e6f')
    const passed = baseRecord({
      id,
      state: 'open',
      branch: 'dsh/worktree/wt-1a2b3c4d',
      path: '/repo-worktrees/wt-1a2b3c4d',
      label: 'fix bug',
      workerSessionIds: [SessionId('worker-a')],
      lastVerdict: baseVerdict({ verdict: 'pass' }),
    })
    const failed = baseRecord({
      id: otherId,
      state: 'reviewing',
      branch: 'dsh/worktree/wt-5e6f7a8b',
      path: '/repo-worktrees/wt-5e6f7a8b',
      label: 'add feature',
      workerSessionIds: [SessionId('worker-b')],
      lastVerdict: baseVerdict({ verdict: 'fail' }),
    })
    const unreviewed = baseRecord({
      id: thirdId,
      state: 'open',
      branch: 'dsh/worktree/wt-9c8d7e6f',
      path: '/repo-worktrees/wt-9c8d7e6f',
      label: 'new part',
      workerSessionIds: [SessionId('worker-c')],
    })
    const value = toListToolValue([passed, failed, unreviewed])
    expect(value).toEqual([
      { id, state: 'open', branch: 'dsh/worktree/wt-1a2b3c4d', path: '/repo-worktrees/wt-1a2b3c4d', label: 'fix bug', workerAgentId: 'worker-a', verdict: 'pass' },
      { id: otherId, state: 'reviewing', branch: 'dsh/worktree/wt-5e6f7a8b', path: '/repo-worktrees/wt-5e6f7a8b', label: 'add feature', workerAgentId: 'worker-b', verdict: 'fail' },
      { id: thirdId, state: 'open', branch: 'dsh/worktree/wt-9c8d7e6f', path: '/repo-worktrees/wt-9c8d7e6f', label: 'new part', workerAgentId: 'worker-c' },
    ])
    expect(renderListToolValue(value)).toBe(
      `${id}  state=open  branch=dsh/worktree/wt-1a2b3c4d  path=/repo-worktrees/wt-1a2b3c4d  worker=worker-a  review=pass  label="fix bug"\n`
      + `${otherId}  state=reviewing  branch=dsh/worktree/wt-5e6f7a8b  path=/repo-worktrees/wt-5e6f7a8b  worker=worker-b  review=fail  label="add feature"\n`
      + `${thirdId}  state=open  branch=dsh/worktree/wt-9c8d7e6f  path=/repo-worktrees/wt-9c8d7e6f  worker=worker-c  review=not reviewed  label="new part"`,
    )
  })

  it('names the most recently attached worker, so a caller that lost its context can message it', () => {
    const value = toListToolValue([baseRecord({ workerSessionIds: [SessionId('first-worker'), SessionId('fixer')] })])
    expect(value).toEqual([expect.objectContaining({ workerAgentId: 'fixer' })])
    expect(renderListToolValue(value)).toContain('  worker=fixer  ')
  })

  it('omits the worker from the value and renders none when no worker was recorded', () => {
    const value = toListToolValue([baseRecord({ workerSessionIds: [] })])
    expect(value[0]).not.toHaveProperty('workerAgentId')
    expect(renderListToolValue(value)).toContain('  worker=none  ')
  })

  it('quotes a worktree path that contains whitespace and leaves a plain path bare', () => {
    const spaced = toListToolValue([baseRecord({ path: '/home/a b/.dsh/worktrees/wt-1a2b3c4d' })])
    expect(renderListToolValue(spaced)).toContain('  path="/home/a b/.dsh/worktrees/wt-1a2b3c4d"  ')
    const plain = toListToolValue([baseRecord({ path: '/repo-worktrees/wt-1a2b3c4d' })])
    expect(renderListToolValue(plain)).toContain('  path=/repo-worktrees/wt-1a2b3c4d  ')
  })
})

describe('declared schema validation', () => {
  const acceptSchema = valueSchemaSpecToJsonSchema(ACCEPT_VALUE_SCHEMA)
  const discardSchema = valueSchemaSpecToJsonSchema(DISCARD_VALUE_SCHEMA)
  const listSchema = valueSchemaSpecToJsonSchema(LIST_VALUE_SCHEMA)

  const acceptOutcomes: ReadonlyArray<{ readonly name: string; readonly outcome: AcceptOutcome }> = [
    { name: 'merged', outcome: { kind: 'merged', record: baseRecord({ state: 'merged' }), commit, mergeCommit, verdict: baseVerdict(), removed: true } },
    { name: 'rejected', outcome: { kind: 'rejected', record: baseRecord(), commit, verdict: baseVerdict({ verdict: 'fail', findings: ['fix it'] }) } },
    { name: 'checks-failed (numeric exit code)', outcome: { kind: 'checks-failed', record: baseRecord(), commit, argv: ['pnpm', 'test'], exitCode: 1, output: 'FAIL' } },
    { name: 'checks-failed (signal-killed)', outcome: { kind: 'checks-failed', record: baseRecord(), commit, argv: ['pnpm', 'test'], exitCode: null, output: 'killed' } },
    { name: 'conflict', outcome: { kind: 'conflict', record: baseRecord(), commit, verdict: baseVerdict(), files: ['a.ts'] } },
    { name: 'blocked', outcome: { kind: 'blocked', record: baseRecord(), commit, verdict: baseVerdict(), reason: 'dirty checkout' } },
    { name: 'empty', outcome: { kind: 'empty', record: baseRecord() } },
  ]

  it.each(acceptOutcomes)('accept_worktree "$name" value satisfies ACCEPT_VALUE_SCHEMA', ({ outcome }) => {
    const value = toAcceptToolValue(outcome)
    expect(validateJsonSchemaValue(acceptSchema, value)).toEqual([])
  })

  it('discard_worktree value satisfies DISCARD_VALUE_SCHEMA', () => {
    const value = toDiscardToolValue(baseRecord({ state: 'discarded' }))
    expect(validateJsonSchemaValue(discardSchema, value)).toEqual([])
  })

  it('list_worktrees value satisfies LIST_VALUE_SCHEMA, with and without a verdict or a worker', () => {
    const reviewed = baseRecord({ workerSessionIds: [SessionId('worker-a')], lastVerdict: baseVerdict({ verdict: 'fail' }) })
    const unreviewed = baseRecord({ id: otherId, workerSessionIds: [SessionId('worker-b')] })
    const withoutWorker = baseRecord({ id: brandString<WorktreeId>('wt-9c8d7e6f'), workerSessionIds: [] })
    const value = toListToolValue([reviewed, unreviewed, withoutWorker])
    expect(value.map(row => 'workerAgentId' in row)).toEqual([true, true, false])
    expect(validateJsonSchemaValue(listSchema, value)).toEqual([])
  })

  it('LIST_VALUE_SCHEMA requires the worktree path on every row', () => {
    const { path: _path, ...withoutPath } = toListToolValue([baseRecord()])[0]!
    expect(validateJsonSchemaValue(listSchema, [withoutPath]).length).toBeGreaterThan(0)
  })
})
