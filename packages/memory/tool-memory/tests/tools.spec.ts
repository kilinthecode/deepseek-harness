import { mkdir, readdir, writeFile } from 'node:fs/promises'
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
import { createMemoryWriteTool } from '@deepseek-ai/dsh-tool-memory'
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

async function setup(config: Config = { injectMaxBytes: 2048, maxRecallResults: 2, maxRecallBytes: 8192 }) {
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
    const recallParameters = recall.parameters as { properties: Record<string, { enum?: string[]; description?: string }> }
    expect(recallParameters.properties.scope?.enum).toEqual(['global', 'project'])
    expect(recallParameters.properties.query?.description).toBe('Case-insensitive phrase or whitespace-separated keywords in name, description, and content. Omit for newest memories.')
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
    const value = capped.value as {
      memories: { name: string; type: string; scope: string; description: string; content: string }[]
      hasMore: boolean
    }
    expect(value.memories).toHaveLength(2)
    expect(value.hasMore).toBe(true)
    expect(Object.keys(value.memories[0]!)).toEqual(['name', 'type', 'scope', 'description', 'content'])

    const pnpm = await call(ctx, 'memory_recall', { query: 'PNPM' }, agentAt(repo.cwd))
    expect(text(pnpm)).toBe(
      '## prefers-pnpm [user, global]\nUses pnpm\n\nAlways pnpm.\n\n'
      + '## build [project, project]\nHow to build\n\npnpm run build',
    )
    const outside = await call(ctx, 'memory_recall', { query: 'build' })
    expect(text(outside)).toBe('No saved memories match.')

    const projectOnly = await call(ctx, 'memory_recall', { scope: 'project' }, agentAt(repo.cwd))
    expect(projectOnly.value).toMatchObject({ memories: [{ name: 'build', scope: 'project' }] })
    expect(projectOnly.value).not.toHaveProperty('hasMore')
  })

  it('keeps full UTF-8 bodies within maxRecallBytes and marks byte-omitted matches', async () => {
    const { ctx } = await setup({ injectMaxBytes: 0, maxRecallResults: 2, maxRecallBytes: 8192 })
    const body = `${'界'.repeat(1365)}x`
    await call(ctx, 'memory_write', { ...WRITE, name: 'large-a', content: body })
    await call(ctx, 'memory_write', { ...WRITE, name: 'large-b', content: 'y'.repeat(4096) })

    const recalled = await call(ctx, 'memory_recall', {})
    const value = recalled.value as { memories: { content: string }[]; hasMore: boolean }
    expect(value.memories).toHaveLength(1)
    expect(value.memories[0]?.content === body || value.memories[0]?.content === 'y'.repeat(4096)).toBe(true)
    expect(value.hasMore).toBe(true)
    expect(text(recalled)).toContain(value.memories[0]!.content)
    expect(text(recalled).endsWith('More matches; narrow query or scope.')).toBe(true)
    expect(Buffer.byteLength(text(recalled), 'utf8')).toBeLessThanOrEqual(8192)
  })

  it('fits a maximum-size record and the omission hint at the exact validated minimum budget', async () => {
    const { ctx, root } = await setup({ injectMaxBytes: 0, maxRecallResults: 2, maxRecallBytes: 4993 })
    const repo = await project(root, 'repo')
    const content = 'x'.repeat(4096)
    const description = '€'.repeat(256)
    const name = 'a'.repeat(64)
    await call(ctx, 'memory_write', {
      name: 'small', type: 'reference', scope: 'project', description: 'small', content: name,
    }, agentAt(repo.cwd))
    await call(ctx, 'memory_write', {
      name,
      type: 'reference',
      scope: 'project',
      description,
      content,
    }, agentAt(repo.cwd))

    const recalled = await call(ctx, 'memory_recall', { query: name }, agentAt(repo.cwd))
    expect(recalled.value).toMatchObject({ memories: [{ name, description, content }], hasMore: true })
    expect(text(recalled).endsWith('More matches; narrow query or scope.')).toBe(true)
    expect(Buffer.byteLength(text(recalled), 'utf8')).toBe(4993)
  })

  it('keeps checking prefixes when the final small block replaces a larger omission hint', async () => {
    const longBody = 'x'.repeat(2500)
    const longBlock = (name: string) => `## ${name} [user, global]\nUses pnpm\n\n${longBody}`
    const tinyBlock = '## tiny [user, global]\nSmall\n\nlarge'
    const prefix = `${longBlock('large-a')}\n\n${longBlock('large-b')}`
    const maxRecallBytes = Buffer.byteLength(prefix, 'utf8') + 2 + Buffer.byteLength(tinyBlock, 'utf8')
    const { ctx } = await setup({ injectMaxBytes: 2048, maxRecallResults: 3, maxRecallBytes })
    await call(ctx, 'memory_write', { ...WRITE, name: 'tiny', description: 'Small', content: 'large' })
    await call(ctx, 'memory_write', { ...WRITE, name: 'large-a', content: longBody })
    await call(ctx, 'memory_write', { ...WRITE, name: 'large-b', content: longBody })

    const recalled = await call(ctx, 'memory_recall', { query: 'large' })
    const recalledNames = (recalled.value as { memories: { name: string }[] }).memories.map(memory => memory.name)
    expect(recalledNames).toHaveLength(3)
    expect(recalledNames).toEqual(expect.arrayContaining(['large-a', 'large-b', 'tiny']))
    expect(recalled.value).not.toHaveProperty('hasMore')
    expect(Buffer.byteLength(text(recalled), 'utf8')).toBe(maxRecallBytes)
  })

  it('renders [blocked] for a recalled record whose content fails scan, alongside a clean record in the same result', async () => {
    // `write` scans before storing, so a blocked record can only reach the
    // store by another path: a hand-edited or pre-scan record file, seeded
    // here directly under the store's on-disk layout before the store opens.
    const root = await freshRoot()
    await mkdir(join(root, 'memory', 'global'), { recursive: true })
    await writeFile(
      join(root, 'memory', 'global', 'blocked-memory.json'),
      JSON.stringify({
        version: 1,
        record: {
          name: 'blocked-memory',
          type: 'user',
          scope: 'global',
          description: 'looks clean',
          content: 'has a zero width\u200Bspace inside',
          createdAt: '2026-09-19T00:00:00.000Z',
          updatedAt: '2026-09-19T00:00:00.000Z',
        },
      }),
    )
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await mountStore(ctx, root)
    await ctx.plugin(tool, { injectMaxBytes: 2048, maxRecallResults: 4, maxRecallBytes: 8192 })

    await call(ctx, 'memory_write', { name: 'clean-memory', type: 'user', scope: 'global', description: 'clean desc', content: 'clean content' })
    const result = await call(ctx, 'memory_recall', {})
    expect(result.isError).toBe(false)
    const rendered = text(result)
    expect(rendered).toContain('## blocked-memory [user, global]\n[blocked]')
    expect(rendered).not.toContain('zero width')
    expect(rendered).toContain('## clean-memory [user, global]\nclean desc\n\nclean content')
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

  it('matches the default memory_write definition in every field but execute, invoking wrapped callbacks with sample input since defineTool wraps them in fresh closures', async () => {
    const { ctx } = await setup()
    const replacing = createMemoryWriteTool(ctx.memory)
    const createOnly = createMemoryWriteTool(ctx.memory, { ifAbsent: true })

    // `defineTool` (packages/core/tools/src/schema.ts) wraps every user
    // callback — `presentCall`, `output.render`, and any `timeoutMs` /
    // `isConcurrencySafe` a future edit might add — in a fresh closure on
    // each call. That wrapper's own reference and source text are identical
    // across any two built definitions no matter what they close over, so
    // comparing them by reference or by `.toString()` would pass even if the
    // underlying behavior diverged. Comparing the own-key sets catches a
    // field only one variant declares; invoking the shared keys with the
    // same sample input and comparing the result catches a real behavioral
    // divergence between the two variants.
    expect(Object.keys(replacing).sort()).toEqual(Object.keys(createOnly).sort())
    expect(Object.keys(replacing.output).sort()).toEqual(Object.keys(createOnly.output).sort())
    expect(createOnly.name).toBe(replacing.name)
    expect(createOnly.description).toBe(replacing.description)
    expect(createOnly.parameters).toEqual(replacing.parameters)
    expect(createOnly.output.schema).toEqual(replacing.output.schema)
    const sampleValue = { name: 'prefers-pnpm', scope: 'global', outcome: 'created' }
    expect(createOnly.output.render(WRITE, sampleValue)).toEqual(replacing.output.render(WRITE, sampleValue))
    expect(createOnly.presentCall?.(WRITE)).toEqual(replacing.presentCall?.(WRITE))
  })

  it('keeps the default memory_write variant replacing an existing name and scope, not create-only', async () => {
    // Symmetric with the create-only rejection test below: a fresh mount
    // registers only the default (replacing) definition through the real
    // tool pipeline and drives two calls of the same name.
    const root = await freshRoot()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await mountStore(ctx, root)
    ctx.tools.register(createMemoryWriteTool(ctx.memory))
    const created = await call(ctx, 'memory_write', WRITE)
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ outcome: 'created' })
    const updated = await call(ctx, 'memory_write', { ...WRITE, description: 'still uses pnpm', content: 'updated content' })
    expect(updated.isError).toBe(false)
    expect(updated.value).toMatchObject({ outcome: 'updated' })
    const stored = await ctx.memory.recall({ limit: 1 })
    expect(stored[0]?.content).toBe('updated content')
  })

  it('rejects a create-only memory_write of an existing name and scope, leaving the record unchanged', async () => {
    // A fresh mount registers only the create-only definition (no plugin
    // apply(), so the default replacing one is never registered alongside
    // it) and drives it through the real tool pipeline, the same way the
    // scoped registration `installReviewRestrictions` installs is dispatched.
    const root = await freshRoot()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await mountStore(ctx, root)
    ctx.tools.register(createMemoryWriteTool(ctx.memory, { ifAbsent: true }))
    const created = await call(ctx, 'memory_write', WRITE)
    expect(created.isError).toBe(false)
    const conflict = await call(ctx, 'memory_write', { ...WRITE, description: 'clobber attempt', content: 'clobber' })
    expect(conflict.isError).toBe(true)
    expect(text(conflict)).toContain('already exists')
    const stored = await ctx.memory.recall({ limit: 1 })
    expect(stored[0]?.content).toBe(WRITE.content)
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
