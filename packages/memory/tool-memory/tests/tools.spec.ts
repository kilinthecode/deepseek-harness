import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as tool from '@deepseek-ai/dsh-tool-memory'
import type { Config } from '@deepseek-ai/dsh-tool-memory'
import { cleanupRoots, freshRoot, mountStore, project, sessionAgent, sessionAt } from './helpers.ts'

const signal = new AbortController().signal
const contexts: Context[] = []
let calls = 0

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await cleanupRoots()
})

/** An agent whose session header carries `cwd`; the tools read only that field. */
function agentAt(cwd?: string): Agent {
  return sessionAgent(sessionAt(cwd, 'agent'))
}

async function setup(config: Config = { injectMaxBytes: 2048, maxRecallResults: 2 }) {
  const root = await freshRoot()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await mountStore(ctx, root)
  const fiber = await ctx.plugin(tool, config)
  return { ctx, fiber, root }
}

/** Execute one tool; `null` runs it without an owning agent. */
function call(ctx: Context, name: string, args: unknown, agent: Agent | null = agentAt()) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent === null ? {} : { agent },
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const WRITE = { name: 'prefers-pnpm', type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Always pnpm.' }

describe('memory tools', () => {
  it('registers memory_write, memory_recall, and memory_forget with enum-constrained schemas', async () => {
    const { ctx } = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(['memory_write', 'memory_recall', 'memory_forget']))
    const write = ctx.tools.schemas().find(schema => schema.name === 'memory_write')!
    const props = (write.parameters as { properties: Record<string, { enum?: string[] }>; required?: string[] })
    expect(Object.keys(props.properties)).toEqual(['name', 'type', 'scope', 'description', 'content'])
    expect(props.properties.type?.enum).toEqual(['user', 'feedback', 'project', 'reference'])
    expect(props.properties.scope?.enum).toEqual(['global', 'project'])
    const recall = ctx.tools.schemas().find(schema => schema.name === 'memory_recall')!
    expect((recall.parameters as { required?: string[] }).required ?? []).toEqual([])
  })

  it('writes a global memory, reports created then updated, and stores one document', async () => {
    const { ctx, root } = await setup()
    const first = await call(ctx, 'memory_write', WRITE)
    expect(first.isError).toBe(false)
    expect(first.value).toEqual({ name: 'prefers-pnpm', scope: 'global', outcome: 'created' })
    expect(text(first)).toBe('Saved global memory "prefers-pnpm".')
    const second = await call(ctx, 'memory_write', { ...WRITE, content: 'pnpm, and never npm.' })
    expect(text(second)).toBe('Updated global memory "prefers-pnpm".')
    expect(await readdir(join(root, 'memory', 'global'))).toEqual(['prefers-pnpm.json'])
  })

  it('scopes a project memory by the calling session working directory and fails loud without one', async () => {
    const { ctx, root } = await setup()
    const repo = await project(root, 'repo')
    const inside = await call(ctx, 'memory_write', { ...WRITE, scope: 'project', type: 'project' }, agentAt(repo.cwd))
    expect(inside.isError).toBe(false)
    expect(inside.value).toMatchObject({ scope: 'project', outcome: 'created' })
    expect(await readdir(join(root, 'memory', 'project'))).toHaveLength(1)

    const nowhere = await call(ctx, 'memory_write', { ...WRITE, scope: 'project' })
    expect(nowhere.isError).toBe(true)
    expect(text(nowhere)).toContain('project scope is unavailable')
    expect(text(nowhere)).toContain('use scope "global"')
  })

  it('surfaces store validation as tool errors', async () => {
    const { ctx } = await setup()
    const badName = await call(ctx, 'memory_write', { ...WRITE, name: 'Not Kebab' })
    expect(badName.isError).toBe(true)
    expect(text(badName)).toContain('name must match')
    const badType = await call(ctx, 'memory_write', { ...WRITE, type: 'note' })
    expect(badType.isError).toBe(true)
  })

  it('recalls rendered memories within the configured cap and reports an empty match', async () => {
    const { ctx, root } = await setup()
    const repo = await project(root, 'repo')
    await call(ctx, 'memory_write', WRITE)
    await call(ctx, 'memory_write', { ...WRITE, name: 'editor', description: 'Editor', content: 'Cursor' })
    await call(ctx, 'memory_write', { ...WRITE, name: 'build', type: 'project', scope: 'project', description: 'How to build', content: 'pnpm run build' }, agentAt(repo.cwd))

    const capped = await call(ctx, 'memory_recall', {}, agentAt(repo.cwd))
    expect(capped.isError).toBe(false)
    const value = capped.value as { memories: { name: string; type: string; scope: string; description: string; content: string }[] }
    expect(value.memories).toHaveLength(2)
    expect(Object.keys(value.memories[0]!)).toEqual(['name', 'type', 'scope', 'description', 'content'])

    const pnpm = await call(ctx, 'memory_recall', { query: 'PNPM' }, agentAt(repo.cwd))
    expect(text(pnpm)).toBe(
      '## build [project, project]\nHow to build\n\npnpm run build\n\n'
      + '## prefers-pnpm [user, global]\nUses pnpm\n\nAlways pnpm.',
    )
    const outside = await call(ctx, 'memory_recall', { query: 'build' })
    expect(text(outside)).toBe('No saved memories match.')
  })

  it('forgets a memory and reports a missing one', async () => {
    const { ctx } = await setup()
    await call(ctx, 'memory_write', WRITE)
    const gone = await call(ctx, 'memory_forget', { name: 'prefers-pnpm', scope: 'global' })
    expect(gone.isError).toBe(false)
    expect(gone.value).toEqual({ name: 'prefers-pnpm', scope: 'global' })
    expect(text(gone)).toBe('Forgot global memory "prefers-pnpm".')
    const missing = await call(ctx, 'memory_forget', { name: 'prefers-pnpm', scope: 'global' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('no global memory named "prefers-pnpm"')
  })

  it('rejects a caller without an owning agent session', async () => {
    const { ctx } = await setup()
    for (const [name, args] of [
      ['memory_write', WRITE],
      ['memory_recall', {}],
      ['memory_forget', { name: 'x', scope: 'global' }],
    ] as const) {
      const result = await call(ctx, name, args, null)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(`${name} requires an owning agent session`)
    }
  })

  it('presents each call as a generic card with the arguments as raw input', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('memory_write')?.presentCall?.(WRITE))
      .toEqual({ card: 'generic', title: 'Save memory', kind: 'other', rawInput: WRITE })
    expect(ctx.tools.get('memory_recall')?.presentCall?.({ query: 'pnpm' }))
      .toEqual({ card: 'generic', title: 'Recall memories', kind: 'search', rawInput: { query: 'pnpm' } })
    expect(ctx.tools.get('memory_forget')?.presentCall?.({ name: 'x', scope: 'global' }))
      .toEqual({ card: 'generic', title: 'Forget memory', kind: 'other', rawInput: { name: 'x', scope: 'global' } })
  })

  it('contributes the memory prompt section and unregisters everything with its fiber', async () => {
    const { ctx, fiber } = await setup()
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'tool:memory')
    expect(section?.text).toBe(tool.MEMORY_SECTION_TEXT)
    expect(section?.text).toContain('memory_recall')
    await fiber.dispose()
    expect(ctx.tools.get('memory_write')).toBeUndefined()
    expect(ctx.tools.get('memory_recall')).toBeUndefined()
    expect(ctx.tools.get('memory_forget')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.some(item => item.name === 'tool:memory')).toBe(false)
  })
})
