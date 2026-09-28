/** `dsh agents accept`: commit, check, review, and merge one existing worktree. */

import { describe, expect, it } from 'vitest'
import type { AcceptOutcome, WorktreeRecord, WorktreeVerdict } from '@deepseek-ai/dsh-subagent-worktree'
import { bench } from './harness.ts'

const record: WorktreeRecord = {
  id: 'wt-aaaaaaaa' as never,
  repoRoot: '/repo',
  path: '/worktrees/wt-aaaaaaaa',
  branch: 'dsh/worktree/wt-aaaaaaaa',
  baseCommit: '0123456789abcdef',
  owner: { kind: 'operator' },
  label: 'add the parser',
  task: 'add the parser',
  state: 'open',
  createdAt: 0,
  workerSessionIds: ['session-worker' as never],
}

const verdict: WorktreeVerdict = {
  verdict: 'pass',
  summary: 'looks correct',
  checks: ['pnpm test: pass'],
  findings: [],
  commit: 'deadbeef0123456',
  reviewerSessionId: 'session-reviewer' as never,
  reviewerRoute: { provider: 'anthropic', model: 'opus' },
  at: 0,
}

const mergedOutcome: AcceptOutcome = {
  kind: 'merged', record, commit: 'deadbeef0123456', mergeCommit: 'merge0123456789', verdict, removed: false,
}

describe('dsh agents accept', () => {
  it('accepts with an operator parent and exits 0 on a merge', async () => {
    const test = await bench({
      worktrees: {
        accept: (request) => {
          expect(request.id).toBe('wt-aaaaaaaa')
          expect(request.owner).toEqual({ kind: 'operator' })
          expect(request.parent).toBeDefined()
          return mergedOutcome
        },
      },
    })
    const result = await test.run({ verb: 'accept', id: 'wt-aaaaaaaa', json: true })
    expect(result.code).toBe(0)
    const events = result.out.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.map(event => event.type)).toEqual(['review', 'outcome'])
    expect(events[1]).toMatchObject({ kind: 'merged' })
    await test.ctx.fiber.dispose()
  })

  it('exits 2 on every other outcome', async () => {
    const empty: AcceptOutcome = { kind: 'empty', record }
    const test = await bench({ worktrees: { accept: () => empty } })
    const result = await test.run({ verb: 'accept', id: 'wt-aaaaaaaa' })
    expect(result.code).toBe(2)
    expect(result.out).toContain('has no changes to accept')
    await test.ctx.fiber.dispose()
  })

  it('does not call resolveReviewer itself — accept resolves it internally', async () => {
    const test = await bench({ worktrees: { accept: () => mergedOutcome } })
    await test.run({ verb: 'accept', id: 'wt-aaaaaaaa' })
    expect(test.calls.worktrees.map(call => call.method)).toEqual(['accept'])
    await test.ctx.fiber.dispose()
  })

  it('passes --reviewer/--reviewer-effort and --test through to the accept request', async () => {
    const test = await bench({
      worktrees: {
        accept: (request) => {
          expect(request.reviewer).toEqual({ provider: 'anthropic', model: 'opus', reasoningEffort: 'high' })
          expect(request.testCommand).toEqual(['pnpm', 'test'])
          return mergedOutcome
        },
      },
    })
    const result = await test.run({
      verb: 'accept', id: 'wt-aaaaaaaa', reviewer: 'anthropic/opus', reviewerEffort: 'high', test: 'pnpm test',
    })
    expect(result.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('propagates the service error path as a generic exit-1 failure', async () => {
    const test = await bench({
      worktrees: { accept: () => { throw new Error('worktree "wt-aaaaaaaa" is merged') } },
    })
    const result = await test.run({ verb: 'accept', id: 'wt-aaaaaaaa', json: true })
    expect(result.code).toBe(1)
    expect(result.err).toContain('worktree "wt-aaaaaaaa" is merged')
    expect(JSON.parse(result.out.trim())).toMatchObject({ type: 'error' })
    await test.ctx.fiber.dispose()
  })
})
