import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as MemoryReview from '../src/index.ts'
import {
  REVIEW_DENY_OTHER_TOOL,
  REVIEW_DENY_OVERWRITE,
  REVIEW_LABEL,
  REVIEW_PROMPT,
  dueForReview,
  reviewWriteTarget,
} from '../src/index.ts'
import {
  ask,
  cleanup,
  createParent,
  createPresetParent,
  freshRoot,
  harness,
  includesReviewPrompt,
  mountStore,
  presetScopedHarness,
  reviewAdapter,
  reviewCatalog,
  waitForIdle,
  waitForReviewChild,
} from './helpers.ts'

afterEach(async () => {
  await cleanup()
})

import type { Agent } from '@deepseek-ai/dsh-agent'

async function* chunksOf(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

/** Stream one chunk then hang until `options.signal` aborts, like the shared MockAdapter's 'hang' marker. */
async function* hangUntilAborted(options: GenerateOptions): AsyncGenerator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'partial' }
  await new Promise<void>((_resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('aborted')); return }
    options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
  })
}

/**
 * An adapter that gives the parent, the review child (identified by carrying
 * {@link REVIEW_PROMPT}), and one other named session their own independent
 * per-session-id script queues — unlike a plain `MockAdapter`'s single global
 * FIFO, which cannot serve three concurrently live agents in call order. The
 * child's queue may hang forever on its last entry; the other two may not.
 * @param parentId - the parent's session id; always answered `ok`.
 * @param otherId - the other known session id (e.g. a sibling agent).
 * @param otherTurns - that session's scripted responses, in order.
 * @param childTurns - the review child's scripted responses, in order; the
 * literal string `'hang'` in the last position hangs until aborted.
 * @returns an adapter that records every request it receives.
 */
function threeWayAdapter(
  parentId: SessionId,
  otherId: SessionId,
  otherTurns: StreamChunk[][],
  childTurns: (StreamChunk[] | 'hang')[],
): LlmAdapter & { requests: GenerateOptions[] } {
  const otherQueue = [...otherTurns]
  const childQueue = [...childTurns]
  let childSessionId: string | undefined
  return new (class extends LlmAdapter {
    requests: GenerateOptions[] = []

    override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      const id = String(options.sessionId ?? 'unknown')
      if (id === String(parentId)) return chunksOf(textResponse('ok'))
      if (id === String(otherId)) {
        const next = otherQueue.shift()
        if (next === undefined) throw new Error('threeWayAdapter: other-session script exhausted')
        return chunksOf(next)
      }
      if (childSessionId === undefined && includesReviewPrompt(options)) childSessionId = id
      if (id === childSessionId) {
        const next = childQueue.shift()
        if (next === undefined) throw new Error('threeWayAdapter: child script exhausted')
        return next === 'hang' ? hangUntilAborted(options) : chunksOf(next)
      }
      return chunksOf(textResponse('ok'))
    }
  })()
}

async function turns(ctx: Context, parent: Agent, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    ask(parent, `turn-${String(index + 1)}`)
    await waitForIdle(ctx, parent)
  }
}

describe('dueForReview and reviewWriteTarget', () => {
  it('is false when the interval is 0, the state is missing, or the count is below the interval', () => {
    expect(dueForReview(undefined, 10)).toBe(false)
    expect(dueForReview({ turnsSinceReset: 10 }, 0)).toBe(false)
    expect(dueForReview({ turnsSinceReset: 9 }, 10)).toBe(false)
    expect(dueForReview({ turnsSinceReset: 10 }, 10)).toBe(true)
  })

  it('accepts only a string name with global or project scope', () => {
    expect(reviewWriteTarget(null)).toBeUndefined()
    expect(reviewWriteTarget({ name: 1, scope: 'global' })).toBeUndefined()
    expect(reviewWriteTarget({ name: 'x', scope: 'other' })).toBeUndefined()
    expect(reviewWriteTarget({ name: 'x', scope: 'global' })).toEqual({ name: 'x', scope: 'global' })
    expect(reviewWriteTarget({ name: 'x', scope: 'project' })).toEqual({ name: 'x', scope: 'project' })
  })
})

