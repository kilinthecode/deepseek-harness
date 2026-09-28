/**
 * Real-composition proof for the optional `agent-crew` bundle
 * (`packages/AGENTS.md`: "Product-visible plugins require a non-unit
 * REAL-composition test").
 *
 * This mounts the real packages `cordis.patch.yml` names — `tool-subagent`
 * configured exactly as this bundle's patch restates it (`worktreeIsolation:
 * true` alongside dsh-base's `provider`/`toolName`/`backgroundMode`),
 * `tool-subagent-worktree`, and `skill-agent-crew` — over the same
 * prerequisite services `dsh-base` provides (session/agent/tool
 * infrastructure, the subagent runtime and its `spawn` provider, the skill
 * registry, and the real `subagentWorktrees` service). It does not go
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

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentWorktrees from '@deepseek-ai/dsh-subagent-worktree'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillAgentCrew from '@deepseek-ai/dsh-skill-agent-crew'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolSubagentWorktree from '@deepseek-ai/dsh-tool-subagent-worktree'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

describe('agent-crew bundle composition', () => {
  it('composes worktree-isolated subagent delegation, the three worktree tools, and the agent-crew skill', async () => {
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
    // constructs it. This test proves composition, not git behavior — owned
    // by `@deepseek-ai/dsh-subagent-worktree`'s own tests — so no method on
    // it is ever called here.
    new SubagentWorktrees(ctx, {
      branchPrefix: 'dsh/worktree/',
      maxWorktrees: 16,
      requireDistinctReviewer: false,
      testCommand: [],
      checkTimeoutMs: 900_000,
      reviewDiffMaxBytes: 49152,
      removeOnMerge: true,
    })

    // The agent-crew bundle's cordis.patch.yml, applied: the same
    // tool-subagent row dsh-base ships, restated with worktreeIsolation
    // switched on, plus the two inserted rows.
    await ctx.plugin(ToolSubagent, {
      provider: 'spawn',
      toolName: 'subagent',
      backgroundMode: 'continuable',
      worktreeIsolation: true,
    })
    await ctx.plugin(ToolSubagentWorktree)
    await ctx.plugin(SkillAgentCrew)

    const schemas = ctx.tools.schemas()
    const subagentSchema = schemas.find(schema => schema.name === 'subagent')
    if (subagentSchema === undefined) throw new Error('expected the subagent tool to be registered')
    const properties = (subagentSchema.parameters as { properties: Record<string, { type: string; enum?: string[] }> }).properties
    expect(properties.isolation).toMatchObject({ type: 'string', enum: ['worktree'] })

    const toolNames = schemas.map(schema => schema.name)
    expect(toolNames).toEqual(expect.arrayContaining(['accept_worktree', 'discard_worktree', 'list_worktrees']))

    const skills = await ctx.skills.list()
    expect(skills.map(skill => skill.name)).toContain('agent-crew')
  })
})
