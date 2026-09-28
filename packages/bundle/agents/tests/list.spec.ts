/** `dsh agents list`: the repository's worktrees from the invoking directory, every owner's view. */

import { describe, expect, it } from 'vitest'
import type { WorktreeRecord } from '@deepseek-ai/dsh-subagent-worktree'
import { bench } from './harness.ts'

const openRecord: WorktreeRecord = {
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
  workerSessionIds: [],
}

describe('dsh agents list', () => {
  it('lists records from the resolved cwd without an owner filter and excludes closed records by default', async () => {
    const test = await bench({
      filesystemCwd: '/repo',
      worktrees: {
        list: (request) => {
          expect(request.baseDir).toBe('/repo')
          expect(request.owner).toBeUndefined()
          expect(request.includeClosed).toBe(false)
          return [openRecord]
        },
      },
    })
    const result = await test.run({ verb: 'list' })
    expect(result.code).toBe(0)
    expect(result.out).toBe(`${openRecord.id}  open  ${openRecord.branch}  add the parser  not reviewed\n`)
    await test.ctx.fiber.dispose()
  })

  it('includes closed records with --all', async () => {
    const test = await bench({
      worktrees: {
        list: (request) => {
          expect(request.includeClosed).toBe(true)
          return [{ ...openRecord, state: 'merged' }]
        },
      },
    })
    const result = await test.run({ verb: 'list', all: true })
    expect(result.code).toBe(0)
    expect(result.out).toContain('merged')
    await test.ctx.fiber.dispose()
  })

  it('prints "No open worktrees." when the repository has none', async () => {
    const test = await bench({ worktrees: { list: () => [] } })
    const result = await test.run({ verb: 'list' })
    expect(result.out).toBe('No open worktrees.\n')
    await test.ctx.fiber.dispose()
  })

  it('prints "No worktrees." for --all when there are none at all', async () => {
    const test = await bench({ worktrees: { list: () => [] } })
    const result = await test.run({ verb: 'list', all: true })
    expect(result.out).toBe('No worktrees.\n')
    await test.ctx.fiber.dispose()
  })

  it('emits one worktree event per record in --json mode', async () => {
    const test = await bench({ worktrees: { list: () => [openRecord] } })
    const result = await test.run({ verb: 'list', json: true })
    expect(JSON.parse(result.out.trim())).toEqual({
      type: 'worktree', id: openRecord.id, path: openRecord.path, branch: openRecord.branch,
      baseCommit: openRecord.baseCommit, state: 'open', label: 'add the parser',
    })
    await test.ctx.fiber.dispose()
  })

  it('emits nothing on stdout in --json mode when there are no records', async () => {
    const test = await bench({ worktrees: { list: () => [] } })
    const result = await test.run({ verb: 'list', json: true })
    expect(result.out).toBe('')
    expect(result.code).toBe(0)
    await test.ctx.fiber.dispose()
  })
})