describe('dsh-memory-review through the agent loop', () => {
  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in MemoryReview).toBe(false)
    expect(MemoryReview.name).toBe('memory-review')
    expect(MemoryReview.inject).toEqual(['memory', 'tools', 'subagents', 'sessionProjections', 'agents'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(MemoryReview) as Record<string, unknown>
    expect(unwrapped).toBe(MemoryReview)
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('starts exactly one review after ten user-kind messages and none after nine', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([textResponse('Nothing to save.')])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 10, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'ten-turns')
    const childP = waitForReviewChild(ctx, parent)
    await turns(ctx, parent, 9)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
    expect(ctx.sessionProjections.stateOf(parent.session, 'memoryReview')).toEqual({ turnsSinceReset: 9 })
    ask(parent, 'turn-10')
    await waitForIdle(ctx, parent)
    const child = await childP
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(1)
    const live = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount)
    const firstUser = live.find(event => event.type === 'user/message')
    expect(firstUser?.type === 'user/message' && firstUser.data.content.some(block => block.type === 'text' && block.text === REVIEW_PROMPT)).toBe(true)
    expect(live.some(event => event.type === 'compaction/summary')).toBe(false)
  })

  it('resets the count on a memory_* tool call so two user turns after a write are required at interval 2', async () => {
    const root = await freshRoot()
    const adapter = new MockAdapter([
      textResponse('ok'),
      toolCallResponse('w1', 'memory_write', {
        name: 'prefers-pnpm', type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Use pnpm.',
      }),
      textResponse('saved'),
      textResponse('ok'),
      textResponse('ok'),
      textResponse('Nothing to save.'),
    ])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 2, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'tool-reset')
    ask(parent, 't1')
    await waitForIdle(ctx, parent)
    ask(parent, 'remember pnpm')
    await waitForIdle(ctx, parent)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
    ask(parent, 't3')
    await waitForIdle(ctx, parent)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 't4')
    await waitForIdle(ctx, parent)
    await childP
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(1)
  })

  it('does not reset the count when the parent calls a non-memory tool', async () => {
    const root = await freshRoot()
    const adapter = new MockAdapter([
      textResponse('ok'),
      toolCallResponse('p1', 'poke', { key: 'x' }),
      textResponse('poked'),
      textResponse('Nothing to save.'),
    ])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 2, maxReviewSteps: 8 }, root)
    ctx.tools.register(defineContentToolFixture({
      name: 'poke',
      description: 'Poke a key.',
      parameters: { key: { type: 'string', description: 'Key.' } },
      async execute() {
        return [{ type: 'text', text: 'poked' }]
      },
    }))
    const parent = await createParent(ctx, 'poke-reset')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 't1')
    await waitForIdle(ctx, parent)
    ask(parent, 'poke it')
    await waitForIdle(ctx, parent)
    await childP
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(1)
  })

  it('resets on the review catalog label so the next review needs a full interval', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([textResponse('Nothing to save.'), textResponse('Nothing to save.')])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 2, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'label-reset')
    const first = waitForReviewChild(ctx, parent)
    ask(parent, 'a')
    await waitForIdle(ctx, parent)
    ask(parent, 'b')
    await waitForIdle(ctx, parent)
    await first
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(1)
    ask(parent, 'c')
    await waitForIdle(ctx, parent)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(1)
    const second = waitForReviewChild(ctx, parent)
    ask(parent, 'd')
    await waitForIdle(ctx, parent)
    await second
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(2)
  })

  it('is idempotent when a second subagent/catalog row with the review label arrives before any new user turn', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([textResponse('Nothing to save.')])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'catalog-idempotent')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    await childP
    expect(ctx.sessionProjections.stateOf(parent.session, 'memoryReview')).toEqual({ turnsSinceReset: 0 })
    // A second catalog row bearing this plugin's label, appended directly
    // (not through another real review) while the count is already reset,
    // must not observably change the folded state.
    parent.session.append('subagent/catalog', {
      version: 0,
      childId: SessionId('duplicate-catalog-row'),
      childCreatedAt: Date.now(),
      mode: 'one-shot',
      label: REVIEW_LABEL,
    })
    expect(ctx.sessionProjections.stateOf(parent.session, 'memoryReview')).toEqual({ turnsSinceReset: 0 })
  })

  it('never starts a review when reviewEveryUserTurns is 0', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([textResponse('Nothing to save.')])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 0, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'disabled')
    await turns(ctx, parent, 12)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
  })

  it('rebuilds the count from a resumed seed so remaining turns complete the interval', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([textResponse('Nothing to save.')])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 10, maxReviewSteps: 8 }, root)
    const original = await createParent(ctx, 'resume-src')
    await turns(ctx, original, 7)
    expect(ctx.sessionProjections.stateOf(original.session, 'memoryReview')).toEqual({ turnsSinceReset: 7 })
    const seed = [...original.session.snapshotEvents()]
    const handle = await ctx.agents.create({
      sessionId: SessionId('resume-dst'),
      agentOptions: { provider: 'mock', model: 'mock' },
      seed,
    })
    const resumed = handle.agent
    expect(ctx.sessionProjections.stateOf(resumed.session, 'memoryReview')).toEqual({ turnsSinceReset: 7 })
    const childP = waitForReviewChild(ctx, resumed)
    await turns(ctx, resumed, 2)
    expect(reviewCatalog(resumed.session.snapshotEvents())).toHaveLength(0)
    ask(resumed, 'turn-10')
    await waitForIdle(ctx, resumed)
    await childP
    expect(reviewCatalog(resumed.session.snapshotEvents())).toHaveLength(1)
  })

  it('does not count a goal-kind message toward the interval', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([textResponse('Nothing to save.')])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 2, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'goal-kind')
    ask(parent, 't1')
    await waitForIdle(ctx, parent)
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'goal round' }],
      source: { kind: 'goal', goalId: GoalId('g1'), revision: 1, round: 1 },
    }))
    await waitForIdle(ctx, parent)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
    expect(ctx.sessionProjections.stateOf(parent.session, 'memoryReview')).toEqual({ turnsSinceReset: 1 })
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 't2')
    await waitForIdle(ctx, parent)
    await childP
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(1)
  })

  it('does not start a review when a child becomes idle', async () => {
    const root = await freshRoot()
    const adapter = new MockAdapter([
      textResponse('child-ok'),
      textResponse('ok'),
      textResponse('Nothing to save.'),
    ])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'child-idle')
    const run = await ctx.subagents.start('fork', {
      parent,
      prompt: [{ type: 'text', text: 'child q' }],
      signal: new AbortController().signal,
    })
    await run.result
    // Deliberately not disposed yet: a fire-and-forget review trigger from
    // this child's own idle status, if it ran, would need a live agent to
    // reach `ctx.subagents.start` and consume a script entry below —
    // disposing first could race it out before it gets that far.
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'now')
    await waitForIdle(ctx, parent)
    await childP
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(1)
    // The next reply is scripted 'Nothing to save.' only for the legitimate
    // parent-triggered review above; a rogue review from the manually
    // started child's own idle status would have consumed it instead,
    // leaving no script entry for the manually started child's own log.
    expect(reviewCatalog(run.localAgent!.session.snapshotEvents())).toHaveLength(0)
    await run.dispose()
  })

  it('denies forget, overwrite, and unrelated tools, and persists a new-name write', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([
      toolCallResponse('f1', 'memory_forget', { name: 'prefers-pnpm', scope: 'global' }),
      toolCallResponse('o1', 'memory_write', {
        name: 'prefers-pnpm', type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Use pnpm.',
      }),
      toolCallResponse('p1', 'poke', { key: 'x' }),
      toolCallResponse('n1', 'memory_write', {
        name: 'likes-terse', type: 'user', scope: 'global', description: 'Terse answers', content: 'The user prefers terse answers.',
      }),
      textResponse('Nothing to save.'),
    ])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    ctx.tools.register(defineContentToolFixture({
      name: 'poke',
      description: 'Poke a key.',
      parameters: { key: { type: 'string', description: 'Key.' } },
      async execute() {
        return [{ type: 'text', text: 'should not run' }]
      },
    }))
    await ctx.memory.write({
      name: 'prefers-pnpm',
      type: 'user',
      scope: 'global',
      description: 'Uses pnpm',
      content: 'Use pnpm.',
    })
    const parent = await createParent(ctx, 'add-only')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'review now')
    await waitForIdle(ctx, parent)
    const child = await childP
    const live = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount)
    const results = live.filter(event => event.type === 'tool/result')
    const texts = results.map(event => event.type === 'tool/result'
      ? event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : '')
    expect(texts.some(text => text.includes(REVIEW_DENY_OVERWRITE))).toBe(true)
    expect(texts.some(text => text.includes(REVIEW_DENY_OTHER_TOOL))).toBe(true)
    expect(results.filter(event => event.type === 'tool/result' && event.data.message.isError).length).toBeGreaterThanOrEqual(3)
    const visible = await ctx.memory.visible(undefined)
    expect(visible.global.some(record => record.name === 'prefers-pnpm')).toBe(true)
    expect(visible.global.some(record => record.name === 'likes-terse' && record.content.includes('terse'))).toBe(true)
  })

  it('keeps the child first request tools byte-identical to the parent and prefixes the parent messages', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([textResponse('Nothing to save.')])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'cache-parity')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'hello')
    await waitForIdle(ctx, parent)
    const child = await childP
    const parentHeader = parent.session.snapshotEvents().findLast(event => event.type === 'request/header')
    const childLive = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount)
    const childHeader = childLive.find(event => event.type === 'request/header')
    expect(parentHeader?.type).toBe('request/header')
    expect(childHeader?.type).toBe('request/header')
    if (parentHeader?.type !== 'request/header' || childHeader?.type !== 'request/header') return
    expect(JSON.stringify(childHeader.data.header.tools ?? [])).toBe(JSON.stringify(parentHeader.data.header.tools ?? []))
    const parentReq = adapter.requests.findLast(request => request.sessionId === parent.session.id)
    const childReq = adapter.requests.find(request => request.sessionId === child.session.id)
    expect(parentReq).toBeDefined()
    expect(childReq).toBeDefined()
    expect(childReq!.messages.slice(0, parentReq!.messages.length)).toEqual(parentReq!.messages)
    // The completed parent turn (its assistant reply) and a dynamically
    // rendered runtime-context message (the universal delegated-subagent
    // scope notice) both follow the shared prefix and precede or trail the
    // review prompt, so it is not reliably at a fixed index or the request's
    // last user message; only its presence is asserted.
    expect(includesReviewPrompt(childReq!)).toBe(true)
  })

  it('guards the child first tool call so an immediate memory_forget is denied and the record remains', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([
      toolCallResponse('f1', 'memory_forget', { name: 'prefers-pnpm', scope: 'global' }),
      textResponse('Nothing to save.'),
    ])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    await ctx.memory.write({
      name: 'prefers-pnpm',
      type: 'user',
      scope: 'global',
      description: 'Uses pnpm',
      content: 'Use pnpm.',
    })
    const parent = await createParent(ctx, 'first-call')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    const child = await childP
    const live = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount)
    const result = live.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.isError).toBe(true)
    expect(result?.type === 'tool/result'
      && result.data.message.content.some(block => block.type === 'text' && block.text.includes(REVIEW_DENY_OVERWRITE))).toBe(true)
    const visible = await ctx.memory.visible(undefined)
    expect(visible.global.some(record => record.name === 'prefers-pnpm')).toBe(true)
  })

  it('denies a memory_write call whose arguments carry no valid name and scope', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([
      toolCallResponse('bad1', 'memory_write', { scope: 'global' }),
      textResponse('Nothing to save.'),
    ])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'malformed-write')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    const child = await childP
    const live = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount)
    const result = live.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.isError).toBe(true)
    expect(result?.type === 'tool/result'
      && result.data.message.content.some(block => block.type === 'text' && block.text.includes(REVIEW_DENY_OVERWRITE))).toBe(true)
  })

  it('does not restrict a sibling agent created after the review child\'s start() has returned, only the review child\'s own first tool call', async () => {
    const root = await freshRoot()
    const parentId = SessionId('dispatch-window')
    const siblingId = SessionId('unrelated-sibling')
    // A per-session-routed adapter, not a plain `MockAdapter`: three agents
    // (the parent, the review child, and the sibling created below) are
    // live at once, and the child's second step hangs so the review stays
    // genuinely in flight (`inflight` still holds the parent) while the
    // sibling is created and driven — the scenario the old, over-broad gate
    // would have wrongly restricted. A single global FIFO script cannot
    // serve three concurrently live agents in call order.
    const adapter = threeWayAdapter(
      parentId,
      siblingId,
      [toolCallResponse('f2', 'memory_forget', { name: 'prefers-pnpm', scope: 'global' }), textResponse('done')],
      [toolCallResponse('f1', 'memory_forget', { name: 'prefers-pnpm', scope: 'global' }), 'hang'],
    )
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    await ctx.memory.write({
      name: 'prefers-pnpm',
      type: 'user',
      scope: 'global',
      description: 'Uses pnpm',
      content: 'Use pnpm.',
    })
    const parent = await createParent(ctx, String(parentId))
    const started = new Promise<Agent>((resolve) => {
      ctx.on('subagent/start', (info) => {
        const found = ctx.agents.get(info.id)
        if (found?.session.header.parentSession === parent.session.id) resolve(found)
      })
    })
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    const child = await started

    // Wait for the child's own tool result (its first call, denied) before
    // asserting on it or touching the sibling below.
    const childResult = await new Promise<SessionEvent>((resolve) => {
      const existing = child.session.snapshotEvents().find(event => event.type === 'tool/result')
      if (existing !== undefined) { resolve(existing); return }
      const dispose = child.ctx.on('session/event', (_session, event) => {
        if (event.type !== 'tool/result') return
        dispose()
        resolve(event)
      })
    })

    // The review child's own first call is still restricted: memory_forget
    // is denied, and the record survives.
    expect(childResult.type === 'tool/result' && childResult.data.message.isError).toBe(true)
    expect(childResult.type === 'tool/result'
      && childResult.data.message.content.some(block => block.type === 'text' && block.text.includes(REVIEW_DENY_OVERWRITE))).toBe(true)
    expect((await ctx.memory.visible(undefined)).global.some(record => record.name === 'prefers-pnpm')).toBe(true)

    // A sibling agent created afterward, sharing the same parentSession,
    // WHILE the review is still genuinely in flight (the child hangs on its
    // second step), is NOT restricted: `dispatching` was cleared right
    // after `start()` returned, long before now, so this sibling's own
    // `agent/created` never saw the parent in `dispatching`. Its own
    // memory_forget of the same record actually runs.
    const handle = await ctx.agents.create({
      sessionId: siblingId,
      parentAgent: parent,
      meta: { parentSession: parent.session.id, origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const sibling = handle.agent
    sibling.followup(createUserMessage({
      content: [{ type: 'text', text: 'forget it' }],
      source: { kind: 'user' },
    }))
    await sibling.whenIdle()
    const siblingResult = sibling.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(siblingResult?.type === 'tool/result' && siblingResult.data.message.isError).toBe(false)
    expect((await ctx.memory.visible(undefined)).global.some(record => record.name === 'prefers-pnpm')).toBe(false)

    // Clean up the still-hung review child.
    child.cancel({ kind: 'parent' })
    await child.whenIdle()
  })

  it('logs the missing-dependency error once per parent even after a second due idle, not on every idle', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    const errors: string[] = []
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountStore(ctx, root)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Fork, { providerName: 'fork' })
    ctx.logger.error = ((message: unknown) => {
      errors.push(String(message))
    }) as typeof ctx.logger.error
    await ctx.plugin(MemoryReview, { reviewEveryUserTurns: 1, maxReviewSteps: 8 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok'), textResponse('ok')]))
    const parent = await ctx.agentLoop.create(SessionId('no-tool-memory-twice'), { provider: 'mock', model: 'mock' })
    ask(parent, 'first')
    await waitForIdle(ctx, parent)
    expect(errors.filter(message => message.includes('memory_write'))).toHaveLength(1)
    // Still due (memory_write never registers, so the count never resets):
    // a second idle notification must not log a second error.
    ask(parent, 'second')
    await waitForIdle(ctx, parent)
    expect(errors.filter(message => message.includes('memory_write'))).toHaveLength(1)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('aborts an in-flight review when its parent is disposed, and a later idle of a brand-new parent starts its own review normally', async () => {
    const root = await freshRoot()
    const adapter = new MockAdapter([textResponse('ok'), 'hang'])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    const handle = await ctx.agents.create({
      sessionId: SessionId('dispose-abort'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const parent = handle.agent
    const started = new Promise<Agent>((resolve) => {
      ctx.on('subagent/start', (info) => {
        const child = ctx.agents.get(info.id)
        if (child?.session.header.parentSession === parent.session.id) resolve(child)
      })
    })
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    const child = await started

    // Wait for the child's own live request to have been dispatched (it
    // consumes the 'hang' script entry) before disposing the parent: right
    // after `subagent/start`, the child's own request-building microtasks
    // have not necessarily run yet, so disposing immediately would race
    // ahead of them instead of interrupting a genuinely in-flight call. The
    // inherited seed already carries its own `request/header`, so only a
    // live one (`seq >= inheritedEventCount`) counts.
    const hasLiveRequestHeader = (): boolean => child.session.snapshotEvents()
      .some(event => event.type === 'request/header' && event.seq >= child.session.inheritedEventCount)
    if (!hasLiveRequestHeader()) {
      await new Promise<void>((resolve) => {
        const dispose = child.ctx.on('session/event', (_session, event) => {
          if (event.type !== 'request/header' || event.seq < child.session.inheritedEventCount) return
          dispose()
          resolve()
        })
      })
    }

    // This exercises the previously untested `agent/disposed` abort path:
    // the parent's own disposal aborts the in-flight review child through
    // this plugin's listener (the abort propagates to `child.cancel(...)`
    // inside the fork driver), ending its hung turn.
    await handle.dispose()
    await child.whenIdle()

    // A later idle of a brand-new, unrelated parent is unaffected: its own
    // review starts and completes normally.
    const second = await createParent(ctx, 'fresh-after-dispose')
    const secondChildP = waitForReviewChild(ctx, second)
    ask(second, 'go')
    await waitForIdle(ctx, second)
    await secondChildP
    expect(reviewCatalog(second.session.snapshotEvents())).toHaveLength(1)
  })

  it('allows the review child to call memory_recall and read stored content', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([
      toolCallResponse('r1', 'memory_recall', { query: 'pnpm' }),
      textResponse('Nothing to save.'),
    ])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    await ctx.memory.write({
      name: 'prefers-pnpm',
      type: 'user',
      scope: 'global',
      description: 'Uses pnpm',
      content: 'Use pnpm, never npm.',
    })
    const parent = await createParent(ctx, 'recall-allowed')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    const child = await childP
    const live = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount)
    const result = live.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.isError).toBe(false)
    expect(result?.type === 'tool/result'
      && result.data.message.content.some(block => block.type === 'text' && block.text.includes('Use pnpm, never npm.'))).toBe(true)
  })

  it('inherits the parent\'s snapshot in its seed and does not inject a second one on its own first step', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([textResponse('Nothing to save.')])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    await ctx.memory.write({
      name: 'prefers-pnpm', type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Use pnpm.',
    })
    const parent = await createParent(ctx, 'snapshot-once')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    const child = await childP
    const isSnapshot = (event: { type: string; data?: unknown }): boolean =>
      event.type === 'user/message' && (event as { data: { source: { kind: string } } }).data.source.kind === 'tool-memory'
    const inherited = child.session.snapshotEvents().filter(event => event.seq < child.session.inheritedEventCount && isSnapshot(event))
    expect(inherited).toHaveLength(1)
    const own = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount && isSnapshot(event))
    expect(own).toHaveLength(0)
  })

  it('rejects the child step after maxReviewSteps', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([
      toolCallResponse('r1', 'memory_recall', { query: 'pnpm' }),
      textResponse('should not run'),
    ])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 1 }, root)
    const parent = await createParent(ctx, 'step-cap')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    const child = await childP
    const live = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount)
    expect(live.filter(event => event.type === 'request/header')).toHaveLength(1)
    expect(live.some(event => event.type === 'step/start' && event.data.step === 2)).toBe(false)
  })

  it('passes through a downstream pre-execute deny on memory_recall', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([
      toolCallResponse('r1', 'memory_recall', { query: 'x' }),
      textResponse('Nothing to save.'),
    ])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession === undefined) return
      agent.ctx.on('tools/pre-execute', async (_exec, next) => {
        await next()
        return { kind: 'deny', reason: 'downstream-deny' }
      })
    })
    const parent = await createParent(ctx, 'downstream-deny')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    const child = await childP
    const live = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount)
    const result = live.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result'
      && result.data.message.content.some(block => block.type === 'text' && block.text.includes('downstream-deny'))).toBe(true)
  })

  it('unregisters the projection when the plugin fiber is disposed', async () => {
    const root = await freshRoot()
    const adapter = reviewAdapter([])
    const { ctx, reviewFiber } = await harness(adapter, { reviewEveryUserTurns: 10, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'hmr')
    expect(ctx.sessionProjections.stateOf(parent.session, 'memoryReview')).toEqual({ turnsSinceReset: 0 })
    await reviewFiber.dispose()
    expect(ctx.sessionProjections.stateOf(parent.session, 'memoryReview')).toBeUndefined()
    ask(parent, 'after dispose')
    await waitForIdle(ctx, parent)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
  })

  it('aborts an in-flight review when the plugin fiber is disposed', async () => {
    const root = await freshRoot()
    const adapter = new MockAdapter([textResponse('ok'), 'hang'])
    const { ctx, reviewFiber } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'abort-unload')
    const started = new Promise<Agent>((resolve) => {
      ctx.on('subagent/start', (info) => {
        const child = ctx.agents.get(info.id)
        if (child?.session.header.parentSession === parent.session.id) resolve(child)
      })
    })
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    const child = await started
    await reviewFiber.dispose()
    await child.whenIdle()
  })

  it('ignores a second idle notification while a review is already in flight for that parent', async () => {
    const root = await freshRoot()
    const adapter = new MockAdapter([textResponse('ok'), 'hang', textResponse('ok')])
    const { ctx } = await harness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root)
    const parent = await createParent(ctx, 'inflight-guard')
    const started = new Promise<Agent>((resolve) => {
      ctx.on('subagent/start', (info) => {
        const child = ctx.agents.get(info.id)
        if (child?.session.header.parentSession === parent.session.id) resolve(child)
      })
    })
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    const child = await started
    // Wait for the child's own live request to have been dispatched (it
    // consumes the 'hang' script entry) before the parent's second turn, so
    // the mock's call-ordered script is not raced by the parent's own second
    // request and the second `agent/status: idle` notification hits the
    // inflight guard while a review genuinely has not settled yet. The
    // inherited seed (the replayed parent prefix) already carries its own
    // `request/header`, so only a live one (`seq >= inheritedEventCount`) counts.
    const hasLiveRequestHeader = (): boolean => child.session.snapshotEvents()
      .some(event => event.type === 'request/header' && event.seq >= child.session.inheritedEventCount)
    if (!hasLiveRequestHeader()) {
      await new Promise<void>((resolve) => {
        const dispose = child.ctx.on('session/event', (_session, event) => {
          if (event.type !== 'request/header' || event.seq < child.session.inheritedEventCount) return
          dispose()
          resolve()
        })
      })
    }
    ask(parent, 'again')
    await waitForIdle(ctx, parent)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(1)
    child.cancel({ kind: 'parent' })
    await child.whenIdle()
  })

  it('logs and skips a fork child that has no localAgent', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    const warnings: string[] = []
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountStore(ctx, root)
    await ctx.plugin(ToolMemory, { injectMaxBytes: 2048, maxRecallResults: 4 })
    await ctx.plugin(SubagentRuntime)
    const remote: SubagentProvider = {
      name: 'fork',
      inheritsParentContext: true,
      capabilities: {
        agentOptions: false,
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      start: () => Promise.resolve({
        id: SessionId('remote-review'),
        localAgent: undefined,
        // Also rejected: exercises the swallowed `run.result.catch(...)` next
        // to the `no in-process fork child` throw below, which owns the run's
        // only reported failure when there is no local child to await.
        result: Promise.reject(new Error('remote result failed')),
        async dispose() {},
      }),
    }
    ctx.subagents.registerProvider(remote)
    let resolveWarned!: () => void
    const warned = new Promise<void>((resolve) => { resolveWarned = resolve })
    ctx.logger.warn = ((message: unknown) => {
      warnings.push(String(message))
      resolveWarned()
    }) as typeof ctx.logger.warn
    await ctx.plugin(MemoryReview, { reviewEveryUserTurns: 1, maxReviewSteps: 8 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
    const parent = await ctx.agentLoop.create(SessionId('remote-parent'), { provider: 'mock', model: 'mock' })
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    // The no-localAgent path logs from `startReview`'s fire-and-forget chain,
    // which is not guaranteed to have reached its catch block merely because
    // the parent's own turn reached idle; the warn call itself is the
    // deterministic signal to wait on.
    await warned
    expect(warnings.some(message => message.includes('in-process fork child'))).toBe(true)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('logs a warning and still disposes the run when the review child result rejects', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    const warnings: string[] = []
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountStore(ctx, root)
    await ctx.plugin(ToolMemory, { injectMaxBytes: 2048, maxRecallResults: 4 })
    await ctx.plugin(SubagentRuntime)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
    const parent = await ctx.agentLoop.create(SessionId('reject-parent'), { provider: 'mock', model: 'mock' })
    const child = await ctx.agents.create({
      sessionId: SessionId('reject-child'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    let resolveDisposed!: () => void
    const disposed = new Promise<void>((resolve) => { resolveDisposed = resolve })
    const failing: SubagentProvider = {
      name: 'fork',
      inheritsParentContext: true,
      capabilities: {
        agentOptions: false,
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      start: () => Promise.resolve({
        id: child.agent.session.id,
        localAgent: child.agent,
        result: Promise.reject(new Error('child crashed')),
        async dispose() { resolveDisposed() },
      }),
    }
    ctx.subagents.registerProvider(failing)
    ctx.logger.warn = ((message: unknown) => {
      warnings.push(String(message))
    }) as typeof ctx.logger.warn
    await ctx.plugin(MemoryReview, { reviewEveryUserTurns: 1, maxReviewSteps: 8 })
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    await disposed
    expect(warnings.some(message => message.includes('child crashed'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('renders a non-Error review child rejection with String() in the warning', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    const warnings: string[] = []
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountStore(ctx, root)
    await ctx.plugin(ToolMemory, { injectMaxBytes: 2048, maxRecallResults: 4 })
    await ctx.plugin(SubagentRuntime)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
    const parent = await ctx.agentLoop.create(SessionId('reject-parent-nonerror'), { provider: 'mock', model: 'mock' })
    const child = await ctx.agents.create({
      sessionId: SessionId('reject-child-nonerror'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    let resolveDisposed!: () => void
    const disposed = new Promise<void>((resolve) => { resolveDisposed = resolve })
    const failing: SubagentProvider = {
      name: 'fork',
      inheritsParentContext: true,
      capabilities: {
        agentOptions: false,
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      start: () => Promise.resolve({
        id: child.agent.session.id,
        localAgent: child.agent,
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises the non-Error String(error) branch.
        result: Promise.reject('child crashed as a plain string'),
        async dispose() { resolveDisposed() },
      }),
    }
    ctx.subagents.registerProvider(failing)
    ctx.logger.warn = ((message: unknown) => {
      warnings.push(String(message))
    }) as typeof ctx.logger.warn
    await ctx.plugin(MemoryReview, { reviewEveryUserTurns: 1, maxReviewSteps: 8 })
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    await disposed
    expect(warnings.some(message => message.includes('child crashed as a plain string'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('renders a non-Error thrown value from starting the fork child with String() in the warning', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    const warnings: string[] = []
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountStore(ctx, root)
    await ctx.plugin(ToolMemory, { injectMaxBytes: 2048, maxRecallResults: 4 })
    await ctx.plugin(SubagentRuntime)
    const throwing: SubagentProvider = {
      name: 'fork',
      inheritsParentContext: true,
      capabilities: {
        agentOptions: false,
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises the non-Error String(error) branch.
      start: () => Promise.reject('fork start failed as a plain string'),
    }
    ctx.subagents.registerProvider(throwing)
    let resolveWarned!: () => void
    const warned = new Promise<void>((resolve) => { resolveWarned = resolve })
    ctx.logger.warn = ((message: unknown) => {
      warnings.push(String(message))
      resolveWarned()
    }) as typeof ctx.logger.warn
    await ctx.plugin(MemoryReview, { reviewEveryUserTurns: 1, maxReviewSteps: 8 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
    const parent = await ctx.agentLoop.create(SessionId('start-throws-nonerror'), { provider: 'mock', model: 'mock' })
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    await warned
    expect(warnings.some(message => message.includes('fork start failed as a plain string'))).toBe(true)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('logs an error and skips the review when memory_write is not registered', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    const errors: string[] = []
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountStore(ctx, root)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Fork, { providerName: 'fork' })
    ctx.logger.error = ((message: unknown) => {
      errors.push(String(message))
    }) as typeof ctx.logger.error
    await ctx.plugin(MemoryReview, { reviewEveryUserTurns: 1, maxReviewSteps: 8 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
    const parent = await ctx.agentLoop.create(SessionId('no-tool-memory'), { provider: 'mock', model: 'mock' })
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    expect(errors.some(message => message.includes('memory_write'))).toBe(true)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('logs an error and skips the review when the fork provider is not registered', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    const errors: string[] = []
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountStore(ctx, root)
    await ctx.plugin(ToolMemory, { injectMaxBytes: 2048, maxRecallResults: 4 })
    await ctx.plugin(SubagentRuntime)
    ctx.logger.error = ((message: unknown) => {
      errors.push(String(message))
    }) as typeof ctx.logger.error
    await ctx.plugin(MemoryReview, { reviewEveryUserTurns: 1, maxReviewSteps: 8 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
    const parent = await ctx.agentLoop.create(SessionId('no-fork'), { provider: 'mock', model: 'mock' })
    ask(parent, 'go')
    await waitForIdle(ctx, parent)
    expect(errors.some(message => message.includes('fork'))).toBe(true)
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('starts a review, restricts the child, and persists a new-name write when tool-memory and memory-review are mounted per agent by a real preset revision (not the process-global scope)', async () => {
    // `@deepseek-ai/dsh-agent-preset` (Web's standard/cordis/ptc presets)
    // mounts `tool-memory` and `memory-review` in the AGENT's own scope, not
    // the process-global one every other test in this file uses:
    // `presetScopedHarness` reproduces that exact relationship through the
    // real `@deepseek-ai/dsh-agent-preset-registry`, the same registry the
    // real preset plugin calls. Before the fix, `startReview` looked up
    // `memory_write` with `ctx.tools.get('memory_write')` (no scope), which
    // only ever sees the process-global layer — the tool the preset registers
    // is invisible there, so the review was silently skipped. Reverting the
    // fix (dropping the `agent` scope argument back off that lookup) must
    // make this test fail.
    const root = await freshRoot()
    const adapter = reviewAdapter([
      toolCallResponse('f1', 'memory_forget', { name: 'prefers-pnpm', scope: 'global' }),
      toolCallResponse('n1', 'memory_write', {
        name: 'likes-terse', type: 'user', scope: 'global', description: 'Terse answers', content: 'The user prefers terse answers.',
      }),
      textResponse('Nothing else to save.'),
    ])
    const { ctx } = await presetScopedHarness(adapter, { reviewEveryUserTurns: 1, maxReviewSteps: 8 }, root, 'preset-under-test')
    await ctx.memory.write({
      name: 'prefers-pnpm', type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Use pnpm.',
    })
    const parent = await createPresetParent(ctx, 'preset-scoped-parent', 'preset-under-test')
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'go')
    await waitForIdle(ctx, parent)

    // The review actually started: a preset-scoped `agent/created` listener
    // (registered inside `memory-review`'s `apply()`, mounted on the
    // revision's own ancestor scope) fired for this descendant child — the
    // fork provider's `applyChildComposition` joins every child's own scope
    // to the same revision the parent is bound to
    // (`packages/subagent/subagent/src/child-agent.ts`), which is what makes
    // that ancestor-scoped listener observe the child at all.
    const child = await childP
    expect(reviewCatalog(parent.session.snapshotEvents())).toHaveLength(1)

    // The restriction installed on the child's own first tool call: an
    // immediate `memory_forget` is denied carrying the verbatim overwrite reason.
    const live = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount)
    const forgetResult = live.find(event => event.type === 'tool/result')
    expect(forgetResult?.type === 'tool/result' && forgetResult.data.message.isError).toBe(true)
    expect(forgetResult?.type === 'tool/result'
      && forgetResult.data.message.content.some(block => block.type === 'text' && block.text.includes(REVIEW_DENY_OVERWRITE))).toBe(true)

    // A new-name write persists to the process-wide store, and the denied
    // forget left the pre-existing record untouched.
    const visible = await ctx.memory.visible(undefined)
    expect(visible.global.some(record => record.name === 'prefers-pnpm')).toBe(true)
    expect(visible.global.some(record => record.name === 'likes-terse' && record.content.includes('terse'))).toBe(true)
  })
})
