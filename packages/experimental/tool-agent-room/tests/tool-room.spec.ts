import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService from '../../agent-team/src/index.ts'
import { teamProjectionDefinition } from '../../agent-team/src/projection.ts'
import type { RoomStreamFrame } from '../../agent-team/src/index.ts'
import * as toolRoom from '../src/index.ts'

const SIGNAL = new AbortController().signal
/** An opening turn that never settles, so a participant stays live as an authority credential. */
const HANG = 'hang' as const
const ROOM_TOOLS = ['room_escalate', 'room_prompt', 'room_propose', 'room_review', 'room_view'].sort()

const roots: string[] = []
const contexts = new Set<Context>()
const cleanups: Array<() => void> = []
let callNumber = 0

/** Session query implementation whose search faces are outside these tests. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  options: { readonly config?: toolRoom.Config; readonly leadModel?: boolean } = {},
) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-room-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TimerService)
  await ctx.plugin(TeamService, { roomEnabled: true, maxMembers: 4 })
  const fiber = await ctx.plugin(toolRoom, options.config ?? {})
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(
    SessionId('room-lead'),
    options.leadModel === false ? {} : { provider: 'mock', model: 'mock' },
  )
  return { ctx, lead, adapter, storageRoot, fiber }
}

function execute(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: unknown,
  signal: AbortSignal = SIGNAL,
) {
  return ctx.tools.execute({
    callId: ToolCallId(`room-call-${++callNumber}`),
    name,
    arguments: args,
    signal,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function parsed(result: Awaited<ReturnType<typeof execute>>): Record<string, unknown> {
  const value: unknown = JSON.parse(text(result))
  if (typeof value !== 'object' || value === null) throw new Error('expected an object result')
  return value as Record<string, unknown>
}

/** Spawn one participant whose opening turn stays open, so it stays live and never settles. */
async function addHangingParticipant(ctx: Context, lead: Agent, name: string): Promise<SessionId> {
  const member = await ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: `${name} responsibility`,
    prompt: [{ type: 'text', text: `${name} initial` }],
    context: 'fresh',
    provider: 'spawn',
    signal: SIGNAL,
  })
  const id = member.member.id
  await vi.waitFor(() => { expect(ctx.agents.get(id)?.status).toBe('running') }, { timeout: 5_000 })
  cleanups.push(() => { ctx.agents.get(id)?.cancel({ kind: 'parent' }) })
  return id
}

