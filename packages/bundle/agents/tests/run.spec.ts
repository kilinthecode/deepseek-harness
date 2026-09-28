/** `dsh agents run`: route resolution, worktree create/reuse, the worker run, accept, and fix rounds. */

import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { AcceptOutcome, ProvisionedWorktree, WorktreeRecord, WorktreeVerdict } from '@deepseek-ai/dsh-subagent-worktree'
import { internals } from '../src/runner-internals.ts'
import { bench } from './harness.ts'

const originalInternals = { ...internals }
afterEach(() => { Object.assign(internals, originalInternals) })

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
  workerSessionIds: [],
  workerRoute: { provider: 'anthropic', model: 'opus' },
}

const provisioned: ProvisionedWorktree = { record, workDir: '/worktrees/wt-aaaaaaaa' }

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
  kind: 'merged', record, commit: 'deadbeef0123456', mergeCommit: 'merge0123456789', verdict, removed: true,
}

/** A `SubagentRun` that settles immediately with `completed` and the given text. */
function completedRun(id: string, text = 'done'): SubagentRun {
  return {
    id: id as never,
    localAgent: undefined,
    result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
    dispose: () => Promise.resolve(),
  }
}

describe('dsh agents run', () => {
  it('creates a worktree, runs the worker, accepts, and exits 0 on a merge, with an ordered NDJSON sequence', async () => {
    const test = await bench({
      worktrees: {
        create: (request) => {
          expect(request.owner).toEqual({ kind: 'operator' })
          expect(request.task).toBe('add the parser')
          return provisioned
        },
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        attach: request => ({ ...record, workerSessionIds: [request.workerSessionId] }),
        accept: (request) => {
          expect(request.owner).toEqual({ kind: 'operator' })
          expect(request.parent).toBeDefined()
          return mergedOutcome
        },
      },
      subagentStart: (request) => {
        expect(request.cwd).toBe('/worktrees/wt-aaaaaaaa')
        return completedRun('session-worker')
      },
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', json: true })
    expect(result.code).toBe(0)
    const events = result.out.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.map(event => event.type)).toEqual(['worktree', 'worker', 'review', 'outcome'])
    expect(events[0]).toMatchObject({ type: 'worktree', id: 'wt-aaaaaaaa', reused: false })
    expect(events[1]).toMatchObject({ type: 'worker', sessionId: 'session-worker', stopReason: 'completed' })
    expect(events[2]).toMatchObject({ type: 'review', verdict: 'pass' })
    expect(events[3]).toMatchObject({ type: 'outcome', kind: 'merged' })
    expect(test.calls.worktrees.map(call => call.method)).toEqual(['resolveReviewer', 'create', 'attach', 'accept'])
    await test.ctx.fiber.dispose()
  })

  it('reports uncommitted base-checkout changes left out of a freshly created worktree', async () => {
    const baseDirty = { entries: [' M a.ts'], total: 3 }
    const test = await bench({
      worktrees: {
        create: () => ({ ...provisioned, baseDirty }),
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        attach: () => record,
        accept: () => mergedOutcome,
      },
      subagentStart: () => completedRun('session-worker'),
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', json: true })
    const events = result.out.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events[0]).toMatchObject({ type: 'worktree', baseDirty })
    await test.ctx.fiber.dispose()

    const humanTest = await bench({
      worktrees: {
        create: () => ({ ...provisioned, baseDirty }),
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        attach: () => record,
        accept: () => mergedOutcome,
      },
      subagentStart: () => completedRun('session-worker'),
    })
    const humanResult = await humanTest.run({ verb: 'run', task: 'add the parser' })
    expect(humanResult.out).toContain('Your checkout has 3 uncommitted change(s) that the worktree does not contain.')
    await humanTest.ctx.fiber.dispose()
  })

  it('prints human-readable text by default', async () => {
    const test = await bench({
      worktrees: {
        create: () => provisioned,
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        attach: () => record,
        accept: () => mergedOutcome,
      },
      subagentStart: () => completedRun('session-worker'),
    })
    const result = await test.run({ verb: 'run', task: 'add the parser' })
    expect(result.code).toBe(0)
    expect(result.out).toContain('Created worktree wt-aaaaaaaa')
    expect(result.out).toContain('Worker session-worker')
    expect(result.out).toContain('Merged worktree wt-aaaaaaaa')
    await test.ctx.fiber.dispose()
  })

  it('exits 2 on a rejected review', async () => {
    const rejected: AcceptOutcome = { kind: 'rejected', record, commit: 'c', verdict: { ...verdict, verdict: 'fail', findings: ['bad code'] } }
    const test = await bench({
      worktrees: {
        create: () => provisioned,
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        attach: () => record,
        accept: () => rejected,
      },
      subagentStart: () => completedRun('session-worker'),
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', json: true })
    expect(result.code).toBe(2)
    const events = result.out.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.at(-1)).toMatchObject({ type: 'outcome', kind: 'rejected' })
    await test.ctx.fiber.dispose()
  })

  it('spends a fix round on a rejected review, sending the findings to a fixer, then accepts again', async () => {
    const rejected: AcceptOutcome = { kind: 'rejected', record, commit: 'c1', verdict: { ...verdict, verdict: 'fail', findings: ['missing null check'] } }
    let acceptCalls = 0
    const fixerPrompts: string[] = []
    const test = await bench({
      worktrees: {
        create: () => provisioned,
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        attach: () => record,
        accept: () => {
          acceptCalls += 1
          return acceptCalls === 1 ? rejected : mergedOutcome
        },
      },
      subagentStart: (request) => {
        const text = (request.prompt[0] as { text: string }).text
        if (text.startsWith('Fix these problems')) fixerPrompts.push(text)
        return completedRun(`session-${String(request.prompt.length)}-${String(fixerPrompts.length)}`)
      },
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', fixRounds: 1, json: true })
    expect(result.code).toBe(0)
    expect(acceptCalls).toBe(2)
    expect(fixerPrompts).toHaveLength(1)
    expect(fixerPrompts[0]).toContain('Fix these problems in this worktree:')
    expect(fixerPrompts[0]).toContain('- missing null check')
    expect(fixerPrompts[0]).toContain('Original task:\nadd the parser')
    const workerEvents = test.calls.worktrees.filter(call => call.method === 'attach')
    expect(workerEvents).toHaveLength(2)
    await test.ctx.fiber.dispose()
  })

  it('stops spending fix rounds once --fix-rounds is exhausted', async () => {
    const rejected: AcceptOutcome = { kind: 'rejected', record, commit: 'c1', verdict: { ...verdict, verdict: 'fail', findings: ['still wrong'] } }
    let acceptCalls = 0
    const test = await bench({
      worktrees: {
        create: () => provisioned,
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        attach: () => record,
        accept: () => { acceptCalls += 1; return rejected },
      },
      subagentStart: () => completedRun('session-worker'),
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', fixRounds: 2 })
    expect(result.code).toBe(2)
    // One initial worker run plus exactly two fix rounds: three accept calls total.
    expect(acceptCalls).toBe(3)
    await test.ctx.fiber.dispose()
  })

  it('does not spend a fix round on a merged or otherwise unfixable outcome', async () => {
    let acceptCalls = 0
    const test = await bench({
      worktrees: {
        create: () => provisioned,
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        attach: () => record,
        accept: () => { acceptCalls += 1; return mergedOutcome },
      },
      subagentStart: () => completedRun('session-worker'),
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', fixRounds: 5 })
    expect(result.code).toBe(0)
    expect(acceptCalls).toBe(1)
    await test.ctx.fiber.dispose()
  })

  it('aborts before creating a worktree when resolveReviewer rejects the route pairing', async () => {
    const test = await bench({
      worktrees: {
        resolveReviewer: () => { throw new Error('the reviewer would run on the worker\'s route') },
      },
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', json: true })
    expect(result.code).toBe(1)
    expect(result.err).toContain('the reviewer would run on the worker\'s route')
    expect(test.calls.worktrees.map(call => call.method)).toEqual(['resolveReviewer'])
    expect(JSON.parse(result.out.trim())).toMatchObject({ type: 'error' })
    await test.ctx.fiber.dispose()
  })

  it('reuses an open --worktree instead of creating one', async () => {
    const test = await bench({
      filesystemCwd: '/repo',
      worktrees: {
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        list: (request) => {
          expect(request.owner).toEqual({ kind: 'operator' })
          return [record]
        },
        attach: () => record,
        accept: () => mergedOutcome,
      },
      subagentStart: (request) => {
        expect(request.cwd).toBe('/worktrees/wt-aaaaaaaa')
        return completedRun('session-worker')
      },
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', worktree: 'wt-aaaaaaaa', json: true })
    expect(result.code).toBe(0)
    expect(test.calls.worktrees.map(call => call.method)).toEqual(['resolveReviewer', 'list', 'attach', 'accept'])
    const events = result.out.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events[0]).toMatchObject({ type: 'worktree', reused: true })
    await test.ctx.fiber.dispose()
  })

  it('fails with a clear error when --worktree names an id with no operator-owned record', async () => {
    const test = await bench({
      worktrees: {
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        list: () => [],
      },
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', worktree: 'wt-missing' })
    expect(result.code).toBe(1)
    expect(result.err).toContain('worktree "wt-missing" was not found')
    await test.ctx.fiber.dispose()
  })

  it('fails when --worktree names a record that is not open', async () => {
    const test = await bench({
      worktrees: {
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        list: () => [{ ...record, state: 'merged' }],
      },
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', worktree: 'wt-aaaaaaaa' })
    expect(result.code).toBe(1)
    expect(result.err).toContain('worktree "wt-aaaaaaaa" is merged, not open')
    await test.ctx.fiber.dispose()
  })

  it('reads the task from stdin when given a lone "-"', async () => {
    internals.readStdin = () => Promise.resolve('stdin task')
    const test = await bench({
      worktrees: {
        create: (request) => { expect(request.task).toBe('stdin task'); return provisioned },
        resolveReviewer: () => ({ provider: 'anthropic', model: 'opus' }),
        attach: () => record,
        accept: () => mergedOutcome,
      },
      subagentStart: () => completedRun('session-worker'),
    })
    const result = await test.run({ verb: 'run', task: '-' })
    expect(result.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('rejects an empty stdin task', async () => {
    internals.readStdin = () => Promise.resolve('   ')
    const test = await bench({ worktrees: { resolveReviewer: () => ({ provider: 'p', model: 'm' }) } })
    const result = await test.run({ verb: 'run', task: '-' })
    expect(result.code).toBe(1)
    expect(result.err).toContain('a task is required')
    await test.ctx.fiber.dispose()
  })

  it('derives the worktree label from the task when --name is omitted', async () => {
    const test = await bench({
      worktrees: {
        create: (request) => { expect(request.label).toBe('add the parser'); return provisioned },
        resolveReviewer: () => ({ provider: 'p', model: 'm' }),
        attach: () => record,
        accept: () => mergedOutcome,
      },
      subagentStart: () => completedRun('session-worker'),
    })
    await test.run({ verb: 'run', task: 'add the parser' })
    await test.ctx.fiber.dispose()
  })

  it('uses --name for the worktree label when given', async () => {
    const test = await bench({
      worktrees: {
        create: (request) => { expect(request.label).toBe('custom label'); return provisioned },
        resolveReviewer: () => ({ provider: 'p', model: 'm' }),
        attach: () => record,
        accept: () => mergedOutcome,
      },
      subagentStart: () => completedRun('session-worker'),
    })
    await test.run({ verb: 'run', task: 'add the parser', name: 'custom label' })
    await test.ctx.fiber.dispose()
  })

  it('resolves the worker route from --model/--effort and passes it to the worktree and the child', async () => {
    const test = await bench({
      worktrees: {
        create: (request) => { expect(request.workerRoute).toEqual({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' }); return provisioned },
        resolveReviewer: (request) => { expect(request.workerRoute).toEqual({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' }); return { provider: 'anthropic', model: 'opus' } },
        attach: () => record,
        accept: () => mergedOutcome,
      },
      subagentStart: (request) => { expect(request.agentOptions).toEqual({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' }); return completedRun('session-worker') },
    })
    const result = await test.run({ verb: 'run', task: 'add the parser', model: 'openai/gpt-5', effort: 'high' })
    expect(result.code).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('passes --test as the accept testCommand, split on whitespace', async () => {
    const test = await bench({
      worktrees: {
        create: () => provisioned,
        resolveReviewer: () => ({ provider: 'p', model: 'm' }),
        attach: () => record,
        accept: (request) => { expect(request.testCommand).toEqual(['pnpm', 'run', 'test']); return mergedOutcome },
      },
      subagentStart: () => completedRun('session-worker'),
    })
    await test.run({ verb: 'run', task: 'add the parser', test: 'pnpm run test' })
    await test.ctx.fiber.dispose()
  })

  it('passes a --reviewer override through to resolveReviewer and to accept', async () => {
    const test = await bench({
      worktrees: {
        create: () => provisioned,
        resolveReviewer: (request) => { expect(request.override).toEqual({ provider: 'anthropic', model: 'opus' }); return { provider: 'anthropic', model: 'opus' } },
        attach: () => record,
        accept: (request) => { expect(request.reviewer).toEqual({ provider: 'anthropic', model: 'opus' }); return mergedOutcome },
      },
      subagentStart: () => completedRun('session-worker'),
    })
    await test.run({ verb: 'run', task: 'add the parser', reviewer: 'anthropic/opus' })
    await test.ctx.fiber.dispose()
  })

  it('reads the default process stdin when no override is installed', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([Buffer.from('piped'), Buffer.from(' task')]),
      configurable: true,
    })
    try {
      await expect(originalInternals.readStdin()).resolves.toBe('piped task')
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'stdin', original)
    }
  })
})
