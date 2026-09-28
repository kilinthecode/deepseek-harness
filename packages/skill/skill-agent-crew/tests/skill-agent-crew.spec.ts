import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillAgentCrew from '@deepseek-ai/dsh-skill-agent-crew'

describe('dsh-skill-agent-crew', () => {
  it('registers and disposes the bundled agent-crew skill', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillAgentCrew)
    const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))

    expect(await ctx.skills.list()).toEqual([{
      name: 'agent-crew',
      description: 'Split a goal across worker agents that each work in their own git worktree, with an independent reviewer checking every change before it merges. Use for work with two or more separable parts or when a change needs independent verification; skip it for small single-step edits.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'agent-crew',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: resourcePath },
    }])
    const loaded = await ctx.skills.get('agent-crew')
    expect(loaded?.content).toContain('## When not to use')
    expect(loaded?.content).toContain('isolation: "worktree"')
    expect(loaded?.content).toContain('dsh agents run')
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: resourcePath })

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in SkillAgentCrew).toBe(false)
    expect(SkillAgentCrew.name).toBe('skill-agent-crew')
    expect(SkillAgentCrew.inject).toEqual(['skills'])
    expect(typeof SkillAgentCrew.apply).toBe('function')
  })
})
