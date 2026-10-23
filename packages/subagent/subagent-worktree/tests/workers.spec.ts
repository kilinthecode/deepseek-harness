import { describe, expect, it } from 'vitest'
import type AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assertNoRunningWorkers } from '../src/workers.ts'
import type { WorktreeId } from '../src/types.ts'

/** A registry stub: only `get` is touched by {@link assertNoRunningWorkers}, and only `status` of what it returns. */
function registryWith(statuses: Record<string, AgentStatus>): Pick<AgentRegistry, 'get'> {
  return {
    get: (id: SessionId) => (id in statuses ? { status: statuses[id] } as Agent : undefined),
  }
}

const id = 'wt-00000000' as WorktreeId

describe('assertNoRunningWorkers', () => {
  it('does not throw when the record has no attached workers', () => {
    expect(() => { assertNoRunningWorkers(registryWith({}), { workerSessionIds: [] }, id) }).not.toThrow()
  })

  it('does not throw when an attached worker is absent from the live registry', () => {
    const agents = registryWith({})
    expect(() => { assertNoRunningWorkers(agents, { workerSessionIds: [SessionId('gone')] }, id) }).not.toThrow()
  })

  it('does not throw when every attached worker is idle', () => {
    const agents = registryWith({ w1: 'idle', w2: 'idle' })
    expect(() => { assertNoRunningWorkers(agents, { workerSessionIds: [SessionId('w1'), SessionId('w2')] }, id) }).not.toThrow()
  })

  it('throws naming the running worker and the worktree id', () => {
    const agents = registryWith({ w1: 'idle', w2: 'running' })
    expect(() => { assertNoRunningWorkers(agents, { workerSessionIds: [SessionId('w1'), SessionId('w2')] }, id) })
      .toThrow('subagent-worktree: worker w2 of worktree wt-00000000 is still running; wait for it to finish')
  })
})
