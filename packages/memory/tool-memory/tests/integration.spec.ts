import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ask, catalogEvents, cleanupRoots, freshRoot, mountStore, project, waitForIdle } from './helpers.ts'

/**
 * Full-loop integration: a scripted mock model drives the REAL memory tools
 * through the agent loop over a real store; only the model is mocked. The
 * catalog lands in the log as an ordinary user message with the `tool-memory` source.
 */
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await cleanupRoots()
})

async function harness(adapter: MockAdapter, root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountStore(ctx, root)
  await ctx.plugin(ToolMemory, { injectMaxBytes: 2048, maxRecallResults: 4 })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

describe('memory tools through the agent loop', () => {
  it('writes through memory_write, injects the first catalog on the following step, and refreshes it only when the store changes', async () => {
    const root = await freshRoot()
    const repo = await project(root, 'repo')
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'memory_write', {
        name: 'prefers-pnpm', type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Always pnpm.',
      }, 'Remembering that.'),
      textResponse('Noted.'),
      textResponse('Second turn.'),
      textResponse('Third turn.'),
    ])
    const ctx = await harness(adapter, root)
    const agent = await ctx.agentLoop.create(SessionId('it-memory'), { provider: 'mock', model: 'mock' }, { cwd: repo.cwd })

    ask(agent, 'remember that I use pnpm')
    await waitForIdle(ctx, agent)
    let log = agent.session.snapshotEvents()
    expect(log.find(event => event.type === 'tool/call')?.data.name).toBe('memory_write')
    const resultIndex = log.findIndex(event => event.type === 'tool/result')
    expect(log[resultIndex]?.type === 'tool/result' && log[resultIndex].data.message.isError).toBe(false)
    expect(await readdir(join(root, 'memory', 'global'))).toEqual(['prefers-pnpm.json'])
    // Nothing had been injected yet, so the step after the write carries the catalog.
    let catalogs = catalogEvents(log)
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]?.text).toContain('- [user] prefers-pnpm — Uses pnpm')
    expect(catalogs[0]!.index).toBeGreaterThan(resultIndex)
    expect(adapter.requests[1]!.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('prefers-pnpm — Uses pnpm')))).toBe(true)

    ask(agent, 'what do you know about me?')
    await waitForIdle(ctx, agent)
    expect(catalogEvents(agent.session.snapshotEvents())).toHaveLength(1)

    await ctx.memory.write({ name: 'editor', type: 'user', scope: 'global', description: 'Uses Cursor', content: 'Cursor.' })
    ask(agent, 'and now?')
    await waitForIdle(ctx, agent)
    log = agent.session.snapshotEvents()
    catalogs = catalogEvents(log)
    expect(catalogs).toHaveLength(2)
    expect(catalogs[1]?.text).toContain('- [user] editor — Uses Cursor')
    const thirdTurnStart = log.findIndex(event => event.type === 'turn/start' && event.data.turn === 3)
    expect(catalogs[1]!.index).toBeGreaterThan(thirdTurnStart)
  })

  it('injects a pre-existing catalog before the first request and serves memory_recall from it', async () => {
    const root = await freshRoot()
    const seeded = new Context()
    contexts.push(seeded)
    await mountStore(seeded, root)
    await seeded.memory.write({ name: 'review-style', type: 'feedback', scope: 'global', description: 'Terse reviews', content: 'Lead with the verdict.' })
    await seeded.fiber.dispose()
    contexts.splice(contexts.indexOf(seeded), 1)

    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'memory_recall', { query: 'review' }, 'Checking memory.'),
      textResponse('I lead with the verdict.'),
    ])
    const ctx = await harness(adapter, root)
    const agent = await ctx.agentLoop.create(SessionId('it-memory-seeded'), { provider: 'mock', model: 'mock' })
    ask(agent, 'how should I review?')
    await waitForIdle(ctx, agent)

    const log = agent.session.snapshotEvents()
    const catalogs = catalogEvents(log)
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.index).toBeLessThan(log.findIndex(event => event.type === 'assistant/message'))
    expect(adapter.requests[0]!.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('- [feedback] review-style — Terse reviews')))).toBe(true)
    const result = log.find(event => event.type === 'tool/result')
    expect(result?.data.message.isError).toBe(false)
    const resultText = JSON.stringify(result?.data.message.content)
    expect(resultText).toContain('Lead with the verdict.')
  })
})
