/**
 * Keyless multi-vendor room certification: one room, three vendor routes — the
 * native DeepSeek adapter speaking Anthropic Messages, an anthropic-messages route,
 * and an openai-completions route served by pi-ai. Each vendor's local stand-in
 * records what it received, and each peer records its standing through the
 * shipped room tools, so the room's attribution and quorum are proven across
 * vendor adapters instead of within one of them.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { closeMockServers, mockServer } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import * as toolRoom from '../../tool-agent-room/src/index.ts'
import * as toolTeam from '../../tool-agent-team/src/index.ts'
import TeamService from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const CONTEXTS: Context[] = []
const ROOTS: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of CONTEXTS.splice(0)) await ctx.fiber.dispose()
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true })
  await closeMockServers()
})

/** One complete chat-completions generation carrying `text`. */
function chatReply(text: string): string[] {
  return [
    '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
    `{"choices":[{"delta":{"content":${JSON.stringify(text)}},"index":0,"finish_reason":null}]}`,
    '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":3}}',
    '[DONE]',
  ]
}

/** One chat-completions generation that calls `room_review` with `args`. */
function chatReview(args: object): string[] {
  const call = {
    index: 0,
    id: 'call_review',
    type: 'function',
    function: { name: 'room_review', arguments: JSON.stringify(args) },
  }
  return [
    `{"choices":[{"delta":{"role":"assistant","content":null,"tool_calls":[${JSON.stringify(call)}]},"index":0,"finish_reason":null}]}`,
    '{"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":3}}',
    '[DONE]',
  ]
}

/** One complete anthropic-messages generation carrying `text`. */
function anthropicReply(text: string): string {
  return [
    'event: message_start',
    `data: ${JSON.stringify({ type: 'message_start', message: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-mock', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 },
    } })}`,
    '',
    'event: content_block_start',
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    '',
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })}`,
    '',
    'event: message_stop',
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
  ].join('\n')
}

/** One anthropic-messages generation that calls `room_review` with `args`. */
function anthropicReview(args: object): string {
  return [
    'event: message_start',
    `data: ${JSON.stringify({ type: 'message_start', message: {
      id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-mock', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 },
    } })}`,
    '',
    'event: content_block_start',
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'room_review', input: {} },
    })}`,
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
    })}`,
    '',
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } })}`,
    '',
    'event: message_stop',
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
  ].join('\n')
}

/** Spawn options for one peer seated on its own vendor route. */
function seat(name: string, provider: string, model: string) {
  return {
    name,
    description: `${name} audits the proposal`,
    prompt: [{ type: 'text' as const, text: `You are ${name}; audit the proposal and record your standing when the room asks.` }],
    context: 'fresh' as const,
    // `provider` selects the subagent transport; the vendor route rides in the
    // child's own Agent options, which is how the team tools seat participants.
    provider: 'spawn',
    agentOptions: { provider, model },
    signal: SIGNAL,
  }
}

