/**
 * Real-composition proof for the optional `agent-crew` bundle
 * (`packages/AGENTS.md`: "Product-visible plugins require a non-unit
 * REAL-composition test").
 *
 * This mounts the real packages `cordis.patch.yml` inserts —
 * `tool-subagent-worktree` and `skill-agent-crew` — over the rows `dsh-base`
 * provides that they build on: the `subagent-worktree` service, which the
 * patch leaves at its defaults, `tool-subagent` rows configured as the shipped
 * patch files configure them, and the prerequisite services (session/agent/tool
 * infrastructure, the subagent runtime and its `spawn` provider, and the skill
 * registry). Every `tool-subagent` config is read from the YAML, so the specs
 * follow the files. Each test mounts the rows in the order it names, because
 * the Loader starts sibling rows concurrently and no row order is guaranteed.
 * It does not go through `@deepseek-ai/cordis-plugin-loader`'s package-name
 * resolution: that requires a staged fake installation directory (see
 * `packages/boot/app-boot/tests/profile.spec.ts`'s `stageInstallation`) to
 * resolve `@deepseek-ai/dsh-*` names to real workspace packages. Composing the
 * real plugin modules directly is the same "real classes, manual composition"
 * style `scripts/gen-tool-catalog.ts` and
 * `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts`'s "subagent
 * tool worktree isolation" suite already use for this exact seam.
 * `loader-boot.spec.ts` boots the same rows through a real Loader, and
 * `delegation.spec.ts` runs one isolated delegation through them.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SubagentWorktrees from '@deepseek-ai/dsh-subagent-worktree'
import type { Config as WorktreesConfig } from '@deepseek-ai/dsh-subagent-worktree'
import * as SkillAgentCrew from '@deepseek-ai/dsh-skill-agent-crew'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import SubagentModelSelectionConfig from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import * as ToolSubagentWorktree from '@deepseek-ai/dsh-tool-subagent-worktree'
import { mountBasePrerequisites } from './base-prerequisites.ts'
import { hostToolSubagentConfig, presetToolSubagentConfig } from './patch-rows.ts'

const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

/** Mount the `dsh-base` services the agent-crew rows build on, on a context this suite disposes. */
async function mountBase(): Promise<Context> {
  const ctx = await mountBasePrerequisites()
  contexts.add(ctx)
  return ctx
}

/**
 * Mount the `subagent-worktree` service as `dsh-base` mounts it. This suite proves composition, not git behavior —
 * owned by `@deepseek-ai/dsh-subagent-worktree`'s own tests — so no method on the service is ever called here.
 * @param ctx - the context that owns the service.
 * @param config - service settings; the defaults `dsh-base` uses unless a test pins a reviewer route.
 */
function mountWorktreesService(ctx: Context, config: Partial<WorktreesConfig> = {}): void {
  new SubagentWorktrees(ctx, SubagentWorktrees.Config(config as WorktreesConfig))
}

/**
 * Mount the two rows the bundle inserts, in patch order.
 * @param ctx - the context to mount them on.
 * @returns the worktree tools' fiber, which registers the isolation offer, and the skill's fiber.
 */
async function mountBundleRows(ctx: Context) {
  return {
    worktreeTools: await ctx.plugin(ToolSubagentWorktree),
    skill: await ctx.plugin(SkillAgentCrew),
  }
}

/**
 * Mount the Host-level composition of a base-backed profile such as `headless`: the `subagent-worktree` service,
 * then the `dsh-base` `tool-subagent` row, then, unless the bundle is off, the two rows the bundle inserts.
 * @param options - `bundle: false` mounts the profile without the bundle's rows.
 * @returns the composed context.
 */
async function mountHostComposition(options: { bundle?: boolean } = {}): Promise<Context> {
  const ctx = await mountBase()
  mountWorktreesService(ctx)
  await ctx.plugin(ToolSubagent, hostToolSubagentConfig())
  if (options.bundle !== false) await mountBundleRows(ctx)
  return ctx
}

/**
 * Mount the `standard` Web preset's `tool-subagent` row in a preset scope, as agent presets mount it, and create
 * one lead Agent inside that scope.
 * @param ctx - the composed context, with the service and the bundle rows mounted or not as the test needs.
 * @param id - the lead's session id.
 * @returns the lead Agent, whose tool definitions live in its own scope.
 */
