import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { MemoryRecord, MemoryVisible } from '@deepseek-ai/dsh-memory'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as tool from '@deepseek-ai/dsh-tool-memory'
import { EMPTY_CATALOG_TEXT, renderCatalog } from '@deepseek-ai/dsh-tool-memory'
import type { MemoryCatalogState } from '@deepseek-ai/dsh-tool-memory'
import { catalogEvents, cleanupRoots, freshRoot, mountStore, project, sessionAgent, sessionAt } from './helpers.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'someone-else': { kind: 'someone-else' } & ContextFormed
  }
}

const SIGNAL = new AbortController().signal
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await cleanupRoots()
})

function record(name: string, type: MemoryRecord['type'], scope: MemoryRecord['scope'], description: string): MemoryRecord {
  return {
    name: name as MemoryRecord['name'],
    type,
    scope,
    description,
    content: 'body',
    ...scope === 'project' ? { projectRoot: '/repo' } : {},
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  }
}

describe('renderCatalog', () => {
  it('returns nothing for an empty store', () => {
    expect(renderCatalog({ global: [] }, 2048)).toBeUndefined()
    expect(renderCatalog({ global: [], project: { root: '/repo', records: [] } }, 2048)).toBeUndefined()
  })

  it('lists global before project entries, each section by type rank then name', () => {
    const visible: MemoryVisible = {
      global: [
        record('zeta-ref', 'reference', 'global', 'A dashboard'),
        record('review-style', 'feedback', 'global', 'Terse reviews'),
        record('name', 'user', 'global', 'Prefers they/them'),
        record('alpha-ref', 'reference', 'global', 'A ticket'),
      ],
      project: { root: '/repo', records: [record('build', 'project', 'project', 'pnpm run build')] },
    }
    expect(renderCatalog(visible, 2048)).toBe([
      'Saved memories (catalog; call memory_recall to read one):',
      'Global:',
      '- [user] name — Prefers they/them',
      '- [feedback] review-style — Terse reviews',
      '- [reference] alpha-ref — A ticket',
      '- [reference] zeta-ref — A dashboard',
      'Project:',
      '- [project] build — pnpm run build',
    ].join('\n'))
  })

  it('cuts from the end within the byte budget and says how many entries were omitted', () => {
    const visible: MemoryVisible = {
      global: [record('a', 'user', 'global', 'one'), record('b', 'user', 'global', 'two')],
      project: { root: '/repo', records: [record('c', 'project', 'project', 'three'), record('d', 'project', 'project', 'four')] },
    }
    const full = renderCatalog(visible, 4096)!
    // One byte short of the full catalog: three entries plus the omission line
    // would be longer than the full text, so two entries are kept.
    const cut = renderCatalog(visible, Buffer.byteLength(full, 'utf8') - 1)!
    expect(cut).toBe([
      'Saved memories (catalog; call memory_recall to read one):',
      'Global:',
      '- [user] a — one',
      '- [user] b — two',
      '… 2 more; use memory_recall',
    ].join('\n'))
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThan(Buffer.byteLength(full, 'utf8'))
    const oneEntry = [
      'Saved memories (catalog; call memory_recall to read one):',
      'Global:',
      '- [user] a — one',
      '… 3 more; use memory_recall',
    ].join('\n')
    expect(renderCatalog(visible, Buffer.byteLength(oneEntry, 'utf8'))).toBe(oneEntry)
    expect(renderCatalog(visible, Buffer.byteLength(oneEntry, 'utf8') - 1)).toBe(
      'Saved memories (catalog; call memory_recall to read one):\n… 4 more; use memory_recall',
    )
  })

  it('orders same-type names by code unit even where the host collation disagrees', () => {
    // Thai collation ignores punctuation, so it sorts `ab` before `a-c`; code-unit order puts `-` first.
    const thai = new Intl.Collator('th')
    const collate = vi.spyOn(String.prototype, 'localeCompare')
      .mockImplementation(function (this: string, that: string) { return thai.compare(this, that) })
    try {
      const visible: MemoryVisible = { global: [record('ab', 'user', 'global', 'two'), record('a-c', 'user', 'global', 'one')] }
      expect(['ab', 'a-c'].sort((left, right) => left.localeCompare(right))).toEqual(['ab', 'a-c'])
      expect(renderCatalog(visible, 2048)).toBe([
        'Saved memories (catalog; call memory_recall to read one):',
        'Global:',
        '- [user] a-c — one',
        '- [user] ab — two',
      ].join('\n'))
    } finally {
      collate.mockRestore()
    }
  })

  it('still names the omitted count when even one entry cannot fit', () => {
    const visible: MemoryVisible = { global: [record('a', 'user', 'global', 'x'.repeat(200))] }
    expect(renderCatalog(visible, 10)).toBe(
      'Saved memories (catalog; call memory_recall to read one):\n… 1 more; use memory_recall',
    )
  })
})

