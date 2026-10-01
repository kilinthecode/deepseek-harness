import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { applyAgentScopedTools, callingAgent, jsonOutput } from '../src/index.ts'

type AgentEventName = 'agent/created' | 'agent/disposed'
type AgentEventListener = (event: { readonly agent: Agent }) => void

function eventHarness(agents: Agent[]) {
  const listeners: Record<AgentEventName, AgentEventListener[]> = {
    'agent/created': [],
    'agent/disposed': [],
  }
  let disposeEffect: (() => void) | undefined
  const ctx = {
    agents: { list: () => agents },
    on(name: AgentEventName, listener: AgentEventListener) {
      listeners[name].push(listener)
      return () => {
        const index = listeners[name].indexOf(listener)
        if (index >= 0) listeners[name].splice(index, 1)
      }
    },
    effect(register: () => () => void) {
      disposeEffect = register()
      return () => {}
    },
  } as unknown as Context
  return {
    ctx,
    emit(name: AgentEventName, agent: Agent): void {
      for (const listener of listeners[name]) listener({ agent })
    },
    dispose(): void {
      disposeEffect?.()
    },
  }
}

describe('tool authoring helpers', () => {
  it('renders canonical values as compact JSON while retaining the schema', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { answer: { type: 'integer', required: true } },
    } as const
    const output = jsonOutput(schema)

    expect(output.schema).toBe(schema)
    expect(output.render(undefined, { answer: 42 })).toEqual([{ type: 'text', text: '{"answer":42}' }])
  })

  it('returns the exact caller and preserves the missing-caller error', () => {
    const agent = {} as Agent

    expect(callingAgent(agent, 'tool_name')).toBe(agent)
    expect(() => callingAgent(undefined, 'tool_name')).toThrow('tool_name requires a calling Agent')
  })

  it('installs matching current and future Agents once and disposes their scopes', () => {
    const lead = { id: 'lead' } as Agent
    const teammate = { id: 'teammate' } as Agent
    const unrelated = { id: 'unrelated' } as Agent
    const eligible = new Set([lead, teammate])
    const installed: string[] = []
    const disposed: string[] = []
    const harness = eventHarness([lead, unrelated])

    applyAgentScopedTools(
      harness.ctx,
      agent => eligible.has(agent),
      (agent) => {
        installed.push(agent.id)
        return () => { disposed.push(agent.id) }
      },
      'test.agentTools()',
    )

    harness.emit('agent/created', teammate)
    harness.emit('agent/created', teammate)
    harness.emit('agent/created', unrelated)
    harness.emit('agent/disposed', lead)
    harness.emit('agent/created', lead)
    harness.dispose()

    expect(installed).toEqual(['lead', 'teammate', 'lead'])
    expect(disposed).toEqual(['lead', 'teammate', 'lead'])
  })
})
