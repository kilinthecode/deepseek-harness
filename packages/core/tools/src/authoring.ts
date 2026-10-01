/** Shared helpers for authoring tools that return JSON from Agent scopes. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { InferValue, ValueSchemaSpec } from './schema.ts'

/**
 * Declare a value schema with compact JSON text as its model-facing rendering.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by `defineTool`.
 */
export function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/**
 * Recover the exact caller guaranteed by Agent-scoped tool discovery.
 * @param agent - the caller attached to the tool execution.
 * @param toolName - the tool name used in the missing-caller error.
 * @returns the exact calling Agent.
 * @throws When `agent` is absent, with `${toolName} requires a calling Agent`.
 */
export function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- Agent-scoped tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/**
 * Install tools in selected live and subsequently published Agent scopes.
 * Agent disposal removes its registrations; disposing the calling context
 * removes every remaining registration.
 * @param ctx - context with the Agent registry and lifecycle events.
 * @param matches - selects the Agents that receive the scoped registrations.
 * @param install - registers one Agent's tools and returns their disposer.
 * @param label - Cordis effect label for context-owned teardown.
 * @returns nothing; registrations are owned by the calling context.
 * @throws If `matches` or `install` throws; errors propagate through the current setup or Agent creation event.
 */
export function applyAgentScopedTools(
  ctx: Context,
  matches: (agent: Agent) => boolean,
  install: (agent: Agent) => () => void,
  label: string,
): void {
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || !matches(agent)) return
    installed.set(agent, install(agent))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, label)
}
