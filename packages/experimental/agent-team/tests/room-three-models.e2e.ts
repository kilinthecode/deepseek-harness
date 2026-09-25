/**
 * Live multi-model room certification: three models on three routes stream into
 * one room, every standing is attributed with its reason, and the decision
 * settles only through the recorded 2-of-3 quorum. Self-skips without a
 * DeepSeek credential in the environment or the harness-home store.
 */

import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
import type { RoomProposalView, RoomStreamFrame } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const PROVIDER = 'deepseek-official'
const ROUTES = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'] as const
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

/** Compose the shipped room runtime over three real DeepSeek routes. */
async function setup() {
  const ctx = new Context()
  CONTEXTS.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-room-three-e2e-'))
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
  // A majority bar: two of three reviewers, so no single model carries the room.
  await ctx.plugin(TeamService, { roomEnabled: true, roomApprovalRatio: 0.5, maxMembers: 4 })
  await ctx.plugin(toolTeam)
  await ctx.plugin(toolRoom)
  const lead = await ctx.agentLoop.create(SessionId('room-three-e2e-lead'), {
    provider: PROVIDER,
    model: ROUTES[0],
  })
  return { ctx, lead }
}

/** Seat one live participant on its own route and wait for its opening turn. */
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
    prompt: [{ type: 'text', text: `${persona}\n\nIntroduce your position on the question in two sentences, then stop.` }],
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

describe.skipIf(!LIVE)('live three-model room', () => {
  it('settles a decision through a 2-of-3 peer quorum with attributed reasons', async () => {
    const { ctx, lead } = await setup()
    const frames: RoomStreamFrame[] = []
    ctx.on('room/stream', (payload) => { frames.push(payload) })

    const names = ['alice', 'bob', 'carol'] as const
    const personas = [
      'You argue for the simplest design that can ship this week.',
      'You are a skeptical reviewer. You reject any plan whose failure mode is unaddressed.',
      'You look for the operational cost nobody else mentions.',
    ] as const
    const seated = await Promise.all(names.map(async (name, index) =>
      await seat(ctx, lead, name, ROUTES[index]!, personas[index]!)))
    // Three routes, so the room cannot share one model's blind spots.
    expect(new Set(seated.map(participant => participant.model))).toEqual(new Set(ROUTES))

    const opened = await ctx.agentTeams.roomPropose(lead, {
      statement: 'Adopt one global mutable cache for session lookup, with no invalidation path in this release.',
      signal: SIGNAL,
    })
    // Two of three reviewers must approve, and one objection blocks acceptance:
    // no participant can carry the decision alone.
    expect(opened).toMatchObject({ phase: 'open', proposerName: 'lead', requiredApprovals: 2, awaiting: [...names] })

    // Every reviewer receives the statement with the room context it has not seen.
    for (const [index, name] of names.entries()) {
      const prompt = delivered(ctx, seated[index]!.id).find(text => text.includes(opened.id))
      expect(prompt).toBeDefined()
      expect(prompt).toContain(opened.statement)
      expect(prompt).toContain('Call room_review')
      expect(name).toBe(names[index])
    }

    const decision = (): RoomProposalView => ctx.agentTeams.roomView(lead).proposals[0]!
    await vi.waitFor(() => { expect(decision().phase).not.toBe('open') }, { timeout: 240_000, interval: 1_000 })

    // Three models were streaming their own turns into one room, and at least
    // two of the reviewers overlapped: attributed frames interleave, not queue.
    const streaming = new Set(frames.map(frame => frame.participantName))
    for (const name of names) expect(streaming.has(name)).toBe(true)
    const speakers = frames
      .map(frame => frame.participantName)
      .filter(speaker => (names as readonly string[]).includes(speaker))
    const interleaved = speakers.some((speaker, index) =>
      speakers.slice(index + 1).includes(speaker)
      && new Set(speakers.slice(0, index + 1)).size > 1)
    expect(interleaved).toBe(true)

    const settled = decision()
    expect(['accepted', 'rejected']).toContain(settled.phase)
    // The outcome is exactly what the recorded arithmetic yields: acceptance
    // needs two approvals and a clean board, rejection needs two objections or
    // any standing objection once everyone has voted.
    const approved = settled.approvals.length
    const rejected = settled.rejections.length
    expect(settled.awaiting).toEqual([])
    expect(settled.requiredApprovals).toBe(2)
    expect(settled.phase === 'accepted').toBe(approved >= 2 && rejected === 0)
    // Every standing is attributed to a reviewer and carries the reason it gave,
    // and the tallies are exactly the standings the room recorded.
    const standings = [...settled.standings]
    expect(standings.length).toBeGreaterThanOrEqual(1)
    const recorded = new Map<string, string>()
    for (const standing of standings) {
      expect((names as readonly string[]).includes(standing.reviewer)).toBe(true)
      expect(standing.reason.trim().length).toBeGreaterThan(0)
      recorded.set(standing.reviewer, standing.verdict)
    }
    expect(recorded.size).toBe(standings.length)
    for (const name of settled.approvals) expect(recorded.get(name)).toBe('approve')
    for (const name of settled.rejections) expect(recorded.get(name)).toBe('reject')
    for (const name of settled.abstentions) expect(recorded.get(name)).toBe('abstain')

    // The proposer learns the collective outcome with the split that produced it.
    await vi.waitFor(() => {
      const notice = delivered(ctx, lead.id).find(text => text.includes(settled.id))
      expect(notice).toBeDefined()
      expect(notice).toContain(`is ${settled.phase}`)
    }, { timeout: 120_000, interval: 500 })
  }, 300_000)
})
