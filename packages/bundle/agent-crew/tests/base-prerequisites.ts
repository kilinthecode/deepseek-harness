/** The `dsh-base` services the agent-crew rows build on, mounted on a fresh context for the specs to compose over. */

import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Mount the services `dsh-base` provides that the agent-crew rows build on: session, agent, and tool
 * infrastructure, the subagent runtime and its `spawn` provider, and the skill registry.
 * @returns the context; the caller disposes it.
 */
export async function mountBasePrerequisites(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  // Registered but never called: the tools this bundle adds mount and
  // report their schemas without starting a turn or a child.
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SkillRegistry)
  return ctx
}
