/**
 * Registration scaffolding shared by the model-facing Agent Teams tool packages.
 * Each tool set owns its own tools, policy text, and per-Agent configuration;
 * this module owns the parts that are the same for every one of them: the
 * compact JSON output declaration, the Agent carrier the scoped tool seat
 * supplies, and the lifecycle that installs and releases a tool set per member.
 * @module @deepseek-ai/dsh-experimental-agent-team/tool-scaffold
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * result of a tool built on this scaffold is a fixed record, so the declared
 * schema is what makes the compiler check `execute` against the value the model
 * is promised.
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
 * @param agent - calling Agent supplied by the scoped tool seat.
 * @param toolName - registered tool name named in the failure.
 * @returns the exact live Agent that called the tool.
 */
export function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- the tool is registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Registrations collected while one tool set is built, released together. */
export interface ToolDisposers {
  /**
   * Collect one registration's disposer.
   * @param disposer - releases the registration that returned it.
   */
  register(disposer: () => unknown): void
  /** Release every collected registration, in reverse order, at most once. */
  dispose(): void
}

/**
 * Collect the registrations of one tool set so a failed build and a later
 * disposal release exactly what was registered.
 * @returns the collector and its idempotent release.
 */
export function toolDisposers(): ToolDisposers {
  let disposers: Array<() => unknown> = []
  return {
    register: (disposer) => { disposers.push(disposer) },
    dispose: () => {
      for (const dispose of disposers.reverse()) void dispose()
      disposers = []
    },
  }
}

/**
 * Install one package's scoped tools in every live or subsequently published
 * member Agent scope, releasing that Agent's tools when it is disposed or when
 * the plugin's fiber is.
 * @param ctx - plugin context carrying the agents service and Team membership.
 * @param effectLabel - registered effect name reported by Cordis diagnostics.
 * @param install - per-Agent registration returning its own disposer.
 */
export function installScopedTools(
  ctx: Context,
  effectLabel: string,
  install: (agent: Agent) => () => void,
): void {
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
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
  }, effectLabel)
}