async function createPresetLead(ctx: Context, id: string): Promise<Agent> {
  // The Host setting the Web bundle mounts, enabled with the one route the preset row can select here.
  await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: [{ provider: 'mock', model: 'mock' }] })
  // The `standard` Web preset's own row, mounted in a preset scope as agent presets mount it.
  const preset = createScope(ctx, { preset: 'agent-crew-composition' })
  await preset.ctx.plugin(ToolSubagent, presetToolSubagentConfig())
  const { agent } = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: (agentCtx) => { bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!) },
  })
  return agent
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

  it('offers no isolation on the same tool row, and none of the worktree tools, while the bundle is off', async () => {
    // The service and the tool row are the profile's own; the bundle's rows are what turn isolation on.
    const ctx = await mountHostComposition({ bundle: false })

    expect(subagentTool(ctx).properties.isolation).toBeUndefined()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('accept_worktree')
  })

  it('offers isolation to a Host-level tool that mounted before the service and the bundle rows, and withdraws it with them', async () => {
    const ctx = await mountBase()
    // The Loader starts sibling rows concurrently: this tool mounts while `ctx.subagentWorktrees` does not exist yet.
    await ctx.plugin(ToolSubagent, hostToolSubagentConfig())
    expect(subagentTool(ctx).properties.isolation).toBeUndefined()
    mountWorktreesService(ctx)
    expect(subagentTool(ctx).properties.isolation).toBeUndefined()

    const rows = await mountBundleRows(ctx)
    expect(subagentTool(ctx).properties.isolation).toMatchObject({ type: 'string', enum: ['worktree'] })

    // Switching the bundle off disposes its rows.
    await rows.worktreeTools.dispose()
    await rows.skill.dispose()
    expect(subagentTool(ctx).properties.isolation).toBeUndefined()

    await mountBundleRows(ctx)
    expect(subagentTool(ctx).properties.isolation).toMatchObject({ type: 'string', enum: ['worktree'] })
  })

  it('offers isolation to a Host-level tool that mounts after the bundle rows', async () => {
    const ctx = await mountBase()
    mountWorktreesService(ctx)
    await mountBundleRows(ctx)
    await ctx.plugin(ToolSubagent, hostToolSubagentConfig())

    expect(subagentTool(ctx).properties.isolation).toMatchObject({ type: 'string', enum: ['worktree'] })
  })

  it('still offers isolation when the service row is configured with a reviewer route', async () => {
    // A profile or home patch that pins the reviewer replaces the service row's whole config; the bundle sets
    // nothing on that row, so the offer survives.
    const ctx = await mountBase()
    mountWorktreesService(ctx, { reviewerProvider: 'mock', reviewerModel: 'mock' })
    await ctx.plugin(ToolSubagent, hostToolSubagentConfig())
    await mountBundleRows(ctx)

    expect(subagentTool(ctx).properties.isolation).toMatchObject({ type: 'string', enum: ['worktree'] })
  })

  it('offers isolation on a preset-mounted row that never sets worktreeIsolation, beside the route fields', async () => {
    const ctx = await mountBase()
    mountWorktreesService(ctx)
    await mountBundleRows(ctx)
    const agent = await createPresetLead(ctx, 'crew-preset-lead')

    expect(presetToolSubagentConfig().worktreeIsolation).toBeUndefined()
    const { properties } = subagentTool(ctx, agent)
    expect(properties.isolation).toMatchObject({ type: 'string', enum: ['worktree'] })
    expect(properties.provider).toBeDefined()
    expect(properties.model).toBeDefined()
    expect(properties.reasoning_effort).toBeDefined()
  })

  it('gives an existing preset Agent the parameter when the bundle rows mount and takes it away when they go', async () => {
    const ctx = await mountBase()
    mountWorktreesService(ctx)
    const agent = await createPresetLead(ctx, 'crew-preset-toggle')
    expect(subagentTool(ctx, agent).properties.isolation).toBeUndefined()

    const rows = await mountBundleRows(ctx)
    expect(subagentTool(ctx, agent).properties.isolation).toMatchObject({ type: 'string', enum: ['worktree'] })

    await rows.worktreeTools.dispose()
    expect(subagentTool(ctx, agent).properties.isolation).toBeUndefined()
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
