import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionSeq, SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import type { Config as ToolMemoryConfig } from '@deepseek-ai/dsh-tool-memory'
import { SNAPSHOT_HEADER } from '@deepseek-ai/dsh-tool-memory'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ask, catalogEvents, cleanupRoots, freshRoot, mountStore, waitForIdle } from './helpers.ts'

/**
 * Full-loop integration: a scripted mock model drives the REAL memory tools
 * and the REAL snapshot injection through the agent loop over a real store;
 * only the model is mocked. The snapshot lands in the log as an ordinary
 * user message with the `tool-memory` source.
 */
const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await cleanupRoots()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const AGENT_OPTIONS = { provider: 'mock', model: 'mock' } as const
const RUNTIME_CONTEXT_TEXT = 'cwd: /workspace'

async function harness(
  adapter: MockAdapter,
  root: string,
  config: ToolMemoryConfig = { injectMaxBytes: 2048, maxRecallResults: 4 },
): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountStore(ctx, root)
  await ctx.plugin(ToolMemory, config)
  // A composition normally contributes a runtime-context section (cwd, date,
  // …) through some other plugin; register a minimal one here so the
  // ordering assertion below has a real runtime-context message to order
  // against, the way a full composition would.
  ctx.systemPrompt.context({ name: 'test-runtime-context', order: 0, text: RUNTIME_CONTEXT_TEXT })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function mountPersistentHarness(
  sessionRoot: string,
  storeRoot: string,
  adapter: MockAdapter,
  config: ToolMemoryConfig = { injectMaxBytes: 2048, maxRecallResults: 4 },
): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  // The backend mounts BEFORE the loop so root teardown unwinds the loop first.
  await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountStore(ctx, storeRoot)
  await ctx.plugin(ToolMemory, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
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

describe('memory tools through the agent loop', () => {
  it('injects the snapshot once, at the session\'s first step, after the claimed message and the runtime-context message, and not again within the same turn', async () => {
    const root = await freshRoot()
    const seeded = new Context()
    contexts.push(seeded)
    await mountStore(seeded, root)
    await seeded.memory.write({ name: 'review-style', type: 'feedback', scope: 'global', description: 'Terse reviews', content: 'Lead with the verdict.' })
    await seeded.fiber.dispose()
    contexts.splice(contexts.indexOf(seeded), 1)

    const adapter = new MockAdapter([
      // Turn 1, step 1: a tool call, so turn 1 spans two steps.
      toolCallResponse('call-1', 'memory_recall', { query: 'review' }, 'Checking my notes.'),
      // Turn 1, step 2: the final answer.
      textResponse('Lead with the verdict, as you prefer.'),
    ])
    const ctx = await harness(adapter, root)
    const agent = await ctx.agentLoop.create(SessionId('it-order'), AGENT_OPTIONS)
    ask(agent, 'how should I review?')
    await waitForIdle(ctx, agent)

    // Order within the first request: claimed user message, then the
    // runtime-context message, then the injected snapshot.
    const request = adapter.requests[0]!
    const textOf = (index: number): string =>
      request.messages[index]!.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
    const claimedIndex = request.messages.findIndex((_message, index) => textOf(index).includes('how should I review?'))
    const contextIndex = request.messages.findIndex((_message, index) => textOf(index).includes(RUNTIME_CONTEXT_TEXT))
    const snapshotIndex = request.messages.findIndex((_message, index) => textOf(index).startsWith(SNAPSHOT_HEADER))
    expect(claimedIndex).toBeGreaterThanOrEqual(0)
    expect(contextIndex).toBeGreaterThan(claimedIndex)
    expect(snapshotIndex).toBeGreaterThan(contextIndex)
    expect(textOf(snapshotIndex)).toContain('## review-style [feedback, global]')
    expect(textOf(snapshotIndex)).toContain('Lead with the verdict.')

    // Same order in the durable session log.
    const log = agent.session.snapshotEvents()
    const logClaimed = log.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const logContext = log.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
    const logSnapshot = log.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'tool-memory')
    expect(logClaimed).toBeGreaterThanOrEqual(0)
    expect(logContext).toBeGreaterThan(logClaimed)
    expect(logSnapshot).toBeGreaterThan(logContext)

    // Turn 1 has two steps (the tool call, then the final answer); the
    // snapshot is injected once, not again for the second step.
    expect(catalogEvents(log)).toHaveLength(1)

    // The tool actually served the pre-seeded content, independent of the snapshot.
    const result = log.find(event => event.type === 'tool/result')
    expect(JSON.stringify(result?.data.message.content)).toContain('Lead with the verdict.')
  })

  it('still injects the snapshot on a retry turn after the first step is cancelled before any message committed', async () => {
    const root = await freshRoot()
    const seeded = new Context()
    contexts.push(seeded)
    await mountStore(seeded, root)
    await seeded.memory.write({ name: 'review-style', type: 'feedback', scope: 'global', description: 'Terse reviews', content: 'Lead with the verdict.' })
    await seeded.fiber.dispose()
    contexts.splice(contexts.indexOf(seeded), 1)

    const adapter = new MockAdapter([textResponse('the retry answer')])
    const ctx = await harness(adapter, root)
    const agent = await ctx.agentLoop.create(SessionId('it-cancel-first-step'), AGENT_OPTIONS)

    // Cancel synchronously from the first step/start session-event listener,
    // before agent/request/prepareCall ever resolve: cancellation during
    // that async phase commits neither the system prompt nor the step's
    // messages (docs/architecture.md, agent loop section), so `step/start`
    // alone must not spend the injection opportunity, or the session would
    // never get a snapshot until compaction.
    let cancelledFirstStep = false
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'step/start' || cancelledFirstStep) return
      cancelledFirstStep = true
      agent.cancel({ kind: 'user' })
    })

    ask(agent, 'how should I review?')
    await waitForIdle(ctx, agent)
    dispose()
    expect(cancelledFirstStep).toBe(true)
    expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    expect(catalogEvents(agent.session.snapshotEvents())).toHaveLength(0)

    // The retry turn's first (real) step still injects the snapshot: the
    // cancelled step never durably logged it, so the opportunity survives.
    ask(agent, 'how should I review?')
    await waitForIdle(ctx, agent)
    const catalogs = catalogEvents(agent.session.snapshotEvents())
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.text).toContain('review-style')
  })

  it('renders a blocked entry in the first-step snapshot as an index line, never the body', async () => {
    const root = await freshRoot()
    // `write` scans before storing, so a blocked record can only reach the
    // store by another path: a hand-edited or pre-scan record file, seeded
    // here directly under the store's on-disk layout before the store opens.
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
    const adapter = new MockAdapter([textResponse('Hello.')])
    const ctx = await harness(adapter, root)
    const agent = await ctx.agentLoop.create(SessionId('it-blocked-snapshot'), AGENT_OPTIONS)
    ask(agent, 'hi')
    await waitForIdle(ctx, agent)
    const catalogs = catalogEvents(agent.session.snapshotEvents())
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.text).toContain('- [user, global] blocked-memory — [blocked]')
    expect(catalogs[0]!.text).not.toContain('zero width')
  })

  it('does not re-inject at turn 2, even after a memory_write in turn 1', async () => {
    const root = await freshRoot()
    const seeded = new Context()
    contexts.push(seeded)
    await mountStore(seeded, root)
    await seeded.memory.write({ name: 'review-style', type: 'feedback', scope: 'global', description: 'Terse reviews', content: 'Lead with the verdict.' })
    await seeded.fiber.dispose()
    contexts.splice(contexts.indexOf(seeded), 1)

    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'memory_write', {
        name: 'prefers-pnpm', type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Always pnpm.',
      }, 'Remembering that.'),
      textResponse('Noted.'),
      textResponse('Second turn answer.'),
    ])
    const ctx = await harness(adapter, root)
    const agent = await ctx.agentLoop.create(SessionId('it-no-turn2-reinject'), AGENT_OPTIONS)

    ask(agent, 'remember that I use pnpm')
    await waitForIdle(ctx, agent)
    expect(catalogEvents(agent.session.snapshotEvents())).toHaveLength(1)

    ask(agent, 'anything else?')
    await waitForIdle(ctx, agent)
    expect(catalogEvents(agent.session.snapshotEvents())).toHaveLength(1)
  })

  it('a session whose store starts empty never gets a snapshot for a same-session write, only after compaction — and injects exactly one new snapshot then', async () => {
    const root = await freshRoot()
    const adapter = new MockAdapter([
      // Turn 1: write while the store starts empty.
      toolCallResponse('call-1', 'memory_write', {
        name: 'prefers-pnpm', type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Always pnpm.',
      }, 'Remembering that.'),
      textResponse('Noted.'),
      // Turn 2: no compaction yet.
      textResponse('Second turn answer.'),
      // Turn 3: after compaction.
      textResponse('Third turn answer.'),
    ])
    const ctx = await harness(adapter, root)
    const agent = await ctx.agentLoop.create(SessionId('it-empty-store'), AGENT_OPTIONS)

    ask(agent, 'remember that I use pnpm')
    await waitForIdle(ctx, agent)
    expect(await readdir(join(root, 'memory', 'global'))).toEqual(['prefers-pnpm.json'])
    // The store was empty at turn 1's first step, before the write landed;
    // no snapshot is injected for it, and the write itself does not trigger one.
    expect(catalogEvents(agent.session.snapshotEvents())).toHaveLength(0)

    ask(agent, 'anything else?')
    await waitForIdle(ctx, agent)
    expect(catalogEvents(agent.session.snapshotEvents())).toHaveLength(0)

    appendCompactionSummary(agent.session)
    ask(agent, 'what do you remember?')
    await waitForIdle(ctx, agent)
    const catalogs = catalogEvents(agent.session.snapshotEvents())
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.text).toContain('prefers-pnpm')
  })

  it('registers the projection but never injects when injectMaxBytes is 0', async () => {
    const root = await freshRoot()
    const seeded = new Context()
    contexts.push(seeded)
    await mountStore(seeded, root)
    await seeded.memory.write({ name: 'prefers-pnpm', type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Always pnpm.' })
    await seeded.fiber.dispose()
    contexts.splice(contexts.indexOf(seeded), 1)

    const adapter = new MockAdapter([textResponse('Hello.')])
    const ctx = await harness(adapter, root, { injectMaxBytes: 0, maxRecallResults: 4 })
    const agent = await ctx.agentLoop.create(SessionId('it-no-inject'), AGENT_OPTIONS)
    ask(agent, 'hi')
    await waitForIdle(ctx, agent)
    expect(catalogEvents(agent.session.snapshotEvents())).toHaveLength(0)
  })

  it('resuming a session does not re-inject: the projection refolds "taken" from the persisted log', async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-resume-'))
    dirs.push(sessionRoot)
    const storeRoot = await freshRoot()
    const sessionId = SessionId('it-resume')

    const ctx1 = await mountPersistentHarness(sessionRoot, storeRoot, new MockAdapter([textResponse('first answer')]))
    await ctx1.memory.write({ name: 'prefers-pnpm', type: 'user', scope: 'global', description: 'Uses pnpm', content: 'Always pnpm.' })
    const h1 = await ctx1.agents.create({ sessionId, agentOptions: AGENT_OPTIONS })
    const a1 = h1.agent
    ask(a1, 'first question')
    await waitForIdle(ctx1, a1)
    expect(catalogEvents(a1.session.snapshotEvents())).toHaveLength(1)
    await h1.dispose()
    await ctx1.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx1), 1)

    // Lifecycle 2: a brand-new context (fresh SessionProjectionRegistry, fresh
    // tool-memory registration) resumes the same persisted session.
    const ctx2 = await mountPersistentHarness(sessionRoot, storeRoot, new MockAdapter([textResponse('second answer')]))
    const h2 = await ctx2.agents.resume({ resumeSessionId: sessionId, agentOptions: AGENT_OPTIONS })
    const a2 = h2.agent
    ask(a2, 'second question')
    await waitForIdle(ctx2, a2)
    // Still exactly the one snapshot carried over from lifecycle 1's history.
    expect(catalogEvents(a2.session.snapshotEvents())).toHaveLength(1)
    await h2.dispose()
    await ctx2.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx2), 1)
  })
})
