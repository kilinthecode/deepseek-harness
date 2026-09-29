/**
 * Tool wiring coverage: owner/parent/baseDir/signal passed to
 * `ctx.subagentWorktrees`, calling-agent enforcement, worktree_id validation
 * at the model-JSON boundary, service-error surfacing, and HMR disposal.
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
import { OTHER_WORKTREE_ID, testRecord, WORKTREE_ID } from './fixtures.ts'

const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

async function setup(config?: Partial<tool.Config>): Promise<{
  ctx: Context
  fake: FakeSubagentWorktrees
  fiber: Awaited<ReturnType<Context['plugin']>>
  serviceFiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  const serviceFiber = await ctx.plugin(FakeSubagentWorktrees)
  const service = ctx.get('subagentWorktrees')
  if (!(service instanceof FakeSubagentWorktrees)) throw new Error('expected the fake worktree service to be mounted')
  const fiber = await ctx.plugin(tool, config)
  return { ctx, fake: service, fiber, serviceFiber }
}

let calls = 0
function callTool(ctx: Context, name: string, args: unknown, agent?: Agent, signal: AbortSignal = new AbortController().signal) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${String(++calls)}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const WORKTREE_ID_PARAM_DESCRIPTION = 'The worktree id reported when the child started.'

const ACCEPT_DESCRIPTION = 'Land an isolated child\'s work. The harness commits the worktree\'s changes, runs any configured checks, '
  + 'and has an independent reviewer check that exact commit; only a passing change is merged into your '
  + 'checkout. A failing review returns its findings: send them to a background child with send_message, wait '
  + 'for it to finish, and accept again; a foreground child cannot receive messages, so discard the worktree '
  + 'and start a new background worker with the task and the findings. Call it only after the child has finished.'

const DISCARD_DESCRIPTION = 'Delete an isolated child\'s worktree and its branch without merging. Its unmerged changes are lost.'

const LIST_DESCRIPTION = 'List the isolated worktrees you started that are still open, with each one\'s branch, path, state, latest worker agent id, and latest review verdict.'

describe('tool-subagent-worktree wiring', () => {
  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-worktree')
    expect(tool.inject).toEqual(['tools', 'subagentWorktrees'])
    expect(typeof tool.apply).toBe('function')
  })

  it('registers the exact verbatim descriptions and complete parameter schemas', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas()
    const accept = schemas.find(schema => schema.name === 'accept_worktree')
    const discard = schemas.find(schema => schema.name === 'discard_worktree')
    const list = schemas.find(schema => schema.name === 'list_worktrees')
    if (accept === undefined || discard === undefined || list === undefined) {
      throw new Error('expected all three tool schemas to be registered')
    }

    expect(accept.description).toBe(ACCEPT_DESCRIPTION)
    expect(accept.parameters).toEqual({
      type: 'object',
      properties: {
        worktree_id: { type: 'string', description: WORKTREE_ID_PARAM_DESCRIPTION },
      },
      required: ['worktree_id'],
    })

    expect(discard.description).toBe(DISCARD_DESCRIPTION)
    expect(discard.parameters).toEqual({
      type: 'object',
      properties: {
        worktree_id: { type: 'string', description: WORKTREE_ID_PARAM_DESCRIPTION },
      },
      required: ['worktree_id'],
    })

    expect(list.description).toBe(LIST_DESCRIPTION)
    expect(list.parameters).toEqual({
      type: 'object',
      properties: {},
    })
  })

  describe('isolation offer', () => {
    it('offers isolation for as long as the tools are mounted, and withdraws the offer with the plugin fiber', async () => {
      const { ctx, fiber } = await setup()
      expect(ctx.subagentWorktrees.offersIsolation).toBe(true)

      await fiber.dispose()

      expect(ctx.subagentWorktrees.offersIsolation).toBe(false)
    })

    it('offers nothing when configured off, though the tools still register', async () => {
      const { ctx } = await setup({ offerIsolation: false })

      expect(ctx.tools.schemas().some(schema => schema.name === 'accept_worktree')).toBe(true)
      expect(ctx.subagentWorktrees.offersIsolation).toBe(false)
    })

    it('offers again after the worktree service restarts, because the tools re-mount against the new instance', async () => {
      const { ctx, serviceFiber } = await setup()
      const before = ctx.subagentWorktrees

      await serviceFiber.restart()

      expect(ctx.subagentWorktrees).not.toBe(before)
      expect(ctx.subagentWorktrees.offersIsolation).toBe(true)
    })

    it('declares offerIsolation on by default in its Config schema', () => {
      expect(tool.Config({}).offerIsolation).toBe(true)
      expect(tool.Config({ offerIsolation: false }).offerIsolation).toBe(false)
    })
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

  for (const toolName of ['accept_worktree', 'discard_worktree'] as const) {
    describe(`${toolName} worktree_id validation`, () => {
      it.each(['../x', 'wt-1', 'wt-1A2B3C4D'])('rejects %j at the model-JSON boundary without calling the service', async (badId) => {
        const { ctx, fake } = await setup()
        const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })

        const result = await callTool(ctx, toolName, { worktree_id: badId }, agent)

        expect(result.isError).toBe(true)
        // The rejection is the service's own id check, applied here so a malformed id never reaches the service.
        expect(text(result)).toContain(
          `subagent-worktree: "${badId}" is not a worktree id (expected "wt-" followed by eight lowercase hexadecimal digits)`,
        )
        expect(fake.acceptCalls).toHaveLength(0)
        expect(fake.discardCalls).toHaveLength(0)
      })
    })
  }

  describe('accept_worktree', () => {
    it('passes the session owner, the calling agent as parent, the requested id, and the execution signal', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      const outcome: AcceptOutcome = { kind: 'empty', record: testRecord() }
      fake.acceptImpl = () => Promise.resolve(outcome)
      const signal = new AbortController().signal

      const result = await callTool(ctx, 'accept_worktree', { worktree_id: WORKTREE_ID }, agent, signal)

      expect(result.isError).toBe(false)
      expect(text(result)).toBe(`Worktree ${WORKTREE_ID} has no changes to accept.`)
      expect(fake.acceptCalls).toHaveLength(1)
      const request = fake.acceptCalls[0]
      expect(request?.id).toBe(WORKTREE_ID)
      expect(request?.owner).toEqual({ kind: 'session', sessionId: agent.id })
      expect(request?.parent).toBe(agent)
      expect(request?.signal).toBe(signal)
    })

    it('surfaces a service rejection as an errored tool result', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      fake.acceptImpl = () => Promise.reject(new Error(`subagent-worktree: worktree ${WORKTREE_ID} belongs to another session`))

      const result = await callTool(ctx, 'accept_worktree', { worktree_id: WORKTREE_ID }, agent)

      expect(result.isError).toBe(true)
      expect(text(result)).toContain('belongs to another session')
    })

    it('fails loud when invoked without a calling agent', async () => {
      const { ctx } = await setup()
      const result = await callTool(ctx, 'accept_worktree', { worktree_id: WORKTREE_ID })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('requires a calling agent')
    })
  })

  describe('discard_worktree', () => {
    it('passes the session owner and the requested id', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      fake.discardImpl = () => Promise.resolve(testRecord({ state: 'discarded' }))

      const result = await callTool(ctx, 'discard_worktree', { worktree_id: WORKTREE_ID }, agent)

      expect(result.isError).toBe(false)
      expect(text(result)).toBe(`Discarded worktree ${WORKTREE_ID} and branch dsh/worktree/wt-1a2b3c4d.`)
      expect(fake.discardCalls).toHaveLength(1)
      const request = fake.discardCalls[0]
      expect(request?.id).toBe(WORKTREE_ID)
      expect(request?.owner).toEqual({ kind: 'session', sessionId: agent.id })
    })

    it('surfaces a service rejection as an errored tool result', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      fake.discardImpl = () => Promise.reject(new Error(`subagent-worktree: worker session-1 of worktree ${WORKTREE_ID} is still running; wait for it to finish`))

      const result = await callTool(ctx, 'discard_worktree', { worktree_id: WORKTREE_ID }, agent)

      expect(result.isError).toBe(true)
      expect(text(result)).toContain('is still running')
    })

    it('fails loud when invoked without a calling agent', async () => {
      const { ctx } = await setup()
      const result = await callTool(ctx, 'discard_worktree', { worktree_id: WORKTREE_ID })
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
      expect(text(result)).toBe(
        `${WORKTREE_ID}  state=open  branch=dsh/worktree/wt-1a2b3c4d  path=/repo-worktrees/wt-1a2b3c4d  worker=none  review=not reviewed  label="fix bug"`,
      )
      expect(fake.listCalls).toHaveLength(1)
      expect(fake.listCalls[0]).toEqual({
        baseDir: '/repo/work',
        owner: { kind: 'session', sessionId: agent.id },
      })
    })

    it('renders a fail verdict', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      fake.listImpl = () => Promise.resolve([testRecord({
        id: OTHER_WORKTREE_ID,
        state: 'reviewing',
        branch: 'dsh/worktree/wt-5e6f7a8b',
        path: '/repo-worktrees/wt-5e6f7a8b',
        label: 'add feature',
        lastVerdict: {
          verdict: 'fail',
          summary: 'missing a test',
          checks: [],
          findings: ['no covering test'],
          commit: '1234567890abcdef1234567890abcdef12345678',
          reviewerSessionId: SessionId('reviewer'),
          reviewerRoute: { provider: 'reviewer-provider', model: 'reviewer-model' },
          at: 0,
        },
      })])

      const result = await callTool(ctx, 'list_worktrees', {}, agent)

      expect(result.isError).toBe(false)
      expect(text(result)).toBe(
        `${OTHER_WORKTREE_ID}  state=reviewing  branch=dsh/worktree/wt-5e6f7a8b  path=/repo-worktrees/wt-5e6f7a8b  worker=none  review=fail  label="add feature"`,
      )
    })

    it('reports the latest worker agent id and the worktree path from the service record', async () => {
      const { ctx, fake } = await setup()
      const agent = await ctx.agentLoop.create(SessionId('caller'), {}, { cwd: '/repo/work' })
      fake.listImpl = () => Promise.resolve([testRecord({
        path: '/home/me/.dsh/worktrees/wt-1a2b3c4d',
        workerSessionIds: [SessionId('worker-1'), SessionId('worker-2')],
      })])

      const result = await callTool(ctx, 'list_worktrees', {}, agent)

      expect(result.isError).toBe(false)
      expect(text(result)).toBe(
        `${WORKTREE_ID}  state=open  branch=dsh/worktree/wt-1a2b3c4d  path=/home/me/.dsh/worktrees/wt-1a2b3c4d  worker=worker-2  review=not reviewed  label="fix bug"`,
      )
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
