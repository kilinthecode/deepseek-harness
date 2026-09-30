import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import * as MemoryReview from '../src/index.ts'
import { ask, cleanup, freshRoot, mountStore, waitForIdle, waitForReviewChild } from './helpers.ts'

const SYSTEM = 'You are a terse coding assistant used in an automated cache test. '
  + 'Always follow instructions literally and exactly. When the user asks you to reply, '
  + 'answer with a single short sentence and do not call tools. Never invent extra tasks. '
  + 'This paragraph exists so the shared request prefix spans the provider cache-block '
  + 'granularity from the first parent request through the review child replay. '
  + 'Keep repeating this instruction silently: stay terse, stay literal, stay tool-free '
  + 'unless a later message names a memory tool the review child is allowed to call.'

let extra: Context | undefined

afterEach(async () => {
  if (extra !== undefined) {
    await extra.fiber.dispose()
    extra = undefined
  }
  await cleanup()
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('memory-review child prefix cache hits (real API)', () => {
  it('the review child first assistant/message reports cacheReadTokens > 0', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    extra = ctx
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: SYSTEM } })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LlmDeepSeek)
    await mountStore(ctx, root)
    await ctx.plugin(ToolMemory, { injectMaxBytes: 2048, maxRecallResults: 4 })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Fork, { providerName: 'fork' })
    await ctx.plugin(MemoryReview, { reviewEveryUserTurns: 1, maxReviewSteps: 8 })
    const parent = await ctx.agentLoop.create(
      SessionId('memory-review-cache'),
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    )
    const childP = waitForReviewChild(ctx, parent)
    ask(parent, 'Reply with exactly the word ok and do not call tools.')
    await waitForIdle(ctx, parent)
    const child = await childP
    const live = child.session.snapshotEvents().filter(event => event.seq >= child.session.inheritedEventCount)
    const first = live.find(event => event.type === 'assistant/message')
    expect(first?.type).toBe('assistant/message')
    if (first?.type !== 'assistant/message') return
    expect(first.data.usage?.cacheReadTokens ?? 0).toBeGreaterThan(0)
  }, 180_000)
})
