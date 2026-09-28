/**
 * Real-composition proof for the optional `agent-crew` bundle
 * (`packages/AGENTS.md`: "Product-visible plugins require a non-unit
 * REAL-composition test").
 *
 * This mounts the real packages `cordis.patch.yml` names — `tool-subagent`
 * with the exact config that patch restates (read from the YAML, so the
 * test follows the file), `tool-subagent-worktree`, and `skill-agent-crew` —
 * over the same prerequisite services `dsh-base` provides (session/agent/tool
 * infrastructure, the subagent runtime and its `spawn` provider, the skill
 * registry, and the real `subagentWorktrees` service built from its schema
 * defaults, as the inert `dsh-base` row is). The tool mounts at the Host
 * level, as the patched `dsh-base` row does; profiles whose agent presets
 * mount `subagent` themselves are outside this composition. It does not go
 * through `@deepseek-ai/cordis-plugin-loader`'s package-name resolution:
 * that requires a staged fake installation directory (see
 * `packages/boot/app-boot/tests/profile.spec.ts`'s `stageInstallation`) to
 * resolve `@deepseek-ai/dsh-*` names to real workspace packages, and no
 * existing test boots the literal `packages/bundle/base/cordis.patch.yml`
 * that way — the closest precedents synthesize their own throwaway YAML.
 * Composing the real plugin modules directly is the same "real classes,
 * manual composition" style `scripts/gen-tool-catalog.ts` and
 * `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts`'s "subagent
 * tool worktree isolation" suite already use for this exact seam, so this
 * test asserts the same product-visible fact (this bundle's patch, applied
 * over dsh-base, yields a live composition with the isolation parameter, the
 * three worktree tools, and the skill) without a second git-worktree
 * implementation or a staged installation tree.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentWorktrees from '@deepseek-ai/dsh-subagent-worktree'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillAgentCrew from '@deepseek-ai/dsh-skill-agent-crew'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import SubagentModelSelectionConfig from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import * as ToolSubagentWorktree from '@deepseek-ai/dsh-tool-subagent-worktree'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

/** The `tool-subagent` config the bundle's patch restates, as written in `cordis.patch.yml`. */
function restatedToolSubagentConfig(): ToolSubagent.Config {
  const parsed = yaml.load(
    readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError('agent-crew patch must parse to a patch list')
  const row = (parsed as { id?: string; config?: ToolSubagent.Config }[]).find(candidate => candidate.id === 'tool-subagent')
  if (row?.config === undefined) throw new Error('agent-crew patch must restate the tool-subagent config')
  return row.config
}

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

  // The real subagent-worktree service, exactly as dsh-base's inert row
  // constructs it: its schema defaults, no configuration. This test proves
  // composition, not git behavior — owned by
  // `@deepseek-ai/dsh-subagent-worktree`'s own tests — so no method on it
  // is ever called here.
  new SubagentWorktrees(ctx, SubagentWorktrees.Config())
  return ctx
}

/** Mount `dsh-base`'s prerequisites and every row the agent-crew patch adds or restates. */
async function mountAgentCrew(): Promise<Context> {
  const ctx = await mountBasePrerequisites()
  // The agent-crew bundle's cordis.patch.yml, applied: the tool-subagent row
  // dsh-base ships, restated with worktreeIsolation switched on, plus the
  // two inserted rows.
  await ctx.plugin(ToolSubagent, restatedToolSubagentConfig())
  await ctx.plugin(ToolSubagentWorktree)
  await ctx.plugin(SkillAgentCrew)
  return ctx
}

type ParameterSchema = { type: string; enum?: string[]; description?: string }

/** The composed `subagent` tool: its description and parameter schemas. */
function composedSubagentTool(ctx: Context): { description: string; properties: Record<string, ParameterSchema> } {
  const schema = ctx.tools.schemas().find(candidate => candidate.name === 'subagent')
  if (schema === undefined) throw new Error('expected the subagent tool to be registered')
  return {
    description: schema.description,
    properties: (schema.parameters as { properties: Record<string, ParameterSchema> }).properties,
  }
}

describe('agent-crew bundle composition', () => {
  it('composes worktree-isolated subagent delegation, the three worktree tools, and the agent-crew skill', async () => {
    const ctx = await mountAgentCrew()

    expect(composedSubagentTool(ctx).properties.isolation).toMatchObject({ type: 'string', enum: ['worktree'] })

    const toolNames = ctx.tools.schemas().map(schema => schema.name)
    expect(toolNames).toEqual(expect.arrayContaining(['accept_worktree', 'discard_worktree', 'list_worktrees']))

    const skills = await ctx.skills.list()
    expect(skills.map(skill => skill.name)).toContain('agent-crew')
  })

  it('runs an unqualified subagent call as a background child the lead can message and is notified about', async () => {
    const { description, properties } = composedSubagentTool(await mountAgentCrew())

    // The agent-crew skill tells the lead to leave run_in_background unset and to wait for the
    // settlement notice; that holds only while the restated row keeps backgroundMode: continuable.
    expect(properties.run_in_background?.description).toContain('Defaults to true')
    expect(description).toContain('runs in the background by default')
    expect(description).toContain('`send_message`')
    expect(description).toContain('you are notified when the run settles')
  })

  it('offers every field of the skill\'s spawn snippet except the route fields it marks optional', async () => {
    const ctx = await mountAgentCrew()
    const { properties } = composedSubagentTool(ctx)
    const skill = await ctx.skills.get('agent-crew')
    const snippet = /```\nsubagent\(\{\n([\s\S]*?)\}\)\n```/.exec(skill?.content ?? '')?.[1]
    if (snippet === undefined) throw new Error('expected the skill body to carry a subagent call snippet')
    const fields = [...snippet.matchAll(/^ {2}(\w+):/gm)].map(match => match[1]!)

    expect(fields).toEqual(['description', 'prompt', 'isolation', 'provider', 'model'])
    for (const field of fields.filter(candidate => candidate !== 'provider' && candidate !== 'model')) {
      expect(properties[field], `the composed subagent tool has no "${field}" parameter`).toBeDefined()
    }
    // This composition does not enable model selection, so the tool omits the route fields and
    // rejects a call that supplies them; the snippet therefore marks them optional.
    expect(properties.provider).toBeUndefined()
    expect(properties.model).toBeUndefined()
  })

  it('cannot enable route selection on its Host-level row, which is why the patch omits modelSelectionSettings', async () => {
    const withFlag = () => Object.assign(restatedToolSubagentConfig(), { modelSelectionSettings: true })

    // A profile without the Web bundle's Host setting: the row would fail to load and take the subagent tool with it.
    await expect((await mountBasePrerequisites()).plugin(ToolSubagent, withFlag()))
      .rejects.toThrow('requires @deepseek-ai/dsh-tool-subagent/model-selection-settings')

    const ctx = await mountBasePrerequisites()
    // The Host setting the Web bundle mounts, enabled with one allowed route.
    await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: [{ provider: 'mock', model: 'mock' }] })
    // Route selection samples a per-session decision and installs the tool inside each agent preset's scope, so a
    // standing row outside a preset is rejected even with the Host setting present. When the tool learns to serve
    // an unscoped row, this rejection goes away and the patch can restate modelSelectionSettings: true.
    await expect(ctx.plugin(ToolSubagent, withFlag())).rejects.toThrow('requires a scoped preset Context')
  })
})
