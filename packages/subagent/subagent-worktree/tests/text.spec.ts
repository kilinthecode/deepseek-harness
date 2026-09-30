import { describe, expect, it } from 'vitest'
import { renderReviewerPrompt, renderWorkerBrief, VERDICT_SCHEMA } from '../src/text.ts'

describe('renderWorkerBrief', () => {
  it('names the worktree facts and ends with a blank line before the task', () => {
    const brief = renderWorkerBrief({
      workDir: '/worktrees/repo/wt-1', branch: 'dsh/worktree/wt-1', baseCommit: 'a'.repeat(40), repoRoot: '/repo',
    })
    expect(brief).toContain('/worktrees/repo/wt-1')
    expect(brief).toContain('dsh/worktree/wt-1')
    expect(brief).toContain('a'.repeat(40))
    expect(brief).toContain('/repo')
    expect(brief.endsWith('\n\n')).toBe(true)
  })

  it('tells the worker not to run the commands that write to git, listing them', () => {
    const brief = renderWorkerBrief({
      workDir: '/worktrees/repo/wt-1', branch: 'dsh/worktree/wt-1', baseCommit: 'a'.repeat(40), repoRoot: '/repo',
    })
    expect(brief).toContain('Do not run git commands that write (commit, add, checkout, switch, restore, reset, stash, rebase, merge, worktree)')
  })
})

describe('renderReviewerPrompt', () => {
  it('names the review checkout, commit range, and task, with no truncation notice by default', () => {
    const prompt = renderReviewerPrompt({
      reviewDir: '/reviews/wt-1-1', commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), task: 'do the thing',
      diff: 'diff --git a/x b/x', diffTruncated: false,
    })
    expect(prompt).toContain('/reviews/wt-1-1')
    expect(prompt).toContain('c'.repeat(40))
    expect(prompt).toContain('b'.repeat(40))
    expect(prompt).toContain('do the thing')
    expect(prompt).toContain('diff --git a/x b/x')
    expect(prompt).not.toContain('[diff truncated')
  })

  it('appends a truncation notice naming the exact git diff command when diffTruncated', () => {
    const prompt = renderReviewerPrompt({
      reviewDir: '/reviews/wt-1-1', commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), task: 'do the thing',
      diff: 'partial', diffTruncated: true,
    })
    expect(prompt).toContain(`[diff truncated; read the remaining changes with \`git diff ${'b'.repeat(40)}..${'c'.repeat(40)}\`]`)
  })
})

describe('VERDICT_SCHEMA', () => {
  it('requires verdict, summary, checks, and findings, and forbids extra properties', () => {
    expect(VERDICT_SCHEMA.required).toEqual(['verdict', 'summary', 'checks', 'findings'])
    expect(VERDICT_SCHEMA.additionalProperties).toBe(false)
    expect(Object.keys(VERDICT_SCHEMA.properties ?? {})).toEqual(['verdict', 'summary', 'checks', 'findings'])
  })
})
