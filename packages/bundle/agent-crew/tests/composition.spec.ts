/**
 * Real-composition proof for the optional `agent-crew` bundle
 * (`packages/AGENTS.md`: "Product-visible plugins require a non-unit
 * REAL-composition test").
 *
 * This mounts the real packages `cordis.patch.yml` names — the
 * `subagent-worktree` service configured as that patch configures it,
 * `tool-subagent` rows configured as the shipped patch files configure them,
 * `tool-subagent-worktree`, and `skill-agent-crew` — over the same
 * prerequisite services `dsh-base` provides (session/agent/tool
 * infrastructure, the subagent runtime and its `spawn` provider, and the skill
 * registry). Every config is read from the YAML, so the specs follow the
 * files. It does not go through `@deepseek-ai/cordis-plugin-loader`'s
 * package-name resolution: that requires a staged fake installation directory
 * (see `packages/boot/app-boot/tests/profile.spec.ts`'s `stageInstallation`) to
 * resolve `@deepseek-ai/dsh-*` names to real workspace packages, and no
 * existing test boots the literal `packages/bundle/base/cordis.patch.yml`
 * that way — the closest precedents synthesize their own throwaway YAML.
 * Composing the real plugin modules directly is the same "real classes,
 * manual composition" style `scripts/gen-tool-catalog.ts` and
 * `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts`'s "subagent
 * tool worktree isolation" suite already use for this exact seam.
 * `delegation.spec.ts` runs one isolated delegation through the same rows.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentWorktrees from '@deepseek-ai/dsh-subagent-worktree'
import type { Config as WorktreesConfig } from '@deepseek-ai/dsh-subagent-worktree'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillAgentCrew from '@deepseek-ai/dsh-skill-agent-crew'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import SubagentModelSelectionConfig from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import * as ToolSubagentWorktree from '@deepseek-ai/dsh-tool-subagent-worktree'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import {
  crewWorktreesConfig,
  hostToolSubagentConfig,
  presetToolSubagentConfig,
  shippedWorktreesConfig,
} from './patch-rows.ts'

const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

/** Mount the services `dsh-base` provides that the agent-crew rows build on. */
async function mountBasePrerequisites(): Promise<Context> {
  const ctx = new Context()
  contexts.add(ctx)
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

/**
 * Mount the Host-level composition of a base-backed profile such as `headless`: the `subagent-worktree` service,
 * then the `dsh-base` `tool-subagent` row, then the two rows the bundle inserts.
 * @param worktrees - the service config; the agent-crew patch's by default.
 * @returns the composed context.
 */
async function mountHostComposition(worktrees: WorktreesConfig = crewWorktreesConfig()): Promise<Context> {
  const ctx = await mountBasePrerequisites()
  // This test proves composition, not git behavior — owned by
  // `@deepseek-ai/dsh-subagent-worktree`'s own tests — so no method on the
  // service is ever called here.
  new SubagentWorktrees(ctx, worktrees)
  await ctx.plugin(ToolSubagent, hostToolSubagentConfig())
  await ctx.plugin(ToolSubagentWorktree)
  await ctx.plugin(SkillAgentCrew)
  return ctx
}

type ParameterSchema = { type: string; enum?: string[]; description?: string }

/** The registered `subagent` tool as one agent sees it: its description and parameter schemas. */
function subagentTool(ctx: Context, agent?: Agent): { description: string; properties: Record<string, ParameterSchema> } {
  const schema = ctx.tools.schemas(agent).find(candidate => candidate.name === 'subagent')
  if (schema === undefined) throw new Error('expected the subagent tool to be registered')
  return {
    description: schema.description,
    properties: (schema.parameters as { properties: Record<string, ParameterSchema> }).properties,
  }
}

describe('agent-crew bundle composition', () => {
  it('composes worktree-isolated subagent delegation, the three worktree tools, and the agent-crew skill', async () => {
    const ctx = await mountHostComposition()

    expect(subagentTool(ctx).properties.isolation).toMatchObject({ type: 'string', enum: ['worktree'] })

    const toolNames = ctx.tools.schemas().map(schema => schema.name)
    expect(toolNames).toEqual(expect.arrayContaining(['accept_worktree', 'discard_worktree', 'list_worktrees']))

    const skills = await ctx.skills.list()
    expect(skills.map(skill => skill.name)).toContain('agent-crew')
  })

  it('offers no isolation on the same tool row while the bundle is off', async () => {
    // A profile without the bundle leaves the service row at its defaults, so the bundle's setting is what
    // turns isolation on.
    const ctx = await mountHostComposition(shippedWorktreesConfig())

    expect(subagentTool(ctx).properties.isolation).toBeUndefined()
  })

  it('offers isolation on a preset-mounted row that never sets worktreeIsolation, beside the route fields', async () => {
    const ctx = await mountBasePrerequisites()
    new SubagentWorktrees(ctx, crewWorktreesConfig())
    // The Host setting the Web bundle mounts, enabled with the one route the preset row can select here.
    await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: [{ provider: 'mock', model: 'mock' }] })
    // The `standard` Web preset's own row, mounted in a preset scope as agent presets mount it.
    const presetRow = presetToolSubagentConfig()
    const preset = createScope(ctx, { preset: 'agent-crew-composition' })
    await preset.ctx.plugin(ToolSubagent, presetRow)
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('crew-preset-lead'),
      setup: (agentCtx) => { bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!) },
    })

    expect(presetRow.worktreeIsolation).toBeUndefined()
    const { properties } = subagentTool(ctx, agent)
    expect(properties.isolation).toMatchObject({ type: 'string', enum: ['worktree'] })
    expect(properties.provider).toBeDefined()
    expect(properties.model).toBeDefined()
    expect(properties.reasoning_effort).toBeDefined()
  })

  it('runs an unqualified subagent call as a background child the lead can message and is notified about', async () => {
    const { description, properties } = subagentTool(await mountHostComposition())

    // The agent-crew skill tells the lead to leave run_in_background unset and to wait for the
    // settlement notice; that holds only while the `dsh-base` row keeps backgroundMode: continuable.
    expect(properties.run_in_background?.description).toContain('Defaults to true')
    expect(description).toContain('runs in the background by default')
    expect(description).toContain('`send_message`')
    expect(description).toContain('you are notified when the run settles')
  })

  it('offers every field of the skill\'s spawn snippet except the route fields it marks optional', async () => {
    const ctx = await mountHostComposition()
    const { properties } = subagentTool(ctx)
    const skill = await ctx.skills.get('agent-crew')
    const snippet = /```\nsubagent\(\{\n([\s\S]*?)\}\)\n```/.exec(skill?.content ?? '')?.[1]
    if (snippet === undefined) throw new Error('expected the skill body to carry a subagent call snippet')
    const fields = [...snippet.matchAll(/^ {2}(\w+):/gm)].map(match => match[1]!)

    expect(fields).toEqual(['description', 'prompt', 'isolation', 'provider', 'model'])
    for (const field of fields.filter(candidate => candidate !== 'provider' && candidate !== 'model')) {
      expect(properties[field], `the composed subagent tool has no "${field}" parameter`).toBeDefined()
    }
    // The Host-level row enables no model selection, so the tool omits the route fields and
    // rejects a call that supplies them; the snippet therefore marks them optional.
    expect(properties.provider).toBeUndefined()
    expect(properties.model).toBeUndefined()
  })
})