/** Every model-facing item the room mailbox delivered to one participant. */
function deliveredTexts(ctx: Context, id: SessionId): string[] {
  const session = ctx.sessions.get(id)
  if (session === undefined) return []
  return session.snapshotEvents()
    .flatMap(event => event.type === 'user/message' && event.data.source.kind === 'team-message'
      ? [event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
      : [])
}

/** Run one complete model turn for an agent and wait until it is idle again. */
async function runTurn(agent: Agent, prompt: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function assembly(ctx: Context, agent: Agent) {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return ctx.systemPrompt.assemble({ scope })
}

/** Replay one persisted Session's events through the shipped Team projection. */
async function replay(ctx: Context, id: SessionId) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  let events: readonly SessionEvent[]
  try {
    events = (await handle.read()).events
  } finally {
    await handle.close()
  }
  let state = teamProjectionDefinition.init({
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
  })
  for (const event of events) state = teamProjectionDefinition.apply(state, event)
  if (state.failure !== undefined) throw new Error(state.failure)
  return state
}

describe('dsh-tool-room', () => {
  it('installs the room policy and every room tool in each participant scope', async () => {
    const { ctx, lead } = await setup(['hang', ...Array.from({ length: 4 }, () => textResponse('ack'))])
    const alice = await addHangingParticipant(ctx, lead, 'alice')

    for (const agent of [lead, ctx.agents.get(alice)!]) {
      const installed = await assembly(ctx, agent)
      expect(installed.tools.map(schema => schema.name).filter(name => ROOM_TOOLS.includes(name)).sort())
        .toEqual(ROOM_TOOLS)
      expect(renderPrompt(installed)).toContain('This session is a room')
    }
  })

  it('settles a decision only after every reviewer approves, driven by model tool calls', async () => {
    const script = [
      HANG,
      HANG,
      toolCallResponse('room-call-propose', 'room_propose', { statement: 'adopt approach A' }),
      textResponse('proposed'),
      ...Array.from({ length: 6 }, () => textResponse('ack')),
    ]
    const { ctx, lead } = await setup(script)
    const alice = await addHangingParticipant(ctx, lead, 'alice')
    const bob = await addHangingParticipant(ctx, lead, 'bob')

    // The proposer is the model itself: its turn calls the real tool through the loop.
    await runTurn(lead, 'decide how to proceed')
    const opened = ctx.agentTeams.roomView(lead).proposals[0]!
    expect(opened).toMatchObject({
      phase: 'open',
      proposerName: 'lead',
      statement: 'adopt approach A',
      requiredApprovals: 1,
      awaiting: ['alice', 'bob'],
    })

    const first = parsed(await execute(ctx, ctx.agents.get(alice), 'room_review', {
      proposal_id: opened.id,
      revision: 1,
      verdict: 'approve',
      reason: 'clearly correct',
    }))
    expect(first).toMatchObject({ phase: 'open', approvals: ['alice'], awaiting: ['bob'] })

    const settled = parsed(await execute(ctx, ctx.agents.get(bob), 'room_review', {
      proposal_id: opened.id,
      revision: 1,
      verdict: 'approve',
      reason: 'agreed',
    }))
    expect(settled).toMatchObject({ phase: 'accepted', approvals: ['alice', 'bob'], awaiting: [] })
  })

  it('blocks a decision on one rejection and reports the split to the room', async () => {
    const { ctx, lead } = await setup([HANG, HANG, ...Array.from({ length: 8 }, () => textResponse('ack'))])
    const alice = await addHangingParticipant(ctx, lead, 'alice')
    const bob = await addHangingParticipant(ctx, lead, 'bob')
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'delete the index', signal: SIGNAL })

    const rejected = parsed(await execute(ctx, ctx.agents.get(alice), 'room_review', {
      proposal_id: opened.id,
      revision: 1,
      verdict: 'reject',
      reason: 'destroys recovery',
    }))
    expect(rejected).toMatchObject({ phase: 'rejected', rejections: ['alice'], approvals: [] })

    const view = parsed(await execute(ctx, lead, 'room_view', {}))
    expect(view.decisions).toEqual([rejected])
    expect(view.participants).toEqual([
      expect.objectContaining({ name: 'lead' }),
      expect.objectContaining({ name: 'alice' }),
      expect.objectContaining({ name: 'bob' }),
    ])
    expect(bob).toBeDefined()
  })

  it('refuses self-review, stale revisions, unknown decisions, and self-prompts through the tools', async () => {
    const { ctx, lead } = await setup([HANG, ...Array.from({ length: 8 }, () => textResponse('ack'))])
    const alice = await addHangingParticipant(ctx, lead, 'alice')
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'first', signal: SIGNAL })

    // The guard reaches the model as a tool error result, and the decision it
    // protected is unchanged.
    const refusals = [
      await execute(ctx, lead, 'room_review', {
        proposal_id: opened.id, revision: 1, verdict: 'approve', reason: 'my own idea',
      }),
      await execute(ctx, ctx.agents.get(alice), 'room_review', {
        proposal_id: opened.id, revision: 9, verdict: 'approve', reason: 'future',
      }),
      await execute(ctx, ctx.agents.get(alice), 'room_review', {
        proposal_id: 'proposal-404', revision: 1, verdict: 'abstain', reason: 'nowhere',
      }),
      await execute(ctx, ctx.agents.get(alice), 'room_prompt', {
        target: 'alice', instruction: 'talk to yourself',
      }),
      await execute(ctx, lead, 'room_escalate', {
        proposal_id: 'proposal-404', reason: 'nowhere',
      }),
    ]
    expect(refusals.map(result => result.isError)).toEqual([true, true, true, true, true])
    expect(refusals.map(text)).toEqual([
      expect.stringContaining('a proposer cannot review its own decision'),
      expect.stringContaining('is at revision 1'),
      expect.stringContaining('not found'),
      expect.stringContaining('cannot prompt itself'),
      expect.stringContaining('not found'),
    ])
    expect(ctx.agentTeams.roomView(lead).proposals[0]).toMatchObject({ phase: 'open', approvals: [] })
  })

  it('gives one participant the floor with the transcript it has not seen', async () => {
    const { ctx, lead } = await setup(Array.from({ length: 12 }, () => textResponse('ack')))
    const spawn = (name: string) => ctx.agentTeams.spawnTeammate(lead, {
      name,
      description: `${name} responsibility`,
      prompt: [{ type: 'text', text: `${name} initial` }],
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })
    const alice = (await spawn('alice')).member.id
    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).messages.map(message => message.authorName)).toContain('alice')
    }, { timeout: 5_000 })
    await spawn('bob')
    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).messages.map(message => message.authorName)).toContain('bob')
    }, { timeout: 5_000 })

    const result = parsed(await execute(ctx, lead, 'room_prompt', {
      target: 'alice',
      instruction: 'weigh in on the proposal',
    }))
    expect(result.messageId).toMatch(/^team-message-/)
    await vi.waitFor(() => {
      expect(deliveredTexts(ctx, alice).join('\n')).toContain('weigh in on the proposal')
    }, { timeout: 5_000 })
    // Alice is settled, so the room hands her the transcript she has not seen and
    // the mailbox cold-resumes her rather than addressing a live Agent.
    const handoff = deliveredTexts(ctx, alice).join('\n')
    expect(handoff).toContain('Room conversation so far:')
    expect(handoff).toContain('bob: ack')
    expect(handoff).not.toContain('alice: ack')
  })

  it('bounds the transcript one room_view result returns', async () => {
    const { ctx, lead } = await setup(['hang', 'hang', ...Array.from({ length: 6 }, () => textResponse('ack'))])
    const alice = await addHangingParticipant(ctx, lead, 'alice')
    await addHangingParticipant(ctx, lead, 'bob')
    const first = parsed(await execute(ctx, ctx.agents.get(alice), 'room_view', {}))
    expect(first.transcript).toEqual([])
    expect(first.truncated).toBe(false)
    expect(first.chair).toBe('lead')
  })

  it('streams two participants concurrently into one room', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const frames: RoomStreamFrame[] = []
    let peakRunning = 0
    ctx.on('room/stream', (payload) => {
      frames.push(payload)
      peakRunning = Math.max(peakRunning, ctx.agents.list().filter(agent => agent.status === 'running').length)
    })
    await addHangingParticipant(ctx, lead, 'alice')
    await addHangingParticipant(ctx, lead, 'bob')

    expect(new Set(frames.map(frame => frame.participantName))).toEqual(new Set(['alice', 'bob']))
    // Both turns hold the model stream open at once, so the room carries two live
    // participants rather than one at a time.
    expect(peakRunning).toBe(2)
    expect(ctx.agents.get(lead.id)!.status).toBe('idle')
  })


  it('removes and reinstalls every scoped registration across plugin HMR', async () => {
    const { ctx, lead, fiber } = await setup([HANG])
    const alice = await addHangingParticipant(ctx, lead, 'alice')
    const child = ctx.agents.get(alice)!

    await fiber.dispose()
    for (const agent of [lead, child]) {
      expect((await assembly(ctx, agent)).tools.map(schema => schema.name).some(name => ROOM_TOOLS.includes(name)))
        .toBe(false)
    }
    expect((await assembly(ctx, child)).tools.map(schema => schema.name)).not.toContain('room_view')

    const replacement = await ctx.plugin(toolRoom, {})
    for (const agent of [lead, child]) {
      expect((await assembly(ctx, agent)).tools.map(schema => schema.name).filter(name => ROOM_TOOLS.includes(name)).sort())
        .toEqual(ROOM_TOOLS)
    }
    await replacement.dispose()
  })

  it('rolls back a partial installation when a room tool name already exists in scope', async () => {
    const { ctx, lead, fiber } = await setup([HANG])
    await fiber.dispose()
    lead.ctx.tools.register(defineContentToolFixture({
      name: 'room_view',
      description: 'intentional collision',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'collision' }] },
    }))

    await expect(ctx.plugin(toolRoom, {})).rejects.toThrow(/already registered/u)
    const assembled = await assembly(ctx, lead)
    expect(assembled.tools.filter(schema => ROOM_TOOLS.includes(schema.name)).map(schema => schema.name))
      .toEqual(['room_view'])
    expect(renderPrompt(assembled)).not.toContain('This session is a room')
  })

  it('reports a participant that runs no model of its own', async () => {
    const { ctx, lead } = await setup([HANG], { leadModel: false })
    const view = parsed(await execute(ctx, lead, 'room_view', {}))
    expect(view.participants).toEqual([{ name: 'lead', status: 'inactive' }])
  })

  it('bounds the transcript by configured tool capacity rather than a model-supplied value', async () => {
    const { ctx, lead } = await setup([HANG, HANG, ...Array.from({ length: 6 }, () => textResponse('ack'))], {
      config: { maxTranscriptEntries: 2 },
    })
    await addHangingParticipant(ctx, lead, 'alice')
    const alice = ctx.agentTeams.roomView(lead).participants[1]!.id
    const view = parsed(await execute(ctx, ctx.agents.get(alice), 'room_view', { entries: 100 }))
    expect(Array.isArray(view.transcript)).toBe(true)
    expect((view.transcript as unknown[]).length).toBeLessThanOrEqual(2)
  })

  it('refuses every room tool for a provider-owned subagent', async () => {
    const { ctx, lead } = await setup(Array.from({ length: 4 }, () => textResponse('ack')))
    const run = await ctx.subagents.start('spawn', {
      parent: lead,
      prompt: [{ type: 'text', text: 'provider-owned child' }],
      signal: SIGNAL,
    })
    await run.result
    const child = run.localAgent!
    expect(ctx.agentTeams.tryMembership(child)).toBeUndefined()
    // Scoped installation reaches the child before its descriptor is recorded,
    // so the authority check inside the operation is what refuses it.
    const refused = await execute(ctx, child, 'room_view', {})
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('is not a member of an active Agent Team')
  })


  it('carries a revised statement back to the room after a rejection', async () => {
    const { ctx, lead } = await setup([HANG, HANG, ...Array.from({ length: 8 }, () => textResponse('ack'))])
    const alice = await addHangingParticipant(ctx, lead, 'alice')
    const bob = await addHangingParticipant(ctx, lead, 'bob')
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'ship on Friday', signal: SIGNAL })
    await execute(ctx, ctx.agents.get(alice), 'room_review', {
      proposal_id: opened.id, revision: 1, verdict: 'reject', reason: 'no release cover',
    })
    const revised = parsed(await execute(ctx, lead, 'room_propose', {
      statement: 'ship on Monday with release cover',
      supersedes: opened.id,
    }))
    expect(revised).toMatchObject({ id: opened.id, revision: 2, phase: 'open', awaiting: ['alice', 'bob'] })
    expect(bob).toBeDefined()
  })

  it('hands an unresolved decision to the human through the tool', async () => {
    const { ctx, lead } = await setup([HANG, ...Array.from({ length: 8 }, () => textResponse('ack'))])
    const alice = await addHangingParticipant(ctx, lead, 'alice')
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'the room cannot agree', signal: SIGNAL })
    const escalated = parsed(await execute(ctx, ctx.agents.get(alice), 'room_escalate', {
      proposal_id: opened.id,
      reason: 'the choice belongs to the human',
    }))
    expect(escalated).toMatchObject({ id: opened.id, phase: 'escalated' })
    expect(ctx.agentTeams.roomView(lead).proposals).toEqual([
      expect.objectContaining({ phase: 'escalated' }),
    ])
  })

  it('resolves direct-apply defaults without Loader schema normalization', async () => {
    const { ctx, lead, fiber } = await setup([HANG])
    await fiber.dispose()
    toolRoom.apply(ctx, {})
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).filter(name => ROOM_TOOLS.includes(name)).sort())
      .toEqual(ROOM_TOOLS)
  })

  it('leaves a provider-owned subagent that already exists alone when the tools mount', async () => {
    const { ctx, lead, fiber } = await setup([HANG, ...Array.from({ length: 4 }, () => textResponse('ack'))])
    await fiber.dispose()
    const run = await ctx.subagents.start('spawn', {
      parent: lead,
      prompt: [{ type: 'text', text: 'provider-owned child' }],
      signal: SIGNAL,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(run.localAgent!.id)?.status).toBe('running') }, { timeout: 5_000 })

    const replacement = await ctx.plugin(toolRoom, {})
    expect((await assembly(ctx, run.localAgent!)).tools.map(schema => schema.name)).not.toContain('room_view')
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name)).toContain('room_view')
    await replacement.dispose()
  })

  it('replays the transcript and the settled decision from the persisted log', async () => {
    const { ctx, lead } = await setup([HANG, HANG, ...Array.from({ length: 8 }, () => textResponse('ack'))])
    const alice = await addHangingParticipant(ctx, lead, 'alice')
    const bob = await addHangingParticipant(ctx, lead, 'bob')
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'replay me', signal: SIGNAL })
    await execute(ctx, ctx.agents.get(alice), 'room_review', {
      proposal_id: opened.id, revision: 1, verdict: 'approve', reason: 'sound',
    })
    await execute(ctx, ctx.agents.get(bob), 'room_review', {
      proposal_id: opened.id, revision: 1, verdict: 'approve', reason: 'agreed',
    })
    await ctx.sessions.flush(lead.session)

    const replayed = await replay(ctx, lead.id)
    expect(replayed.roomProposals[0]).toMatchObject({ id: opened.id, phase: 'accepted', revision: 1 })
    expect(replayed.roomReviews).toHaveLength(2)
    expect(replayed.roomReviews.every(review => review.reason.length > 0)).toBe(true)
    expect(replayed.members.map(member => member.name)).toEqual(['alice', 'bob'])
  })
})
