/** The fix-round prompt sent to a fresh worker after a rejected review or a failing check command. */

import { describe, expect, it } from 'vitest'
import type { AcceptOutcome } from '@deepseek-ai/dsh-subagent-worktree'
import { renderFixerPrompt } from '../src/fixer.ts'

describe('renderFixerPrompt', () => {
  it('lists each finding and ends with the original task', () => {
    const outcome = {
      kind: 'rejected',
      record: {} as never,
      commit: 'c',
      verdict: { summary: 's', findings: ['file a: wrong return type', 'file b: missing test'] },
    } as unknown as Extract<AcceptOutcome, { kind: 'rejected' }>
    const prompt = renderFixerPrompt('add the parser', outcome)
    expect(prompt).toContain('Fix these problems in this worktree:')
    expect(prompt).toContain('- file a: wrong return type')
    expect(prompt).toContain('- file b: missing test')
    expect(prompt).toContain('Original task:\nadd the parser')
  })

  it('falls back to the verdict summary when a rejection carries no findings', () => {
    const outcome = {
      kind: 'rejected', record: {} as never, commit: 'c', verdict: { summary: 'the change is incomplete', findings: [] },
    } as unknown as Extract<AcceptOutcome, { kind: 'rejected' }>
    expect(renderFixerPrompt('task', outcome)).toContain('the change is incomplete')
  })

  it('names the failing command and its output for a checks-failed outcome', () => {
    const outcome = {
      kind: 'checks-failed', record: {} as never, commit: 'c', argv: ['pnpm', 'test'], exitCode: 1, output: 'FAIL packages/x',
    } as unknown as Extract<AcceptOutcome, { kind: 'checks-failed' }>
    const prompt = renderFixerPrompt('add the parser', outcome)
    expect(prompt).toContain('`pnpm test` exited 1:')
    expect(prompt).toContain('FAIL packages/x')
    expect(prompt).toContain('Original task:\nadd the parser')
  })
})
