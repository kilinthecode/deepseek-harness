import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillAgentCrew from '@deepseek-ai/dsh-skill-agent-crew'

/** The skill body as the registry serves it to the model. */
async function loadBody(): Promise<string> {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillAgentCrew)
    const loaded = await ctx.skills.get('agent-crew')
    if (loaded === undefined) throw new Error('expected the agent-crew skill to load')
    return loaded.content
  } finally {
    await ctx.fiber.dispose()
  }
}

/** The text under one `## ` heading, up to the next `## ` heading. */
function sectionOf(content: string, heading: string): string {
  const start = content.indexOf(`## ${heading}\n`)
  if (start < 0) throw new Error(`the skill body has no "## ${heading}" section`)
  const next = content.indexOf('\n## ', start + 1)
  return content.slice(start, next < 0 ? undefined : next)
}

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

    // The land/fix/discard workflow must name every tool the crew uses to
    // settle a worktree, not just some of them.
    const content = loaded?.content ?? ''
    const sectionStart = content.indexOf('## Land, fix, or discard each part')
    const sectionEnd = content.indexOf('## Report back')
    expect(sectionStart).toBeGreaterThanOrEqual(0)
    expect(sectionEnd).toBeGreaterThan(sectionStart)
    const landSection = content.slice(sectionStart, sectionEnd)
    for (const toolName of ['accept_worktree', 'send_message', 'discard_worktree', 'list_worktrees']) {
      expect(landSection).toContain(toolName)
    }
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

  describe('skill body', () => {
    it('marks provider and model as optional in the spawn snippet, because the tool lists them only when model selection is on', async () => {
      const spawn = sectionOf(await loadBody(), 'Spawn one worker per part')

      expect(spawn).toMatch(/\/\/ [^\n]*only if the tool lists provider and model[^\n]*\n\s*provider: [^\n]*\n\s*model: /)
    })

    it('has the lead leave run_in_background unset so each worker stays a background child it can message', async () => {
      const spawn = sectionOf(await loadBody(), 'Spawn one worker per part')

      expect(spawn).toContain('Leave `run_in_background` unset: each worker then runs as a background child you can message')
    })

    it('tells the lead that workers cannot reach each other or start workers, and that a cheaper worker is reviewed on the lead\'s model', async () => {
      const spawn = sectionOf(await loadBody(), 'Spawn one worker per part')

      expect(spawn).toContain('Workers cannot message each other or start workers of their own; all coordination goes through you.')
      expect(spawn).toContain('a worker on a cheaper model is reviewed on yours')
    })

    it('has the lead accept when notified that a worker settled, because accepting a running worker is refused', async () => {
      const land = sectionOf(await loadBody(), 'Land, fix, or discard each part')

      expect(land).toContain('You are notified when each worker settles; accept its worktree then, because `accept_worktree` refuses a worker that is still running.')
      // The fix loop waits for the settlement notice before it accepts again.
      expect(land).toMatch(/\*\*Rejected\*\*[^\n]*`send_message`[^\n]*wait until you are notified it settled[^\n]*`accept_worktree` again/)
    })

    it('recovers the worker to message from list_worktrees after a compaction', async () => {
      const land = sectionOf(await loadBody(), 'Land, fix, or discard each part')

      expect(land).toContain('call `list_worktrees` to recover which open worktree belongs to which part and which worker to message')
    })

    it('has an Empty outcome that discards the worktree or sends the worker what is missing', async () => {
      const land = sectionOf(await loadBody(), 'Land, fix, or discard each part')

      expect(land).toContain(
        '- **Empty** — the worker changed nothing. Call `discard_worktree`, or send the worker what is missing and accept again.',
      )
    })

    it('stays within the skill body budget, because a loaded skill occupies the model\'s context', async () => {
      const words = (await loadBody()).split(/\s+/).filter(word => word.length > 0)

      expect(words.length).toBeLessThan(900)
    })
  })
})
