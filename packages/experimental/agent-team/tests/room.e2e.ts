/**
 * Live room certification: two models on different routes deliberate one
 * contestable decision through the shipped tools. Self-skips without a
 * DeepSeek credential in the environment or the harness-home store.
 */

import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as toolRoom from '../../tool-agent-room/src/index.ts'
import * as toolTeam from '../../tool-agent-team/src/index.ts'
import TeamService from '../src/index.ts'
import type { RoomStreamFrame } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const PROVIDER = 'deepseek-official'
const MODEL_A = 'deepseek-flash'
const MODEL_B = 'deepseek-v4-pro'
const CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml')
const LIVE = process.env.DEEPSEEK_API_KEY !== undefined || existsSync(CREDENTIALS)
const SIGNAL = new AbortController().signal
const ROOTS: string[] = []
const CONTEXTS = new Set<Context>()

afterAll(async () => {
  for (const ctx of CONTEXTS) await ctx.fiber.dispose()
  CONTEXTS.clear()
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Compose the shipped room runtime over a real DeepSeek route. */
async function setup() {
  const ctx = new Context()
  CONTEXTS.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-room-e2e-'))
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
  const lead = await ctx.agentLoop.create(SessionId('room-e2e-lead'), { provider: PROVIDER, model: MODEL_A })
  return { ctx, lead }
}

/** Spawn one live participant on its own model route and wait for its opening turn. */
async function seat(
  ctx: Context,
  lead: Agent,
  name: string,
  model: string,
  persona: string,
): Promise<{ id: SessionId; model: string | undefined }> {
  const member = await ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: persona.slice(0, 80),
    prompt: [{ type: 'text', text: `${persona}\n\nIntroduce your position on the question in two sentences, then stop.` }],
    context: 'fresh',
    provider: 'spawn',
    agentOptions: { provider: PROVIDER, model },
    signal: SIGNAL,
  })
  await vi.waitFor(() => {
    expect(ctx.agentTeams.roomView(lead).messages.some(message => message.authorName === name)).toBe(true)
  }, { timeout: 120_000, interval: 500 })
  // The roster reports a live participant's route, which is where the durable
  // record of it lives too: the child's own Session header.
  return { id: member.member.id, model: member.member.model }
}

describe.skipIf(!LIVE)('live multi-model room', () => {
  it('settles a contestable decision only after peer models review it', async () => {
    const { ctx, lead } = await setup()
    const frames: RoomStreamFrame[] = []
    ctx.on('room/stream', (payload) => { frames.push(payload) })

    const alice = await seat(ctx, lead, 'alice', MODEL_A, 'You argue for the simplest design that can ship this week.')
    const bob = await seat(ctx, lead, 'bob', MODEL_B, 'You are a skeptical reviewer. You reject any plan whose failure mode is unaddressed.')

    // Different routes are the point: a room of one model's copies shares its blind spots.
    expect(frames.some(frame => frame.participantName === 'alice')).toBe(true)
    expect(frames.some(frame => frame.participantName === 'bob')).toBe(true)
    expect(new Set([alice.model, bob.model])).toEqual(new Set([MODEL_A, MODEL_B]))

    const opened = await ctx.agentTeams.roomPropose(lead, {
      statement: 'Adopt a single global mutable cache for session lookup, with no invalidation path in this release.',
      signal: SIGNAL,
    })
    expect(opened).toMatchObject({ phase: 'open', proposerName: 'lead', requiredApprovals: 1 })

    // The mailbox wakes the reviewers; each reaches its verdict through its own
    // model turn rather than being scored by the host. One rejection already
    // reaches quorum in a two-reviewer room, so the test waits for the settlement
    // the rule produces instead of for a fixed number of votes.
    const decision = () => ctx.agentTeams.roomView(lead).proposals[0]!
    await vi.waitFor(() => { expect(decision().phase).not.toBe('open') }, { timeout: 240_000, interval: 1_000 })

    const settled = decision()
    expect(['accepted', 'rejected']).toContain(settled.phase)
    const reviewers = [...settled.approvals, ...settled.rejections, ...settled.abstentions]
    expect(reviewers.length).toBeGreaterThanOrEqual(1)
    expect(reviewers.every(name => name === 'alice' || name === 'bob')).toBe(true)

    // Every verdict carries a reason, and the reason is durable, because that is
    // what the proposer reads before revising the statement.
    await ctx.sessions.flush(lead.session)
    const stored = await ctx.sessionPersistence.open(lead.id, 'read')
    let events
    try {
      events = (await stored.read()).events
    } finally {
      await stored.close()
    }
    const recorded = events.flatMap(event => event.type === 'room/review' ? [event.data.review] : [])
    expect(recorded.length).toBeGreaterThanOrEqual(1)
    expect(recorded.every(review => review.reason.trim().length > 0)).toBe(true)
    expect(new Set(recorded.map(review => review.verdict))).not.toEqual(new Set(['abstain']))
  }, 300_000)
})
