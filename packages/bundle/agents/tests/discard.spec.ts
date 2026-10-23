/** `dsh agents discard`: delete one worktree and its branch without merging. */

import { describe, expect, it } from 'vitest'
import type { WorktreeRecord } from '@deepseek-ai/dsh-subagent-worktree'
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
  state: 'discarded',
  createdAt: 0,
  workerSessionIds: [],
  workerRoute: { provider: 'anthropic', model: 'opus' },
}

describe('dsh agents discard', () => {
  it('discards with an operator owner and exits 0', async () => {
    const test = await bench({
      worktrees: {
        discard: (request) => {
          expect(request.id).toBe('wt-aaaaaaaa')
          expect(request.owner).toEqual({ kind: 'operator' })
          return record
        },
      },
    })
    const result = await test.run({ verb: 'discard', id: 'wt-aaaaaaaa', json: true })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out.trim())).toEqual({ type: 'outcome', kind: 'discarded', id: 'wt-aaaaaaaa', branch: record.branch })
    await test.ctx.fiber.dispose()
  })

  it('prints a human-readable line by default', async () => {
    const test = await bench({ worktrees: { discard: () => record } })
    const result = await test.run({ verb: 'discard', id: 'wt-aaaaaaaa' })
    expect(result.code).toBe(0)
    expect(result.out).toBe(`Discarded worktree wt-aaaaaaaa and branch ${record.branch}.\n`)
    await test.ctx.fiber.dispose()
  })

  it('propagates a rejection (for example, an attached worker still running) as exit 1', async () => {
    const test = await bench({
      worktrees: { discard: () => { throw new Error('worktree "wt-aaaaaaaa" is already being accepted') } },
    })
    const result = await test.run({ verb: 'discard', id: 'wt-aaaaaaaa', json: true })
    expect(result.code).toBe(1)
    expect(result.err).toContain('is already being accepted')
    expect(JSON.parse(result.out.trim())).toMatchObject({ type: 'error' })
    await test.ctx.fiber.dispose()
  })
})
