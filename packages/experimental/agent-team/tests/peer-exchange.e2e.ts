/**
 * Live peer exchange certification: two models on different routes talk to each
 * other through the durable mailbox without the Lead relaying, and the room
 * transcript attributes each utterance to its author. Self-skips without a
 * DeepSeek credential in the environment or the harness-home store.
 */

import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalCredentialProvider, resolveSpec } from '@deepseek-ai/dsh-credentials-local'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as toolRoom from '../../tool-agent-room/src/index.ts'
import * as toolTeam from '../../tool-agent-team/src/index.ts'
import TeamService from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const PROVIDER = 'deepseek-official'
const QUESTIONER_MODEL = 'deepseek-flash'
const ANSWERER_MODEL = 'deepseek-v4-pro'
const QUESTION = 'Is the room transcript durable across a restart? Answer with yes or no and one clause.'
/** The document the mounted LocalCredentialProvider reads, so an isolated DSH_HOME skips. */
const CREDENTIALS = resolveSpec({}).filename
const LIVE = process.env.DEEPSEEK_API_KEY !== undefined || existsSync(CREDENTIALS)
const SIGNAL = new AbortController().signal
const ROOTS: string[] = []
const CONTEXTS = new Set<Context>()

afterAll(async () => {
  for (const ctx of CONTEXTS) await ctx.fiber.dispose()
  CONTEXTS.clear()
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Compose the shipped team and room runtime over real DeepSeek routes. */
async function setup() {
  const ctx = new Context()
  CONTEXTS.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-peer-exchange-e2e-'))
  ROOTS.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(LocalCredentialProvider, { watch: false })
  await ctx.plugin(LlmDeepSeek, { retryPolicy: { mode: 'normal', maxRetries: 1 } })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TimerService)
  await ctx.plugin(TeamService, { roomEnabled: true, maxMembers: 4 })
  await ctx.plugin(toolTeam)
  await ctx.plugin(toolRoom)
  const lead = await ctx.agentLoop.create(SessionId('peer-exchange-e2e-lead'), {
    provider: PROVIDER,
    model: QUESTIONER_MODEL,
  })
  return { ctx, lead }
}

/** Seat one participant and wait for its opening turn to settle. */
async function seat(
  ctx: Context,
  lead: Agent,
  name: string,
  model: string,
  persona: string,
): Promise<{ id: SessionId; model: string | undefined }> {
  const seated = await ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: persona.slice(0, 80),
    prompt: [{ type: 'text', text: `${persona}\n\nSay in one sentence that you are ready, then stop.` }],
    context: 'fresh',
    provider: 'spawn',
    agentOptions: { provider: PROVIDER, model },
    signal: SIGNAL,
  })
  await vi.waitFor(() => {
    const member = ctx.agentTeams.listMembers(lead).find(candidate => candidate.name === name)
    expect(['idle', 'inactive']).toContain(member?.status)
  }, { timeout: 120_000, interval: 500 })
  return { id: seated.member.id, model: seated.member.model }
}

/** Both sides of the peer exchange as the shared Lead log records them. */
function exchange(ctx: Context, lead: Agent): { readonly sender: string; readonly target: string; readonly text: string }[] {
  const names = new Map(ctx.agentTeams.listMembers(lead).map(member => [member.id as string, member.name]))
  return lead.session.snapshotEvents().flatMap(event => event.type === 'team/message/queued'
    ? [{
      sender: event.data.message.senderName,
      target: names.get(event.data.message.targetId) ?? 'unknown',
      text: event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    }]
    : [])
}

/** Peer text one member's inbox admitted, in delivery order. */
function delivered(ctx: Context, id: SessionId): string[] {
  const session = ctx.sessions.get(id)
  if (session === undefined) return []
  return session.snapshotEvents()
    .flatMap(event => event.type === 'agent/inbox/spliced'
      ? event.data.inserted.flatMap(input => input.source.kind === 'team-message'
        ? [input.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
        : [])
      : [])
}

describe.skipIf(!LIVE)('live peer exchange', () => {
  it('carries a question between two models and attributes both sides', async () => {
    const { ctx, lead } = await setup()

    // Different routes are the point: two copies of one model share one model's
    // blind spots, and the exchange must survive an inactive recipient.
    const alice = await seat(ctx, lead, 'alice', QUESTIONER_MODEL,
      'You are alice, a reviewer. When the Lead gives you a question for a peer, you send it yourself with the send_message tool and then stop.')
    const bob = await seat(ctx, lead, 'bob', ANSWERER_MODEL,
      'You are bob, a specialist. When a peer asks you a question, you answer that peer directly with the send_message tool. Never report to the Lead instead.')
    expect(new Set([alice.model, bob.model])).toEqual(new Set([QUESTIONER_MODEL, ANSWERER_MODEL]))

    await ctx.agentTeams.sendMessage(lead, {
      target: 'alice',
      content: [{
        type: 'text',
        text: [
          `Send bob this question with the send_message tool: "${QUESTION}"`,
          'Use target "bob" and the message text exactly as given. Then stop; do not answer it yourself.',
        ].join(' '),
      }],
      signal: SIGNAL,
    })

    // Both sides of the exchange are durable mailbox records on the Lead log,
    // because that log is the one shared room record.
    const messages = (): ReturnType<typeof exchange> => exchange(ctx, lead)
    await vi.waitFor(() => {
      expect(messages().some(message => message.sender === 'alice' && message.target === 'bob')).toBe(true)
    }, { timeout: 240_000, interval: 1_000 })

    const asked = messages().find(message => message.sender === 'alice' && message.target === 'bob')!
    expect(asked.text).toContain('durable')

    // The answer travels peer to peer: bob addresses alice, and alice's inbox
    // holds it, so no coordinator relays the conversation.
    await vi.waitFor(() => {
      expect(messages().some(message => message.sender === 'bob' && message.target === 'alice')).toBe(true)
    }, { timeout: 240_000, interval: 1_000 })
    await vi.waitFor(() => {
      expect(delivered(ctx, alice.id).some(text => text.includes('from bob'))).toBe(true)
    }, { timeout: 120_000, interval: 500 })
    // The Lead never receives the answer it was not addressed in.
    expect(delivered(ctx, lead.id).some(text => text.includes('from bob'))).toBe(false)

    // The shared transcript attributes each side to its own author, which is
    // what makes the exchange auditable after the fact.
    const utterances = ctx.agentTeams.roomView(lead).messages
    expect(utterances.filter(message => message.authorName === 'alice').length).toBeGreaterThanOrEqual(1)
    expect(utterances.filter(message => message.authorName === 'bob').length).toBeGreaterThanOrEqual(1)
  }, 300_000)
})