describe('room across vendor routes', () => {
  it('deliberates one decision with three vendor adapters attributed', async () => {
    vi.stubEnv('PI_VENDOR_KEY', 'test-key')
    // DeepSeek and claude speak Anthropic Messages; the openai route speaks
    // chat-completions.
    const deepseek = await mockServer([
      { body: anthropicReply('deepseek route answered'), headers: { 'content-type': 'text/event-stream' } },
      { body: anthropicReply('deepseek route answered'), headers: { 'content-type': 'text/event-stream' } },
    ])
    const openai = await mockServer([
      { events: chatReply('openai route spoke') },
      { events: chatReview({ proposal_id: 'proposal-1', revision: 1, verdict: 'approve', reason: 'openai route approves' }) },
      { events: chatReply('openai route finished') },
    ])
    const anthropic = await mockServer([
      { body: anthropicReply('anthropic route spoke'), headers: { 'content-type': 'text/event-stream' } },
      {
        body: anthropicReview({ proposal_id: 'proposal-1', revision: 1, verdict: 'approve', reason: 'anthropic route approves' }),
        headers: { 'content-type': 'text/event-stream' },
      },
      { body: anthropicReply('anthropic route finished'), headers: { 'content-type': 'text/event-stream' } },
    ])

    const ctx = new Context()
    CONTEXTS.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-room-vendors-'))
    ROOTS.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(LocalCredentialProvider, { watch: false })
    await ctx.plugin(LlmDeepSeek, {
      apiKeyEnv: 'PI_VENDOR_KEY',
      baseURL: deepseek.url,
      thinking: 'disabled',
      models: [{ id: 'deepseek-mock' }],
    })
    await ctx.plugin(LlmPiAi, {
      providers: {
        anthropic: {
          apiKeyEnv: 'PI_VENDOR_KEY',
          api: 'anthropic-messages',
          baseURL: anthropic.url,
          models: [{ id: 'claude-mock', name: 'Claude mock' }],
        },
        openai: {
          apiKeyEnv: 'PI_VENDOR_KEY',
          api: 'openai-completions',
          baseURL: openai.url,
          models: [{ id: 'gpt-mock', name: 'GPT mock' }],
        },
      },
    })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(SubagentFork, { providerName: 'fork' })
    await ctx.plugin(TimerService)
    await ctx.plugin(TeamService, { roomEnabled: true, maxMembers: 4 })
    await ctx.plugin(toolTeam)
    await ctx.plugin(toolRoom)

    const lead = await ctx.agentLoop.create(SessionId('vendor-lead'), { provider: 'deepseek-official', model: 'deepseek-mock' })
    await ctx.agentTeams.spawnTeammate(lead, seat('claude-peer', 'anthropic', 'claude-mock'))
    await ctx.agentTeams.spawnTeammate(lead, seat('gpt-peer', 'openai', 'gpt-mock'))
    await vi.waitFor(() => {
      const authors = ctx.agentTeams.roomView(lead).messages.map(message => message.authorName)
      expect(authors).toEqual(expect.arrayContaining(['claude-peer', 'gpt-peer']))
    }, { timeout: 10_000 })

    // Each utterance came from its own vendor route, and both peers are seated.
    const transcript = ctx.agentTeams.roomView(lead).messages
      .map(message => `${message.authorName}: ${message.content.map(block => block.type === 'text' ? block.text : '').join('')}`)
    expect(transcript).toContain('claude-peer: anthropic route spoke')
    expect(transcript).toContain('gpt-peer: openai route spoke')
    // Each vendor route served its own participant, and the room reports the
    // vendor model each participant runs.
    expect(anthropic.paths.length).toBeGreaterThanOrEqual(1)
    expect(openai.paths.length).toBeGreaterThanOrEqual(1)
    // Both peers hold a seat in the room beside the DeepSeek Lead.
    expect(ctx.agentTeams.roomView(lead).participants.map(participant => participant.name))
      .toEqual(['lead', 'claude-peer', 'gpt-peer'])

    // One decision, two vendor verdicts, and the quorum arithmetic that follows.
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'adopt the vendor-neutral cache', signal: SIGNAL })
    expect(opened.phase).toBe('open')
    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).proposals[0]?.phase).toBe('accepted')
    }, { timeout: 10_000 })
    const decided = ctx.agentTeams.roomView(lead).proposals[0]
    expect(decided?.standings).toEqual([
      { reviewer: 'claude-peer', verdict: 'approve', reason: 'anthropic route approves' },
      { reviewer: 'gpt-peer', verdict: 'approve', reason: 'openai route approves' },
    ])

    // The outcome notice wakes the Lead on the third vendor route.
    await vi.waitFor(() => {
      expect(deepseek.paths.length).toBeGreaterThan(0)
    }, { timeout: 10_000 })
    // Each peer reached its own vendor route again to record its standing.
    expect(anthropic.paths.length).toBeGreaterThanOrEqual(2)
    expect(openai.paths.length).toBeGreaterThanOrEqual(2)
  }, 30_000)
})
