import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { MemoryRecord, MemoryScanFinding } from '@deepseek-ai/dsh-memory'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as tool from '@deepseek-ai/dsh-tool-memory'
import { renderSnapshot, SNAPSHOT_HEADER } from '@deepseek-ai/dsh-tool-memory'
import { cleanupRoots, freshRoot, mountStore, sessionAgent, sessionAt } from './helpers.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'someone-else': { kind: 'someone-else' } & ContextFormed
  }
}

const SIGNAL = new AbortController().signal
const contexts: Context[] = []
const noScan = (): MemoryScanFinding | undefined => undefined

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await cleanupRoots()
})

function record(
  name: string,
  type: MemoryRecord['type'],
  scope: MemoryRecord['scope'],
  description: string,
  content: string,
): MemoryRecord {
  return {
    name: name as MemoryRecord['name'],
    type,
    scope,
    description,
    content,
    ...scope === 'project' ? { projectRoot: '/repo' } : {},
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  }
}

describe('renderSnapshot', () => {
  it('returns undefined for an empty record list regardless of budget', () => {
    expect(renderSnapshot([], 2048, noScan)).toBeUndefined()
    expect(renderSnapshot([], 0, noScan)).toBeUndefined()
  })

  it('returns undefined when the budget cannot hold the header, even with records present', () => {
    const records = [record('a', 'user', 'global', 'x'.repeat(200), 'y'.repeat(5000))]
    expect(renderSnapshot(records, 10, noScan)).toBeUndefined()
    expect(renderSnapshot(records, Buffer.byteLength(SNAPSHOT_HEADER, 'utf8'), noScan)).toBeUndefined()
  })

  it('sorts type-first (user, feedback, project, reference), then name, then global before project, and renders exact text', () => {
    const records = [
      record('zeta', 'reference', 'project', 'Zeta project desc', 'Zeta project content'),
      record('alice', 'user', 'global', 'Alice desc', 'Alice content'),
      record('zeta', 'reference', 'global', 'Zeta global desc', 'Zeta global content'),
      record('carl', 'feedback', 'global', 'Carl desc', 'Carl content'),
      record('bob', 'user', 'project', 'Bob desc', 'Bob content'),
    ]
    const expected = [
      SNAPSHOT_HEADER,
      '## alice [user, global]',
      'Alice desc',
      '',
      'Alice content',
      '',
      '## bob [user, project]',
      'Bob desc',
      '',
      'Bob content',
      '',
      '## carl [feedback, global]',
      'Carl desc',
      '',
      'Carl content',
      '',
      '## zeta [reference, global]',
      'Zeta global desc',
      '',
      'Zeta global content',
      '',
      '## zeta [reference, project]',
      'Zeta project desc',
      '',
      'Zeta project content',
    ].join('\n')
    expect(renderSnapshot(records, 4096, noScan)).toBe(expected)
  })

  it('orders same-type names by code unit, not host locale collation', () => {
    // '-' (U+002D) sorts before 'b' (U+0062) by code unit; a locale that
    // ignores punctuation (e.g. Thai) would sort 'ab' first instead.
    const records = [record('ab', 'user', 'global', 'two', 'c2'), record('a-c', 'user', 'global', 'one', 'c1')]
    expect(renderSnapshot(records, 4096, noScan)).toBe([
      SNAPSHOT_HEADER,
      '## a-c [user, global]',
      'one',
      '',
      'c1',
      '',
      '## ab [user, global]',
      'two',
      '',
      'c2',
    ].join('\n'))
  })

  it('breaks a type-and-name tie by scope (global before project) regardless of input order', () => {
    const globalTied = record('same-name', 'reference', 'global', 'g desc', 'g content')
    const projectTied = record('same-name', 'reference', 'project', 'p desc', 'p content')
    const expected = [
      SNAPSHOT_HEADER,
      '## same-name [reference, global]',
      'g desc',
      '',
      'g content',
      '',
      '## same-name [reference, project]',
      'p desc',
      '',
      'p content',
    ].join('\n')
    expect(renderSnapshot([projectTied, globalTied], 4096, noScan)).toBe(expected)
    expect(renderSnapshot([globalTied, projectTied], 4096, noScan)).toBe(expected)
  })

  it('falls back to an index line, with a blank line separating it from a preceding block, when the full block does not fit', () => {
    const records = [
      record('a', 'user', 'global', 'short a', 'tiny'),
      record('b', 'user', 'global', 'short b', 'Y'.repeat(5000)),
    ]
    expect(renderSnapshot(records, 4096, noScan)).toBe([
      SNAPSHOT_HEADER,
      '## a [user, global]',
      'short a',
      '',
      'tiny',
      '',
      '- [user, global] b — short b',
    ].join('\n'))
  })

  it('omits entries that do not fit even as an index line, appends the omission line, and shrinks trailing entries to stay within budget', () => {
    const A = record('a', 'user', 'global', 'one', 'X'.repeat(5000))
    const B = record('b', 'user', 'global', 'this description is long enough to matter here for the shrink test', 'X'.repeat(5000))
    const records = [A, B]

    const twoIndex = [
      SNAPSHOT_HEADER,
      '- [user, global] a — one',
      '- [user, global] b — this description is long enough to matter here for the shrink test',
    ].join('\n')
    expect(renderSnapshot(records, Buffer.byteLength(twoIndex, 'utf8'), noScan)).toBe(twoIndex)

    // One byte short of both index lines: B's index line (89 bytes) is larger
    // than an omission line (29 bytes), so dropping it and appending the
    // omission line nets a smaller total — the one-kept-one-omitted state.
    const oneIndexOneOmitted = [
      SNAPSHOT_HEADER,
      '- [user, global] a — one',
      '… 1 more; use memory_recall',
    ].join('\n')
    expect(renderSnapshot(records, Buffer.byteLength(twoIndex, 'utf8') - 1, noScan)).toBe(oneIndexOneOmitted)
    expect(renderSnapshot(records, Buffer.byteLength(oneIndexOneOmitted, 'utf8'), noScan)).toBe(oneIndexOneOmitted)

    // One byte short again: A's index line (26 bytes) is smaller than the
    // omission line growing from "1" to "2" more (still 29 bytes), so
    // dropping it also nets a smaller total.
    const zeroKept = [SNAPSHOT_HEADER, '… 2 more; use memory_recall'].join('\n')
    expect(renderSnapshot(records, Buffer.byteLength(oneIndexOneOmitted, 'utf8') - 1, noScan)).toBe(zeroKept)
    expect(renderSnapshot(records, Buffer.byteLength(zeroKept, 'utf8'), noScan)).toBe(zeroKept)

    // One byte short of even the fully-omitted fallback: no budget can hold it.
    expect(renderSnapshot(records, Buffer.byteLength(zeroKept, 'utf8') - 1, noScan)).toBeUndefined()
  })

  it('shrinks a kept block, not only index lines, when no index line is left to drop', () => {
    // A's block is kept from the first pass; B is omitted outright (its
    // content and its description are both too large to fit at all). With no
    // index line in `items` to drop, the shrink loop must drop A's block too.
    const A = record('a', 'user', 'global', 'd', 'c')
    const B = record('b', 'user', 'global', 'x'.repeat(200), 'y'.repeat(5000))
    const records = [A, B]
    const blockA = '## a [user, global]\nd\n\nc'
    const withBlockAOmitted1 = [SNAPSHOT_HEADER, blockA, '… 1 more; use memory_recall'].join('\n')
    const zeroKept = [SNAPSHOT_HEADER, '… 2 more; use memory_recall'].join('\n')

    expect(renderSnapshot(records, Buffer.byteLength(withBlockAOmitted1, 'utf8'), noScan)).toBe(withBlockAOmitted1)
    // One byte short: no index line remains to drop, so the shrink loop pops
    // A's block itself, growing the omission count from 1 to 2.
    expect(renderSnapshot(records, Buffer.byteLength(withBlockAOmitted1, 'utf8') - 1, noScan)).toBe(zeroKept)
  })

  it('keeps every emitted text within the UTF-8 byte budget with multibyte content, without splitting a multibyte character', () => {
    const emoji = record('m', 'user', 'global', 'desc', '😀 multibyte body')
    const block = '## m [user, global]\ndesc\n\n😀 multibyte body'
    const full = `${SNAPSHOT_HEADER}\n${block}`
    const fullBytes = Buffer.byteLength(full, 'utf8')
    // The block is 72 UTF-8 bytes but only 70 UTF-16 code units: an
    // implementation counting characters instead of bytes would misjudge this boundary.
    expect(full.length).not.toBe(fullBytes)
    expect(renderSnapshot([emoji], fullBytes, noScan)).toBe(full)
    const oneByteShort = renderSnapshot([emoji], fullBytes - 1, noScan)!
    expect(oneByteShort).toBe(`${SNAPSHOT_HEADER}\n- [user, global] m — desc`)
    expect(Buffer.byteLength(oneByteShort, 'utf8')).toBeLessThanOrEqual(fullBytes - 1)
  })

  it('inlines a 4,096-byte body at maxBytes 8,192 and renders it as an index line only at maxBytes 4,096', () => {
    const big = record('body4096', 'user', 'global', 'desc', 'z'.repeat(4096))
    const inlined = renderSnapshot([big], 8192, noScan)!
    expect(inlined.startsWith(`${SNAPSHOT_HEADER}\n## body4096 [user, global]\ndesc\n\n`)).toBe(true)
    expect(inlined).toContain('z'.repeat(4096))
    expect(renderSnapshot([big], 4096, noScan)).toBe(`${SNAPSHOT_HEADER}\n- [user, global] body4096 — desc`)
  })

  it('renders a scan finding on content as a blocked index line and never inlines it, even with budget to spare', () => {
    const blockedScan = (text: string): MemoryScanFinding | undefined =>
      text.includes('SECRET') ? { id: 'test', message: 'blocked' } : undefined
    const contentBlocked = record('c', 'user', 'global', 'clean desc', 'has a SECRET inside')
    expect(renderSnapshot([contentBlocked], 4096, blockedScan)).toBe(
      `${SNAPSHOT_HEADER}\n- [user, global] c — [blocked]`,
    )
  })

  it('renders a scan finding on description as a blocked index line too', () => {
    const blockedScan = (text: string): MemoryScanFinding | undefined =>
      text.includes('SECRET') ? { id: 'test', message: 'blocked' } : undefined
    const descriptionBlocked = record('d', 'user', 'global', 'has a SECRET inside', 'clean content')
    expect(renderSnapshot([descriptionBlocked], 4096, blockedScan)).toBe(
      `${SNAPSHOT_HEADER}\n- [user, global] d — [blocked]`,
    )
  })

  it('renders every fitting block before the index-line group, even when a higher-priority record only fits as an index line and a lower-priority record\'s block fits', () => {
    // 'a' (user, higher priority) is processed first by the greedy fill and
    // only fits as an index line; 'b' (feedback, lower priority) is
    // processed second and its block fits. The documented grammar is
    // blocks, then the index-line group — never interleaved in fill order.
    const big = record('a', 'user', 'global', 'short a desc', 'X'.repeat(5000))
    const small = record('b', 'feedback', 'global', 'short b desc', 'tiny')
    const expected = [
      SNAPSHOT_HEADER,
      '## b [feedback, global]',
      'short b desc',
      '',
      'tiny',
      '',
      '- [user, global] a — short a desc',
    ].join('\n')
    expect(renderSnapshot([big, small], Buffer.byteLength(expected, 'utf8'), noScan)).toBe(expected)
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

/** Drive the `agent/pre-step` waterfall directly, bypassing the agent loop. */
function firePreStep(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  decide: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 1, step: 1, signal }, decide)
}

const WRITE = { type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Always pnpm.' } as const

describe('registerCatalogInjection', () => {
  it('passes a reject decision through untouched', async () => {
    const { ctx } = await mount()
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    const agent = sessionAgent(sessionAt(undefined))
    const decision = await firePreStep(ctx, agent, SIGNAL, () => Promise.resolve<PreStepDecision>({ kind: 'reject' }))
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('passes an aborted-signal decision through untouched, without injecting', async () => {
    const { ctx } = await mount()
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    const agent = sessionAgent(sessionAt(undefined))
    const aborted = new AbortController()
    aborted.abort()
    const decision = await firePreStep(ctx, agent, aborted.signal, () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('does not re-inject at a step whose pre-step decision starts a new request series', async () => {
    const { ctx } = await mount()
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    const session = sessionAt(undefined)
    const agent = sessionAgent(session)

    // First step: nothing taken yet, so the snapshot is injected.
    const first = await firePreStep(ctx, agent, SIGNAL, () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }))
    expect(first.kind).toBe('enter')
    expect(first.kind === 'enter' && first.messages).toHaveLength(1)
    if (first.kind === 'enter') {
      for (const message of first.messages) session.append('user/message', message, { surfaceOp: 'append' })
    }

    // Second step declares startsRequestSeries: true; this must not be
    // treated as a fresh conversation start that re-earns an injection.
    const second = await firePreStep(
      ctx, agent, SIGNAL,
      () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [], startsRequestSeries: true }),
    )
    expect(second).toEqual({ kind: 'enter', messages: [], startsRequestSeries: true })
  })

  it('registers the projection but never injects when injectMaxBytes is 0', async () => {
    const { ctx } = await mount({ injectMaxBytes: 0, maxRecallResults: 4 })
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    const session = sessionAt(undefined)
    const agent = sessionAgent(session)
    const decision = await firePreStep(ctx, agent, SIGNAL, () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: false, stepPending: false })
  })

  it('folds step/start to pending only, a committed message while pending to taken, this plugin\'s own snapshot message to taken regardless of pending, step/end to not-pending, compaction/summary to neither, and ignores foreign or unrelated events otherwise', async () => {
    const { ctx } = await mount()
    const session = sessionAt(undefined)
    const compactionSummary = (compactionId: string): Parameters<typeof session.append>[1] => ({
      compactionId,
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: SessionSeq(0), end: SessionSeq(1) },
      shadowedSeqs: [SessionSeq(0), SessionSeq(1)],
      shadowedTokenCount: 10,
      provider: 'mock',
      model: 'mock',
    }) as never
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: false, stepPending: false })

    // step/start: not taken yet, only pending — cancellation during
    // agent/request/prepareCall commits neither the system prompt nor the
    // step's messages, so `step/start` alone must not spend the opportunity.
    session.append('step/start', { turn: 1, step: 1 })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: false, stepPending: true })
    // A second step/start while pending (not yet taken) is a no-op re-set.
    session.append('step/start', { turn: 1, step: 1 })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: false, stepPending: true })

    // step/end with no message ever having committed (the step was
    // rejected, or cancelled before any message landed): pending clears,
    // taken stays false, so the opportunity is still available.
    session.append('step/end', { turn: 1, step: 1 })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: false, stepPending: false })

    // A message while NOT pending, and not this plugin's own snapshot, is ignored.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'foreign snapshot' }],
      source: { kind: 'someone-else', form: 'snapshot', sections: [{ name: 'x', text: 'foreign snapshot' }] },
    }), { surfaceOp: 'append' })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: false, stepPending: false })

    // step/start again, then a committed message while pending — any
    // source kind, not only this plugin's own — proves the step's
    // messages survived cancellation: taken, no longer pending.
    session.append('step/start', { turn: 2, step: 1 })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: false, stepPending: true })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'claimed' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: true, stepPending: false })

    // A second step/start is a no-op (already taken).
    session.append('step/start', { turn: 2, step: 2 })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: true, stepPending: false })

    // compaction/summary: taken and pending both reset.
    session.append('compaction/summary', compactionSummary('compaction-1'))
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: false, stepPending: false })
    // A compaction that finds both already false is a no-op.
    session.append('compaction/summary', compactionSummary('compaction-2'))
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: false, stepPending: false })

    // A tool-memory message in a non-snapshot form, while not pending, is ignored.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'not a snapshot' }],
      source: { kind: 'tool-memory', form: 'notice', summary: 'x' },
    }), { surfaceOp: 'append' })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: false, stepPending: false })

    // The plugin's own snapshot message sets taken regardless of pending: a
    // fork child's seed can carry the parent's snapshot message without the
    // parent's step/start rows.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: SNAPSHOT_HEADER }],
      source: { kind: 'tool-memory', form: 'snapshot', sections: [{ name: 'memory-catalog', text: SNAPSHOT_HEADER }] },
    }), { surfaceOp: 'append' })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: true, stepPending: false })

    // An unrelated event type is ignored.
    session.append('turn/start', { turn: 3 })
    expect(ctx.sessionProjections.stateOf(session, 'memoryCatalog')).toEqual({ taken: true, stepPending: false })
  })

  it('unregisters the projection and the pre-step listener with its fiber', async () => {
    const { ctx, fiber } = await mount()
    await ctx.memory.write({ ...WRITE, name: 'prefers-pnpm' })
    const before = sessionAt(undefined, 'before')
    const beforeAgent = sessionAgent(before)
    const beforeDecision = await firePreStep(ctx, beforeAgent, SIGNAL, () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }))
    expect(beforeDecision.kind === 'enter' && beforeDecision.messages).toHaveLength(1)
    expect(ctx.sessionProjections.stateOf(before, 'memoryCatalog')).toEqual({ taken: false, stepPending: false })

    await fiber.dispose()
    const after = sessionAt(undefined, 'after')
    const afterAgent = sessionAgent(after)
    const afterDecision = await firePreStep(ctx, afterAgent, SIGNAL, () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }))
    expect(afterDecision).toEqual({ kind: 'enter', messages: [] })
    expect(ctx.sessionProjections.stateOf(after, 'memoryCatalog')).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(before, 'memoryCatalog')).toBeUndefined()
  })
})