async function mount(config: tool.Config = { injectMaxBytes: 2048, maxRecallResults: 4 }) {
  const root = await freshRoot()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await mountStore(ctx, root)
  const fiber = await ctx.plugin(tool, config)
  return { ctx, root, fiber }
}

function catalogs(session: Session): string[] {
  return catalogEvents(session.snapshotEvents()).map(event => event.text)
}

async function fire(
  ctx: Context,
  agent: Agent,
  turn: number,
  step: number,
  signal: AbortSignal = SIGNAL,
  decide: () => Promise<PreStepDecision> = () => Promise.resolve({ kind: 'enter', messages: [] }),
): Promise<PreStepDecision> {
  const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn, step, signal }, decide)
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
  return decision
}

function appendCompactionSummary(session: Session): void {
  session.append('compaction/summary', {
    compactionId: 'compaction-1',
    summary: [{ type: 'text', text: 'summary' }],
    shadowedRange: { start: SessionSeq(0), end: SessionSeq(1) },
    shadowedSeqs: [SessionSeq(0), SessionSeq(1)],
    shadowedTokenCount: 10,
    provider: 'mock',
    model: 'mock',
  } as never)
}

const WRITE = { type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Always pnpm.' } as const

describe('catalog injection', () => {
  it('injects once per session, refreshes at a turn start only when the store changed, and re-injects after compaction', async () => {
    const { ctx, root } = await mount()
    const repo = await project(root, 'repo')
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    await ctx.memory.write({ ...WRITE, name: 'build', type: 'project', scope: 'project', cwd: repo.cwd, description: 'pnpm run build' })
    const session = sessionAt(repo.cwd)
    const agent = sessionAgent(session)

    await fire(ctx, agent, 1, 1)
    expect(catalogs(session)).toEqual([renderCatalog(await ctx.memory.visible(repo.cwd), 2048)])
    expect(catalogs(session)[0]).toContain('- [project] build — pnpm run build')

    await fire(ctx, agent, 1, 2)
    await fire(ctx, agent, 2, 1)
    expect(catalogs(session)).toHaveLength(1)

    await ctx.memory.write({ ...WRITE, name: 'editor', description: 'Uses Cursor' })
    await fire(ctx, agent, 2, 2)
    expect(catalogs(session)).toHaveLength(1)
    await fire(ctx, agent, 3, 1)
    expect(catalogs(session)).toHaveLength(2)
    expect(catalogs(session)[1]).toContain('- [user] editor — Uses Cursor')

    appendCompactionSummary(session)
    await fire(ctx, agent, 3, 4)
    expect(catalogs(session)).toHaveLength(3)
    expect(catalogs(session)[2]).toBe(catalogs(session)[1])
    expect((ctx.sessionProjections.stateOf(session, 'memoryCatalog') as MemoryCatalogState).lastCatalog).toBe(catalogs(session)[2])
  })

  it('supersedes the catalog with an explicit empty one at the next turn after the last memory is forgotten', async () => {
    const { ctx } = await mount()
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    const session = sessionAt(undefined)
    const agent = sessionAgent(session)
    await fire(ctx, agent, 1, 1)
    expect(catalogs(session)).toHaveLength(1)

    await ctx.memory.forget({ name: 'prefers-pnpm', scope: 'global' })
    // Later steps of the same turn keep the surface; the next turn's first step supersedes it.
    await fire(ctx, agent, 1, 2)
    expect(catalogs(session)).toHaveLength(1)
    await fire(ctx, agent, 2, 1)
    expect(catalogs(session)).toEqual([catalogs(session)[0], EMPTY_CATALOG_TEXT])
    expect((ctx.sessionProjections.stateOf(session, 'memoryCatalog') as MemoryCatalogState).lastCatalog).toBe(EMPTY_CATALOG_TEXT)

    // An empty store that already announced itself stays quiet.
    await fire(ctx, agent, 3, 1)
    expect(catalogs(session)).toHaveLength(2)

    // A later write replaces the empty catalog like any other change.
    await ctx.memory.write({ ...WRITE, name: 'editor', description: 'Uses Cursor' })
    await fire(ctx, agent, 4, 1)
    expect(catalogs(session)).toHaveLength(3)
    expect(catalogs(session)[2]).toContain('- [user] editor — Uses Cursor')
  })

  it('keeps checking every step while nothing has been injected, and shows global entries only without a project root', async () => {
    const { ctx } = await mount()
    const session = sessionAt(undefined)
    const agent = sessionAgent(session)
    await fire(ctx, agent, 1, 1)
    expect(catalogs(session)).toEqual([])
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    await fire(ctx, agent, 1, 2)
    expect(catalogs(session)).toEqual([
      'Saved memories (catalog; call memory_recall to read one):\nGlobal:\n- [user] prefers-pnpm — Uses pnpm',
    ])
  })

  it('passes a rejected step and an aborted signal through untouched', async () => {
    const { ctx } = await mount()
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    const session = sessionAt(undefined)
    const agent = sessionAgent(session)
    const rejected = await fire(ctx, agent, 1, 1, SIGNAL, () => Promise.resolve<PreStepDecision>({ kind: 'reject' }))
    expect(rejected.kind).toBe('reject')
    const aborted = new AbortController()
    aborted.abort()
    await fire(ctx, agent, 1, 1, aborted.signal)
    expect(catalogs(session)).toEqual([])
  })

  it('registers the projection but never injects when the budget is zero', async () => {
    const { ctx } = await mount({ injectMaxBytes: 0, maxRecallResults: 4 })
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    const session = sessionAt(undefined)
    await fire(ctx, sessionAgent(session), 1, 1)
    expect(catalogs(session)).toEqual([])
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ lastCatalog: null })
  })

  it('unregisters the catalog projection and the pre-step listener with its fiber', async () => {
    const { ctx, fiber } = await mount()
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    const before = sessionAt(undefined, 'before')
    await fire(ctx, sessionAgent(before), 1, 1)
    expect(catalogs(before)).toHaveLength(1)
    expect(ctx.sessionProjections.stateOf(before, 'memoryCatalog')).toEqual({ lastCatalog: catalogs(before)[0] })

    await fiber.dispose()
    const after = sessionAt(undefined, 'after')
    await fire(ctx, sessionAgent(after), 1, 1)
    expect(catalogs(after)).toEqual([])
    expect(ctx.sessionProjections.stateOf(after, 'memoryCatalog')).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(before, 'memoryCatalog')).toBeUndefined()
  })

  it('folds only its own catalog messages and leaves an already-clear state untouched by compaction', async () => {
    const { ctx } = await mount()
    const session = sessionAt(undefined)
    const before = ctx.sessionProjections.stateOf(session, 'memoryCatalog')
    appendCompactionSummary(session)
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toBe(before)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'foreign snapshot' }],
      source: { kind: 'someone-else', form: 'snapshot', sections: [{ name: 'x', text: 'foreign snapshot' }] },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'not a catalog' }],
      source: { kind: 'tool-memory', form: 'notice', summary: 'x' },
    }), { surfaceOp: 'append' })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ lastCatalog: null })
  })
})
