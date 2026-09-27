/** Delegation-tree provider cache-routing key stamped on each dispatched request. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.reverse()) await cleanup()
  } finally {
    cleanups.length = 0
  }
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('one')]))
  return ctx
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Registers the handle's disposal in `cleanups` and returns its agent. */
function owned(handle: AgentHandle): Agent {
  cleanups.push(() => handle.dispose())
  return handle.agent
}

describe('delegation cache-routing key on dispatched requests', () => {
  it('stamps a top-level agent\'s own session id', async () => {
    const ctx = await harness()
    const requests: GenerateOptions[] = []
    ctx.on('llm/stream', (request, next) => { requests.push(request); return next() })
    const agent = owned(await ctx.agents.create({
      sessionId: SessionId('top-level'),
      agentOptions: { provider: 'mock', model: 'mock' },
    }))
    await send(agent, 'hi')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.sessionId).toBe('top-level')
    expect(requests[0]?.cacheKey).toBe('top-level')
  })

  it('stamps a delegated child\'s requests with the delegation tree\'s root, not the child\'s own id', async () => {
    const ctx = await harness()
    const parent = owned(await ctx.agents.create({
      sessionId: SessionId('root-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    }))
    const requests: GenerateOptions[] = []
    ctx.on('llm/stream', (request, next) => { requests.push(request); return next() })
    const child = owned(await ctx.agents.create({
      sessionId: SessionId('child-of-root'),
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { parentSession: parent.session.id, origin: 'subagent', delegationDepth: 1 },
    }))
    await send(child, 'hi')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.sessionId).toBe('child-of-root')
    expect(requests[0]?.cacheKey).toBe('root-parent')
  })

  it('falls back to the nearest known ancestor once that ancestor disposes mid-tree', async () => {
    const ctx = await harness()
    const grandparentHandle = await ctx.agents.create({
      sessionId: SessionId('grandparent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const parent = owned(await ctx.agents.create({
      sessionId: SessionId('mid-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { parentSession: grandparentHandle.agent.session.id, origin: 'subagent', delegationDepth: 1 },
    }))
    const child = owned(await ctx.agents.create({
      sessionId: SessionId('leaf-child'),
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { parentSession: parent.session.id, origin: 'subagent', delegationDepth: 2 },
    }))
    // The grandparent's own session is no longer live: the walk can still name
    // its id from the parent's header, but cannot confirm it is a further
    // child of anything else, so it stops there rather than guessing.
    await grandparentHandle.dispose()
    const requests: GenerateOptions[] = []
    ctx.on('llm/stream', (request, next) => { requests.push(request); return next() })
    await send(child, 'hi')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.cacheKey).toBe('grandparent')
  })
})
