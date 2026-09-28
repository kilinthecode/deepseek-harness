import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assertNoRunningWorkers } from '../src/workers.ts'
import type { WorktreeId } from '../src/types.ts'

/** A minimal `ctx.agents` stub: only `get` is touched by {@link assertNoRunningWorkers}. */
function ctxWithAgents(statuses: Record<string, AgentStatus>): Context {
  return {
    agents: {
      get: (id: SessionId) => (id in statuses ? { status: statuses[id] } as Agent : undefined),
    },
  } as unknown as Context
}

const id = 'wt-00000000' as WorktreeId

describe('assertNoRunningWorkers', () => {
  it('does not throw when the record has no attached workers', () => {
    expect(() => { assertNoRunningWorkers(ctxWithAgents({}), { workerSessionIds: [] }, id) }).not.toThrow()
  })

  it('does not throw when an attached worker is absent from the live registry', () => {
    const ctx = ctxWithAgents({})
    expect(() => { assertNoRunningWorkers(ctx, { workerSessionIds: [SessionId('gone')] }, id) }).not.toThrow()
  })

  it('does not throw when every attached worker is idle', () => {
    const ctx = ctxWithAgents({ w1: 'idle', w2: 'idle' })
    expect(() => { assertNoRunningWorkers(ctx, { workerSessionIds: [SessionId('w1'), SessionId('w2')] }, id) }).not.toThrow()
  })

  it('throws naming the running worker and the worktree id', () => {
    const ctx = ctxWithAgents({ w1: 'idle', w2: 'running' })
    expect(() => { assertNoRunningWorkers(ctx, { workerSessionIds: [SessionId('w1'), SessionId('w2')] }, id) })
      .toThrow('subagent-worktree: worker w2 of worktree wt-00000000 is still running; wait for it to finish')
  })
})
