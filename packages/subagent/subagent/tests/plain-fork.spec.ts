/**
 * `plainForkParentOf()` classifies a child from durable session data alone:
 * a completed-turn `subagent_fork` (one-shot or continuable, including cold
 * resume) with no persona and no tool filter resolves its exact live
 * delegating parent; every other shape, or a parent that is no longer live,
 * resolves `undefined`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { plainForkParentOf } from '../src/plain-fork.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(): Promise<{ ctx: Context; parent: Agent; disposeParent: () => Promise<void> }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-plain-fork-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  // A known global tool name for the toolFilter fixture below: restrict()
  // validates deny/allow entries against registered global tools.
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'test-only fixture tool',
    parameters: {},
    async execute() { return [] },
  }))
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    textResponse('parent turn'), textResponse('child one'), textResponse('child two'),
    textResponse('child three'), textResponse('child four'), textResponse('resumed child'),
  ]))
  const handle = await ctx.agents.create({
    sessionId: SessionId('parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const parent = handle.agent
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent work' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  return { ctx, parent, disposeParent: () => handle.dispose() }
}

async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 15_000 })
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const child = ctx.agents.get(id)
    expect(child?.status).toBe('running')
    return child!
  }, { timeout: 15_000 })
}

describe('plainForkParentOf', () => {
  it('resolves the parent of a one-shot subagent_fork with no persona or tool filter', async () => {
    const { ctx, parent } = await setup()
    const run = await ctx.subagents.start('fork', {
      label: 'fork task',
      prompt: [{ type: 'text', text: 'fork task' }],
      parent,
      signal: SIGNAL,
    })
    expect(plainForkParentOf(run.localAgent!)).toBe(parent)
    await run.dispose()
  })

  it('resolves undefined for a fresh one-shot child (not seeded)', async () => {
    const { ctx, parent } = await setup()
    const run = await ctx.subagents.start('spawn', {
      label: 'fresh task',
      prompt: [{ type: 'text', text: 'fresh task' }],
      parent,
      signal: SIGNAL,
    })
    expect(plainForkParentOf(run.localAgent!)).toBeUndefined()
    await run.dispose()
  })

  it('resolves the parent of a continuable plain fork', async () => {
    const { ctx, parent } = await setup()
    const childId = SessionId('continuable-plain-fork')
    const started = await ctx.subagents.startContinuable({
      childId,
      provider: 'fork',
      label: 'fork task',
      request: { prompt: [{ type: 'text', text: 'fork task' }], parent },
      signal: SIGNAL,
    })
    const child = ctx.agents.get(started.childId)
    expect(child).toBeDefined()
    expect(plainForkParentOf(child!)).toBe(parent)
  })

  it('resolves undefined for a raw hand-seeded agent that never recorded a subagent origin', async () => {
    // Mirrors the "ordinary Lead fork" construction other suites use to
    // simulate a host fork outside the subagent system: seeded and pointed
    // at a live parentSession, but with no `origin: 'subagent'` meta.
    const { ctx, parent } = await setup()
    const seed = parent.session.snapshotEvents()
    const handle = await ctx.agents.create({
      sessionId: SessionId('raw-hand-seeded-fork'),
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: parent.id, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      expect(plainForkParentOf(handle.agent)).toBeUndefined()
    } finally {
      await handle.dispose()
    }
  })

  it('resolves undefined for a continuable fork carrying a persona', async () => {
    const { ctx, parent } = await setup()
    const childId = SessionId('continuable-persona-fork')
    const started = await ctx.subagents.startContinuable({
      childId,
      provider: 'fork',
      label: 'fork task',
      request: { prompt: [{ type: 'text', text: 'fork task' }], parent, persona: 'You are a specialist.' },
      signal: SIGNAL,
    })
    const child = ctx.agents.get(started.childId)
    expect(child).toBeDefined()
    expect(plainForkParentOf(child!)).toBeUndefined()
  })

  it('resolves undefined for a continuable fork carrying a tool filter', async () => {
    const { ctx, parent } = await setup()
    const childId = SessionId('continuable-toolfilter-fork')
    const started = await ctx.subagents.startContinuable({
      childId,
      provider: 'fork',
      label: 'fork task',
      request: { prompt: [{ type: 'text', text: 'fork task' }], parent, toolFilter: { deny: ['probe'] } },
      signal: SIGNAL,
    })
    const child = ctx.agents.get(started.childId)
    expect(child).toBeDefined()
    expect(plainForkParentOf(child!)).toBeUndefined()
  })

  it('keeps resolving the parent across a cold resume of a continuable plain fork', async () => {
    const { ctx, parent } = await setup()
    const childId = SessionId('cold-resume-plain-fork')
    await ctx.subagents.startContinuable({
      childId,
      provider: 'fork',
      label: 'fork task',
      request: { prompt: [{ type: 'text', text: 'fork task' }], parent },
      signal: SIGNAL,
    })
    await waitNoActivation(ctx, childId)
    await queueHostSubagentPrompt(
      ctx.subagents, parent, childId, [{ type: 'text', text: 'continue' }], { kind: 'user' }, SIGNAL,
    )
    const resumed = await waitRunning(ctx, childId)
    expect(plainForkParentOf(resumed)).toBe(parent)
  })

  it('resolves undefined once the delegating parent is disposed, without throwing', async () => {
    const { ctx, parent, disposeParent } = await setup()
    const run = await ctx.subagents.start('fork', {
      label: 'fork task',
      prompt: [{ type: 'text', text: 'fork task' }],
      parent,
      signal: SIGNAL,
    })
    const fork = run.localAgent!
    await run.dispose()
    await disposeParent()
    expect(() => plainForkParentOf(fork)).not.toThrow()
    expect(plainForkParentOf(fork)).toBeUndefined()
  })
})
