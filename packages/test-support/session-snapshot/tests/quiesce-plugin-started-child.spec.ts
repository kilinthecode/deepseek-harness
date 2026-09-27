/**
 * Direct coverage for the `quiesce-plugin-started-child` fixture: a
 * plugin-started (not tool-started) fork child — the shape an unattended
 * background review takes — races a one-shot process that exits as soon as
 * its own top-level agent reports idle. Both cases gate the child mid-turn on
 * a controlled tool call so the race is proven by a checkpoint, never by
 * elapsed time.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as QuiescePluginStartedChild from './fixtures/quiesce-plugin-started-child.ts'

const CHILD_MARKER = 'child task marker'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** One text-only completed stream. */
function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One tool-call-only completed stream. */
function toolCallChunks(rawId: string, toolName: string, args: string): StreamChunk[] {
  const id = ToolCallId(rawId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: toolName, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: toolName, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Whether a request carries the child marker as a user-role text block. */
function isChildRequest(options: GenerateOptions): boolean {
  return options.messages.some(message => message.role === 'user'
    && message.content.some(block => block.type === 'text' && block.text === CHILD_MARKER))
}

/**
 * Answers the parent with a fixed reply and the fork child from its own
 * script, in call order, identified by {@link CHILD_MARKER} in its first new
 * user message (the same identification the review child's real prompt uses).
 */
class MarkerAdapter extends LlmAdapter {
  private readonly childScript: StreamChunk[][]

  constructor(childScript: StreamChunk[][]) {
    super()
    this.childScript = [...childScript]
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const chunks = isChildRequest(options) ? this.childScript.shift() : textChunks('ok')
    if (chunks === undefined) throw new Error('MarkerAdapter: child script exhausted')
    return (async function* generate() {
      for (const chunk of chunks) yield chunk
    })()
  }
}

/** One test's mounted world: the agent loop, fork provider, a gated tool, and a fire-and-forget trigger. */
async function harness(options: { withFixture: boolean }): Promise<{
  ctx: Context
  parent: Agent
  toolCalled: Promise<undefined>
  openGate: () => void
}> {
  const testCtx = new Context()
  ctx = testCtx
  await mountAgentLoopTestDependencies(testCtx)
  await testCtx.plugin(AgentLoop, { agents: [] })
  await testCtx.plugin(SubagentRuntime)
  await testCtx.plugin(Fork, { providerName: 'fork' })
  if (options.withFixture) await testCtx.plugin(QuiescePluginStartedChild)

  const toolCalledResolvers = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  testCtx.tools.register(defineContentToolFixture({
    name: 'gate',
    description: 'Test-only gate the child blocks on mid-turn.',
    parameters: {},
    async execute() {
      toolCalledResolvers.resolve(undefined)
      await gate.promise
      return [{ type: 'text', text: 'gated' }]
    },
  }))

  testCtx.llm.registerAdapter(['mock'], new MarkerAdapter([
    toolCallChunks('call_gate', 'gate', '{}'),
    textChunks('done'),
  ]))

  // Fire-and-forget plugin-started subagent, mirroring memory-review's own
  // `agent/status: idle` trigger: `void ctx.subagents.start(...)`, never awaited.
  testCtx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || agent.session.header.parentSession !== undefined) return
    void testCtx.subagents.start('fork', {
      parent: agent,
      prompt: [{ type: 'text', text: CHILD_MARKER }],
      signal: new AbortController().signal,
    })
  })

  const parent = await testCtx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx: testCtx, parent, toolCalled: toolCalledResolvers.promise, openGate: () => { gate.resolve(undefined) } }
}

describe('quiesce-plugin-started-child', () => {
  it('without the fixture: whenIdle() resolves while the plugin-started child is still gated mid-turn', async () => {
    const { parent, toolCalled, openGate } = await harness({ withFixture: false })

    let idleSettled = false
    void parent.whenIdle().then(() => { idleSettled = true })

    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))

    // Deterministic checkpoint: the child cannot reach here without the fork
    // starting, dispatching its first request, and calling the gated tool.
    await toolCalled
    expect(idleSettled).toBe(true)

    openGate()
  })

  it('with the fixture: whenIdle() waits for the plugin-started child to reach its own whenIdle()', async () => {
    const { ctx: testCtx, parent, toolCalled, openGate } = await harness({ withFixture: true })

    let idleSettled = false
    const idle = parent.whenIdle().then(() => { idleSettled = true })

    const childReady = new Promise<Agent>((resolve) => {
      const dispose = testCtx.on('subagent/start', (info) => {
        if (!info.local) return
        const child = testCtx.agents.get(info.id)
        if (child === undefined) return
        dispose()
        resolve(child)
      })
    })

    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))

    // Same deterministic checkpoint as the baseline case: the child is
    // PROVABLY still blocked on the gate here, so whenIdle() must not have
    // settled yet if the bridge is working.
    await toolCalled
    expect(idleSettled).toBe(false)

    openGate()
    await idle
    expect(idleSettled).toBe(true)

    const child = await childReady
    expect(child.status).toBe('idle')
  })
})
