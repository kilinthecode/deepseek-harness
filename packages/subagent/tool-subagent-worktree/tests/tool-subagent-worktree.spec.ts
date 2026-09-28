/**
 * Tool wiring coverage: owner/parent/baseDir passed to `ctx.subagentWorktrees`,
 * calling-agent enforcement, service-error surfacing, and HMR disposal.
 * Verbatim render coverage lives in `values.spec.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptOutcome } from '@deepseek-ai/dsh-subagent-worktree'
import * as tool from '../src/index.ts'
import { FakeSubagentWorktrees } from './fake-subagent-worktrees.ts'
import { testRecord } from './fixtures.ts'

const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

async function setup(): Promise<{ ctx: Context; fake: FakeSubagentWorktrees; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(FakeSubagentWorktrees)
  const service = ctx.get('subagentWorktrees')
  if (!(service instanceof FakeSubagentWorktrees)) throw new Error('expected the fake worktree service to be mounted')
  const fiber = await ctx.plugin(tool)
  return { ctx, fake: service, fiber }
}

let calls = 0
function callTool(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${String(++calls)}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('tool-subagent-worktree wiring', () => {
  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-worktree')
    expect(tool.inject).toEqual(['tools', 'subagentWorktrees'])
    expect(typeof tool.apply).toBe('function')
  })

  it('registers all three schemas with their declared parameters', async () => {
    const { ctx } = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(['accept_worktree', 'discard_worktree', 'list_worktrees']))
    const accept = ctx.tools.schemas().find(schema => schema.name === 'accept_worktree')
    const discard = ctx.tools.schemas().find(schema => schema.name === 'discard_worktree')
    const list = ctx.tools.schemas().find(schema => schema.name === 'list_worktrees')
    expect(Object.keys((accept?.parameters as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(['worktree_id'])
    expect(Object.keys((discard?.parameters as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(['worktree_id'])
    expect(Object.keys((list?.parameters as { properties?: Record<string, unknown> }).properties ?? {})).toEqual([])
  })

  it('unregisters every tool with its plugin fiber (HMR safety)', async () => {
    const { ctx, fiber } = await setup()
    for (const toolName of ['accept_worktree', 'discard_worktree', 'list_worktrees']) {
      expect(ctx.tools.schemas().some(schema => schema.name === toolName)).toBe(true)
    }
    await fiber.dispose()
    for (const toolName of ['accept_worktree', 'discard_worktree', 'list_worktrees']) {
      expect(ctx.tools.schemas().some(schema => schema.name === toolName)).toBe(false)
    }
  })

  describe('accept_worktree', () => {
    it('passes the session owner, the calling agent as parent, and the requested id', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      const outcome: AcceptOutcome = { kind: 'empty', record: testRecord() }
      fake.acceptImpl = () => Promise.resolve(outcome)

      const result = await callTool(ctx, 'accept_worktree', { worktree_id: 'wt-1' }, agent)

      expect(result.isError).toBe(false)
      expect(text(result)).toBe('Worktree wt-1 has no changes to accept.')
      expect(fake.acceptCalls).toHaveLength(1)
      const request = fake.acceptCalls[0]
      expect(request?.id).toBe('wt-1')
      expect(request?.owner).toEqual({ kind: 'session', sessionId: agent.id })
      expect(request?.parent).toBe(agent)
    })

    it('surfaces a service rejection as an errored tool result', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      fake.acceptImpl = () => Promise.reject(new Error('subagent-worktree: worktree wt-1 belongs to another session'))

      const result = await callTool(ctx, 'accept_worktree', { worktree_id: 'wt-1' }, agent)

      expect(result.isError).toBe(true)
      expect(text(result)).toContain('belongs to another session')
    })

    it('fails loud when invoked without a calling agent', async () => {
      const { ctx } = await setup()
      const result = await callTool(ctx, 'accept_worktree', { worktree_id: 'wt-1' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('requires a calling agent')
    })
  })

  describe('discard_worktree', () => {
    it('passes the session owner and the requested id', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      fake.discardImpl = () => Promise.resolve(testRecord({ state: 'discarded' }))

      const result = await callTool(ctx, 'discard_worktree', { worktree_id: 'wt-1' }, agent)

      expect(result.isError).toBe(false)
      expect(text(result)).toBe('Discarded worktree wt-1 and branch dsh/worktree/wt-1.')
      expect(fake.discardCalls).toHaveLength(1)
      const request = fake.discardCalls[0]
      expect(request?.id).toBe('wt-1')
      expect(request?.owner).toEqual({ kind: 'session', sessionId: agent.id })
    })

    it('surfaces a service rejection as an errored tool result', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      fake.discardImpl = () => Promise.reject(new Error('subagent-worktree: worker session-1 of worktree wt-1 is still running; wait for it to finish'))

      const result = await callTool(ctx, 'discard_worktree', { worktree_id: 'wt-1' }, agent)

      expect(result.isError).toBe(true)
      expect(text(result)).toContain('is still running')
    })

    it('fails loud when invoked without a calling agent', async () => {
      const { ctx } = await setup()
      const result = await callTool(ctx, 'discard_worktree', { worktree_id: 'wt-1' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('requires a calling agent')
    })
  })

  describe('list_worktrees', () => {
    it('scopes the request to the caller session owner and its session cwd', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      fake.listImpl = () => Promise.resolve([testRecord()])

      const result = await callTool(ctx, 'list_worktrees', {}, agent)

      expect(result.isError).toBe(false)
      expect(text(result)).toBe('wt-1  open  dsh/worktree/wt-1  fix bug  not reviewed')
      expect(fake.listCalls).toHaveLength(1)
      expect(fake.listCalls[0]).toEqual({
        baseDir: '/repo/work',
        owner: { kind: 'session', sessionId: agent.id },
      })
    })

    it('renders the empty sentence and does not throw when nothing is open', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      fake.listImpl = () => Promise.resolve([])

      const result = await callTool(ctx, 'list_worktrees', {}, agent)

      expect(result.isError).toBe(false)
      expect(text(result)).toBe('No open worktrees.')
    })

    it('fails loud for a session with no working directory', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'))

      const result = await callTool(ctx, 'list_worktrees', {}, agent)

      expect(result.isError).toBe(true)
      expect(text(result)).toContain('requires a session with a working directory')
      expect(fake.listCalls).toHaveLength(0)
    })

    it('fails loud when invoked without a calling agent', async () => {
      const { ctx } = await setup()
      const result = await callTool(ctx, 'list_worktrees', {})
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('requires a calling agent')
    })
  })
})
