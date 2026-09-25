import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService, { TeamError } from '../src/index.ts'
import type { RoomFollowFrame, RoomProposalId, RoomStreamFrame } from '../src/index.ts'
import { TeamId } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const cleanups: Array<() => void> = []

afterEach(() => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One settled scripted turn. */
function ack() {
  return textResponse('ack')
}

/** A script long enough for every settle-and-wake one test provokes. */
function acks(count: number) {
  return Array.from({ length: count }, ack)
}

/** An opening turn that never settles, so the participant stays live as an authority credential. */
const HANGING = 'hang' as const

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  config: ConstructorParameters<typeof TeamService>[1] = {},
  /** Set false to compose a room without the timer its review deadlines resolve. */
  timer = true,
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-room-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  if (timer) await ctx.plugin(TimerService)
  const fiber = await ctx.plugin(TeamService, { roomEnabled: true, ...config })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, adapter, fiber }
}

function content(text: string) {
  return [{ type: 'text' as const, text }]
}

function spawnOptions(name: string) {
  return {
    name,
    description: `${name} responsibility`,
    prompt: content(`${name} initial`),
    context: 'fresh' as const,
    provider: 'spawn',
    signal: SIGNAL,
  }
}

/** Create one participant and wait for its opening utterance to reach the transcript. */
async function addParticipant(ctx: Context, lead: Agent, name: string, utterance: string): Promise<SessionId> {
  const before = ctx.agentTeams.roomView(lead).messages.length
  const member = await ctx.agentTeams.spawnTeammate(lead, spawnOptions(name))
  await vi.waitFor(() => {
    expect(ctx.agentTeams.roomView(lead).messages.length).toBeGreaterThan(before)
    expect(ctx.agentTeams.roomView(lead).messages.at(-1)?.content).toEqual(content(utterance))
  }, { timeout: 5_000 })
  return member.member.id
}

/** Create one participant whose opening turn stays live, and register its teardown. */
async function addLiveParticipant(ctx: Context, lead: Agent, name: string): Promise<SessionId> {
  const member = await ctx.agentTeams.spawnTeammate(lead, spawnOptions(name))
  const id = member.member.id
  await vi.waitFor(() => { expect(ctx.agents.get(id)?.status).toBe('running') }, { timeout: 5_000 })
  cleanups.push(() => { ctx.agents.get(id)?.cancel({ kind: 'parent' }) })
  return id
}

/**
 * Every model-facing item delivered through the room mailbox to one participant.
 * Read by Session identity: a settled participant's Agent is gone, but its
 * Session log is not.
 */
function delivered(ctx: Context, id: SessionId): string[] {
  const session = ctx.sessions.get(id)
  if (session === undefined) return []
  return session.snapshotEvents()
    .flatMap(event => event.type === 'user/message' && event.data.source.kind === 'team-message'
      ? [event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
      : [])
}

/** Text of every assistant message one Agent committed to its own Session. */
function answers(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .flatMap(event => event.type === 'assistant/message'
      ? [event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
      : [])
}

describe('room transcript', () => {
  it('records each participant utterance with durable attribution', async () => {
    const { ctx, lead } = await setup(acks(8))
    const alice = await addParticipant(ctx, lead, 'alice', 'ack')
    const bob = await addParticipant(ctx, lead, 'bob', 'ack')

    const view = ctx.agentTeams.roomView(lead)
    expect(view.messages.map(message => message.authorName)).toEqual(['alice', 'lead', 'bob', 'lead'])
    expect(view.messages.every(message => message.id.startsWith('room-message-'))).toBe(true)
    expect(view.participants.map(participant => participant.name)).toEqual(['lead', 'alice', 'bob'])
    expect(view.chair).toBe(view.participants[view.messages.length % view.participants.length]!.name)
    expect(view.participants.slice(1).map(participant => participant.id)).toEqual([alice, bob])
  })

  it('opens the transcript with the first teammate', async () => {
    const { ctx, lead } = await setup(acks(6))
    lead.followup(createUserMessage({ content: content('a question for the Lead alone'), source: { kind: 'user' } }))
    await lead.whenIdle()
    await addParticipant(ctx, lead, 'alice', 'ack')

    // The Lead's answer before any teammate existed is its own conversation, not the room's.
    expect(ctx.agentTeams.roomView(lead).messages.map(message => message.authorName)).toEqual(['alice', 'lead'])
    const recorded = lead.session.snapshotEvents().filter(event => event.type === 'room/message')
    expect(recorded).toHaveLength(2)
  })

  it('carries only the transcript a target has not yet seen', async () => {
    const { ctx, lead } = await setup(acks(10))
    const alice = await addParticipant(ctx, lead, 'alice', 'ack')
    await addParticipant(ctx, lead, 'bob', 'ack')

    // Alice's own utterance is the first transcript entry, so the delta is Bob's alone.
    await ctx.agentTeams.roomPrompt(lead, {
      target: 'alice',
      instruction: content('please continue'),
      signal: SIGNAL,
    })
    await vi.waitFor(() => { expect(delivered(ctx, alice)).toHaveLength(1) }, { timeout: 5_000 })
    const text = delivered(ctx, alice)[0]!
    expect(text).toContain('Room conversation so far:')
    expect(text).toContain('bob: ack')
    expect(text).not.toContain('alice: ack')
    expect(text).toContain('please continue')
  })

  it('refuses a participant prompting itself', async () => {
    const { ctx, lead } = await setup([HANGING, ...acks(4)])
    const alice = await addLiveParticipant(ctx, lead, 'alice')
    await expect(ctx.agentTeams.roomPrompt(ctx.agents.get(alice)!, {
      target: 'alice',
      instruction: content('again'),
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_SELF_PROMPT' })
  })

  it('reports no room when the composition disables rooms, and still refuses every write', async () => {
    const { ctx, lead } = await setup(acks(2), { roomEnabled: false })
    // Reads stay total so a panel can render an absent room instead of an error.
    expect(ctx.agentTeams.roomView(lead)).toEqual({
      enabled: false,
      participants: [],
      chair: 'lead',
      messages: [],
      proposals: [],
    })
    expect(ctx.agentTeams.remoteRoom(lead)).toEqual({
      enabled: false,
      participants: [],
      chair: 'lead',
      messages: [],
      proposals: [],
    })
    await expect(ctx.agentTeams.roomPrompt(lead, {
      target: 'nobody',
      instruction: content('hi'),
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_DISABLED' })
    await expect(ctx.agentTeams.roomPropose(lead, {
      statement: 'nothing to decide',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_DISABLED' })
    await expect(ctx.agentTeams.roomReview(lead, {
      proposalId: 'proposal-1' as RoomProposalId,
      proposalRevision: 1,
      verdict: 'approve',
      reason: 'nothing to review',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_DISABLED' })
    await expect(ctx.agentTeams.roomEscalate(lead, {
      proposalId: 'proposal-1' as RoomProposalId,
      reason: 'nothing to escalate',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_DISABLED' })
  })

  it('emits one attributed live stream per participant frame', async () => {
    const { ctx, lead } = await setup(acks(6))
    const frames: RoomStreamFrame[] = []
    ctx.on('room/stream', (payload) => { frames.push(payload) })
    await addParticipant(ctx, lead, 'alice', 'ack')

    const aliceFrames = frames.filter(frame => frame.participantName === 'alice')
    expect(aliceFrames.length).toBeGreaterThan(0)
    expect(frames.every(frame => String(frame.teamId) === lead.id)).toBe(true)
    expect(aliceFrames.map(frame => frame.frame.type)).toEqual(expect.arrayContaining(['start', 'end']))
  })

  it('keeps two participants streaming at the same time attributed', async () => {
    // Alice's opening stream holds open after its first frames, so Bob's whole
    // stream runs inside it: one room carries two live participant streams at
    // once, each attributed to the participant that produced it.
    const aliceChunks = textResponse('alice is still working').slice(0, 2)
    const { ctx, lead } = await setup([
      { hangAfter: aliceChunks },
      textResponse('bob finished'),
      // The Lead answers the spawn result with a hanging turn, so it adds no
      // utterance and no completed stream of its own to the room.
      HANGING,
      ...acks(2),
    ])
    const frames: RoomStreamFrame[] = []
    ctx.on('room/stream', (payload) => { frames.push(payload) })

    const alice = await addLiveParticipant(ctx, lead, 'alice')
    const bob = await addParticipant(ctx, lead, 'bob', 'bob finished')

    const spoken = frames.filter(frame => frame.participantName !== 'lead')
    expect(spoken.every(frame => String(frame.teamId) === lead.id)).toBe(true)
    // Alice streamed first and is still streaming after Bob finished.
    expect(spoken.slice(0, aliceChunks.length + 1).map(frame => frame.participantName))
      .toEqual(Array.from({ length: aliceChunks.length + 1 }, () => 'alice'))
    expect(spoken.slice(aliceChunks.length + 1).map(frame => frame.participantName))
      .toEqual(Array.from({ length: spoken.length - aliceChunks.length - 1 }, () => 'bob'))
    expect(spoken.at(-1)?.frame.type).toBe('end')
    expect(spoken.some(frame => frame.participantName === 'alice' && frame.frame.type === 'end')).toBe(false)
    expect(spoken.filter(frame => frame.participantName === 'alice').every(frame => frame.participantId === alice)).toBe(true)
    expect(spoken.filter(frame => frame.participantName === 'bob').every(frame => frame.participantId === bob)).toBe(true)
    // The room still counts Alice as a live participant while she streams.
    expect(ctx.agentTeams.roomView(lead).participants.find(participant => participant.name === 'alice')?.status)
      .toBe('running')
  })

  it('follows a room live: a view first, then every change and stream chunk', async () => {
    // The Lead answers a spawn result with its own turn, so it hangs here and
    // stays silent: the reader sees exactly one participant's work.
    const { ctx, lead } = await setup([textResponse('alice reports'), HANGING, ...acks(4)])
    const abort = new AbortController()
    const frames: RoomFollowFrame[] = []
    const pump = (async () => {
      for await (const frame of ctx.agentTeams.roomStream(lead, abort.signal)) frames.push(frame)
    })()

    // A reader opens on the complete current room before anything changes.
    await vi.waitFor(() => { expect(frames.length).toBeGreaterThan(0) }, { timeout: 5_000 })
    expect(frames[0]).toMatchObject({ type: 'view' })
    expect(frames[0]?.type === 'view' && frames[0].view.enabled).toBe(true)

    const opened = frames.length
    await addParticipant(ctx, lead, 'alice', 'alice reports')
    // The committed utterance republishes the view, and the live chunk arrived
    // before it because the participant streamed while its turn ran.
    await vi.waitFor(() => {
      expect(frames.slice(opened).some(frame => frame.type === 'view'
        && frame.view.messages.some(message => message.author === 'alice'))).toBe(true)
    }, { timeout: 5_000 })
    expect(frames.slice(opened)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'stream', participant: 'alice' }),
    ]))

    abort.abort()
    await pump
  }, 15_000)

  it('streams and republishes nothing while the Lead has no teammate', async () => {
    const { ctx, lead } = await setup([textResponse('first answer'), textResponse('second answer')])
    const streamed: RoomStreamFrame[] = []
    ctx.on('room/stream', (payload) => { streamed.push(payload) })
    const abort = new AbortController()
    const frames: RoomFollowFrame[] = []
    const pump = (async () => {
      for await (const frame of ctx.agentTeams.roomStream(lead, abort.signal)) frames.push(frame)
    })()
    await vi.waitFor(() => { expect(frames).toHaveLength(1) }, { timeout: 5_000 })

    for (const question of ['first question', 'second question']) {
      lead.followup(createUserMessage({ content: content(question), source: { kind: 'user' } }))
      await lead.whenIdle()
    }
    await new Promise(resolve => setTimeout(resolve, 50))
    // The Lead answered twice in its own conversation; a reader of its room saw neither answer.
    expect(answers(lead)).toEqual(['first answer', 'second answer'])
    expect(streamed).toEqual([])
    expect(frames).toHaveLength(1)

    abort.abort()
    await pump
  }, 15_000)

  it('leaves a Lead whose Team log the projection refused answering quietly outside any room', async () => {
    const { ctx, lead } = await setup([textResponse('still answering')])
    const streamed: RoomStreamFrame[] = []
    ctx.on('room/stream', (payload) => { streamed.push(payload) })
    const warnings: string[] = []
    ctx.logger.warn = ((value: unknown) => { warnings.push(String(value)) }) as typeof ctx.logger.warn
    // A resumed log the Team projection cannot fold reports a failure instead of Team state.
    const projections = ctx.sessionProjections
    const read = projections.stateOf.bind(projections)
    vi.spyOn(projections, 'stateOf').mockImplementation((session, key) => {
      if (key !== 'agentTeam' || session.id !== lead.id) return read(session, key)
      return { ...read(session, 'agentTeam')!, failure: 'the recorded Team log is refused' }
    })

    lead.followup(createUserMessage({ content: content('are you there'), source: { kind: 'user' } }))
    await lead.whenIdle()
    expect(answers(lead).at(-1)).toBe('still answering')
    expect(streamed).toEqual([])
    // Team operations report the refusal; the room does not repeat it for every streamed chunk.
    expect(warnings).toEqual([])
  })

  it('ignores another room, other frame kinds, and ends when the service disposes', async () => {
    const { ctx, lead, fiber } = await setup([HANGING, ...acks(2)])
    const abort = new AbortController()
    const frames: RoomFollowFrame[] = []
    const pump = (async () => {
      for await (const frame of ctx.agentTeams.roomStream(lead, abort.signal)) frames.push(frame)
    })()
    await vi.waitFor(() => { expect(frames.length).toBe(1) }, { timeout: 5_000 })

    // Another team's change and a frame carrying no text never reach this reader.
    ctx.emit('room/updated', { teamId: 'other-team' as TeamId })
    ctx.emit('room/stream', {
      teamId: 'other-team' as TeamId,
      participantId: SessionId('other'),
      participantName: 'other',
      frame: { type: 'start', attemptId: 'attempt' as never, revision: 1, turn: 1, step: 1 },
    })
    ctx.emit('room/stream', {
      teamId: TeamId(lead.id),
      participantId: SessionId('lead'),
      participantName: 'lead',
      frame: { type: 'start', attemptId: 'attempt' as never, revision: 1, turn: 1, step: 1 },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(frames).toHaveLength(1)

    // Disposing the service finishes every open reader.
    await fiber.dispose()
    await pump
    expect(frames).toHaveLength(1)
  }, 15_000)

  it('ends a reader whose Lead is gone without failing the change that notified it', async () => {
    const { ctx } = await setup(acks(2))
    const handle = await ctx.agents.create({
      sessionId: SessionId('replaced-lead'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const frames: RoomFollowFrame[] = []
    const pump = (async () => {
      for await (const frame of ctx.agentTeams.roomStream(handle.agent, SIGNAL)) frames.push(frame)
    })()
    await vi.waitFor(() => { expect(frames.length).toBe(1) }, { timeout: 5_000 })

    await handle.dispose()
    // A change committed for the same Team after its Lead Agent left reaches this reader.
    expect(() => { ctx.emit('room/updated', { teamId: TeamId(handle.agent.id) }) }).not.toThrow()
    await pump
    expect(frames).toHaveLength(1)
  }, 15_000)

  it('reports a live participant that produced no work in the window as quiet', async () => {
    // A participant that streams nothing goes quiet once the window lapses; any
    // observed work returns it to the board as an active participant.
    const { ctx, lead } = await setup([HANGING], { roomReviewGraceMs: 200 })
    const alice = await addLiveParticipant(ctx, lead, 'alice')
    const quietNow = (): boolean => ctx.agentTeams.roomView(lead).participants
      .find(participant => participant.id === alice)?.quiet ?? false

    await vi.waitFor(() => { expect(quietNow()).toBe(true) }, { timeout: 5_000 })
    ctx.agents.get(alice)?.steer(createUserMessage({
      content: [{ type: 'text', text: 'keep going' }],
      source: { kind: 'user' },
    }))
    await vi.waitFor(() => { expect(quietNow()).toBe(false) }, { timeout: 5_000 })
  }, 15_000)

  it('records no transcript entry for a turn that never settles', async () => {
    const { ctx, lead } = await setup([HANGING])
    await addLiveParticipant(ctx, lead, 'alice')
    expect(ctx.agentTeams.roomView(lead).messages).toEqual([])
  })
})

describe('room collective decisions', () => {
  /** A room of the live Lead plus two participants whose opening turns stay open. */
  async function room() {
    const result = await setup([HANGING, HANGING, ...acks(8)])
    const alice = await addLiveParticipant(result.ctx, result.lead, 'alice')
    const bob = await addLiveParticipant(result.ctx, result.lead, 'bob')
    return { ...result, alice, bob }
  }

  /**
   * A three-participant room. With three eligible reviewers one rejection is
   * short of quorum, which is the only shape that leaves a decision open.
   */
  async function wideRoom() {
    const result = await setup([HANGING, HANGING, HANGING, ...acks(8)])
    const alice = await addLiveParticipant(result.ctx, result.lead, 'alice')
    const bob = await addLiveParticipant(result.ctx, result.lead, 'bob')
    const carol = await addLiveParticipant(result.ctx, result.lead, 'carol')
    return { ...result, alice, bob, carol }
  }

  it('excludes a member whose provisioning failed', async () => {
    const { ctx, lead } = await setup(acks(2))
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      ...spawnOptions('broken'),
      provider: 'missing-provider',
    })).rejects.toThrow()
    expect(ctx.agentTeams.roomView(lead).participants.map(participant => participant.name)).toEqual(['lead'])
  })

  it('shows a provisioning member without counting it as a reviewer', async () => {
    const { ctx, lead } = await setup(acks(2))
    // The durable provisioning prefix a spawn writes before its child Session
    // exists. The room shows the member, but no mailbox can address it yet.
    lead.session.append('team/member', {
      version: 2,
      teamId: TeamId(lead.id),
      member: {
        id: SessionId('pending-member'),
        name: 'pending',
        description: 'pending responsibility',
        provider: 'spawn',
        context: 'fresh',
        phase: 'provisioning',
      },
    })
    expect(ctx.agentTeams.roomView(lead).participants.map(participant => participant.name))
      .toEqual(['lead', 'pending'])
    // Asking it would throw TEAM_MEMBER_NOT_FOUND after the proposal was already
    // committed, so it must not hold the decision open.
    await expect(ctx.agentTeams.roomPropose(lead, { statement: 'solo decision', signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'TEAM_ROOM_NO_REVIEWERS' })
  })

  it('keeps a settled decision whose proposer cannot be reached', async () => {
    const { ctx, lead } = await setup([HANGING, HANGING, ...acks(8)], { maxPendingMessagesPerMember: 1 })
    const alice = await addLiveParticipant(ctx, lead, 'alice')
    const bob = await addLiveParticipant(ctx, lead, 'bob')
    const opened = await ctx.agentTeams.roomPropose(ctx.agents.get(alice)!, {
      statement: 'contested', signal: SIGNAL,
    })

    // The proposer stops, and one peer message stays queued in its only inbox
    // slot, so the outcome notice the settled decision owes it is refused.
    ctx.agents.get(alice)?.cancel({ kind: 'parent' })
    await vi.waitFor(() => { expect(ctx.agents.get(alice)).toBeUndefined() }, { timeout: 5_000 })
    vi.spyOn(ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('temporary read failure'))
    const queued = await ctx.agentTeams.sendMessage(lead, {
      target: 'alice', content: content('queued while stopped'), signal: SIGNAL,
    })
    expect(queued.status).toBe('queued')

    // One rejection from bob reaches the threshold for two eligible reviewers,
    // so the decision settles and then owes its proposer the outcome.
    const warnings: string[] = []
    ctx.logger.warn = ((value: unknown) => { warnings.push(String(value)) }) as typeof ctx.logger.warn
    const settled = await ctx.agentTeams.roomReview(ctx.agents.get(bob)!, {
      proposalId: opened.id,
      proposalRevision: opened.revision,
      verdict: 'reject',
      reason: 'not this',
      signal: SIGNAL,
    })
    expect(settled.phase).toBe('rejected')
    expect(warnings).toEqual([expect.stringContaining('room notice failed')])
  })

  it('lets any participant put a decision to the room', async () => {
    const { ctx, alice } = await room()
    const opened = await ctx.agentTeams.roomPropose(ctx.agents.get(alice)!, {
      statement: 'alice proposes',
      signal: SIGNAL,
    })
    expect(opened).toMatchObject({ proposerName: 'alice', awaiting: ['lead', 'bob'] })
  })

  it('refuses a decision with no eligible reviewer', async () => {
    const { ctx, lead } = await setup(acks(1))
    await expect(ctx.agentTeams.roomPropose(lead, { statement: 'solo decision', signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'TEAM_ROOM_NO_REVIEWERS' })
  })

  it('accepts only after every eligible reviewer approves', async () => {
    const { ctx, lead, alice, bob } = await room()
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'use approach A', signal: SIGNAL })
    expect(opened).toMatchObject({
      id: 'proposal-1',
      revision: 1,
      proposerName: 'lead',
      phase: 'open',
      requiredApprovals: 1,
      awaiting: ['alice', 'bob'],
    })

    const first = await ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: opened.id,
      proposalRevision: 1,
      verdict: 'approve',
      reason: 'sound',
      signal: SIGNAL,
    })
    expect(first).toMatchObject({ phase: 'open', approvals: ['alice'], awaiting: ['bob'] })

    const settled = await ctx.agentTeams.roomReview(ctx.agents.get(bob)!, {
      proposalId: opened.id,
      proposalRevision: 1,
      verdict: 'approve',
      reason: 'agreed',
      signal: SIGNAL,
    })
    expect(settled).toMatchObject({ phase: 'accepted', approvals: ['alice', 'bob'], awaiting: [] })
    // Every participant reads who stood where and why, so a proposer can answer
    // the objection instead of only learning that one exists.
    expect(settled.standings).toEqual([
      { reviewer: 'alice', verdict: 'approve', reason: 'sound' },
      { reviewer: 'bob', verdict: 'approve', reason: 'agreed' },
    ])
    expect(ctx.agentTeams.roomView(lead).proposals).toEqual([settled])
  })

  it('drives the room through the generated Remote face', async () => {
    const { ctx, lead } = await room()

    // A browser client grants the floor, opens a decision, and escalates it.
    const prompted = await ctx.agentTeams.remoteRoomPrompt(lead, { target: 'alice', instruction: 'give your view' })
    expect(['accepted', 'queued']).toContain(prompted.status)
    const opened = await ctx.agentTeams.remoteRoomPropose(lead, { statement: 'adopt the remote path' })
    expect(opened).toMatchObject({ phase: 'open', statement: 'adopt the remote path', awaiting: ['alice', 'bob'] })
    const escalated = await ctx.agentTeams.remoteRoomEscalate(lead, {
      proposalId: opened.id,
      reason: 'the panel hands this to the human',
    })
    expect(escalated.phase).toBe('escalated')
    expect(ctx.agentTeams.remoteRoom(lead).proposals[0]?.phase).toBe('escalated')
  })

  it('settles two open decisions independently with the same reviewers', async () => {
    const { ctx, lead, alice, bob } = await room()
    const first = await ctx.agentTeams.roomPropose(lead, { statement: 'first decision', signal: SIGNAL })
    const second = await ctx.agentTeams.roomPropose(lead, { statement: 'second decision', signal: SIGNAL })
    expect(first.id).not.toBe(second.id)

    // One reviewer's standing on one decision says nothing about the other.
    await ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: first.id, proposalRevision: 1, verdict: 'approve', reason: 'sound', signal: SIGNAL,
    })
    await ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: second.id, proposalRevision: 1, verdict: 'reject', reason: 'not yet', signal: SIGNAL,
    })
    const afterAlice = ctx.agentTeams.roomView(lead).proposals
    expect(afterAlice.find(proposal => proposal.id === first.id))
      .toMatchObject({ phase: 'open', approvals: ['alice'], awaiting: ['bob'] })
    // A quorum rejection settles its own decision and leaves the other open.
    expect(afterAlice.find(proposal => proposal.id === second.id))
      .toMatchObject({ phase: 'rejected', rejections: ['alice'], awaiting: [] })

    // The second reviewer carries the first decision to acceptance, and each
    // decision keeps its own standings.
    const accepted = await ctx.agentTeams.roomReview(ctx.agents.get(bob)!, {
      proposalId: first.id, proposalRevision: 1, verdict: 'approve', reason: 'agreed', signal: SIGNAL,
    })
    expect(accepted.phase).toBe('accepted')
    expect(accepted.standings.map(standing => [standing.reviewer, standing.verdict])).toEqual([
      ['alice', 'approve'],
      ['bob', 'approve'],
    ])
    const settled = ctx.agentTeams.roomView(lead).proposals.find(proposal => proposal.id === second.id)
    expect(settled).toMatchObject({ phase: 'rejected' })
    expect(settled?.standings.map(standing => [standing.reviewer, standing.verdict])).toEqual([
      ['alice', 'reject'],
    ])
  })

  it('lets one quorum rejection settle a decision the proposer alone cannot carry', async () => {
    const { ctx, lead, alice, bob } = await room()
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'delete the index', signal: SIGNAL })
    const rejected = await ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: opened.id,
      proposalRevision: 1,
      verdict: 'reject',
      reason: 'destroys recovery',
      signal: SIGNAL,
    })
    expect(rejected.phase).toBe('rejected')
    expect(rejected.rejections).toEqual(['alice'])
    // Bob never voted, but a settled decision awaits nobody: his missing standing
    // cannot change an outcome quorum already reached.
    expect(rejected.awaiting).toEqual([])
    await vi.waitFor(() => {
      const outcome = delivered(ctx, lead.id).find(text => text.includes('is rejected'))
      expect(outcome).toContain('approvals: none')
    }, { timeout: 5_000 })

    // A settled decision is final: no later review may reopen it.
    await expect(ctx.agentTeams.roomReview(ctx.agents.get(bob)!, {
      proposalId: opened.id,
      proposalRevision: 1,
      verdict: 'approve',
      reason: 'too late',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_PROPOSAL_SETTLED' })
  })

  it('refuses self-review, stale revisions, and unknown decisions', async () => {
    const { ctx, lead, alice } = await room()
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'first', signal: SIGNAL })
    await expect(ctx.agentTeams.roomReview(lead, {
      proposalId: opened.id,
      proposalRevision: 1,
      verdict: 'approve',
      reason: 'I like my own idea',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_SELF_REVIEW' })
    await expect(ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: opened.id,
      proposalRevision: 2,
      verdict: 'approve',
      reason: 'future revision',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_STALE_REVISION' })
    await expect(ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: 'proposal-99' as RoomProposalId,
      proposalRevision: 1,
      verdict: 'approve',
      reason: 'nowhere',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_PROPOSAL_NOT_FOUND' })
  })

  it('reopens a rejected decision only through a new revision', async () => {
    const { ctx, lead, alice } = await room()
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'ship on Friday', signal: SIGNAL })
    await ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: opened.id,
      proposalRevision: 1,
      verdict: 'reject',
      reason: 'no release cover',
      signal: SIGNAL,
    })
    const revised = await ctx.agentTeams.roomPropose(lead, {
      statement: 'ship on Monday with release cover',
      supersedes: opened.id,
      signal: SIGNAL,
    })
    expect(revised).toMatchObject({ id: 'proposal-1', revision: 2, phase: 'open', awaiting: ['alice', 'bob'] })
    expect(ctx.agentTeams.roomView(lead).proposals).toEqual([revised])
  })

  it('refuses a revision beyond the configured limit so the room must escalate', async () => {
    const { ctx, lead } = await setup([HANGING, ...acks(4)], { roomMaxProposalRevisions: 1 })
    await addLiveParticipant(ctx, lead, 'alice')
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'v1', signal: SIGNAL })
    await expect(ctx.agentTeams.roomPropose(lead, {
      statement: 'v2',
      supersedes: opened.id,
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_REVISION_LIMIT' })
  })

  it('refuses an unknown superseded decision and a second escalation', async () => {
    const { ctx, lead, alice } = await room()
    await expect(ctx.agentTeams.roomPropose(lead, {
      statement: 'never opened',
      supersedes: 'proposal-42' as RoomProposalId,
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_PROPOSAL_NOT_FOUND' })

    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'rewrite the parser', signal: SIGNAL })
    const escalated = await ctx.agentTeams.roomEscalate(ctx.agents.get(alice)!, {
      proposalId: opened.id,
      reason: 'the room is split',
      signal: SIGNAL,
    })
    expect(escalated.phase).toBe('escalated')
    await expect(ctx.agentTeams.roomEscalate(lead, {
      proposalId: opened.id,
      reason: 'already done',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_ROOM_PROPOSAL_SETTLED' })
  })

  it('hands an unresolved decision to the human', async () => {
    const { ctx, lead, alice, bob } = await wideRoom()
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'rewrite the parser', signal: SIGNAL })
    await ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: opened.id,
      proposalRevision: 1,
      verdict: 'approve',
      reason: 'worth it',
      signal: SIGNAL,
    })
    await ctx.agentTeams.roomReview(ctx.agents.get(bob)!, {
      proposalId: opened.id,
      proposalRevision: 1,
      verdict: 'reject',
      reason: 'too risky',
      signal: SIGNAL,
    })
    const held = ctx.agentTeams.roomView(lead).proposals[0]
    expect(held).toMatchObject({ phase: 'open', approvals: ['alice'], rejections: ['bob'], awaiting: ['carol'] })
    await ctx.agentTeams.roomEscalate(ctx.agents.get(bob)!, {
      proposalId: opened.id,
      reason: 'the room is split',
      signal: SIGNAL,
    })
    await vi.waitFor(() => {
      expect(delivered(ctx, lead.id).some(text => text.includes('needs a human decision'))).toBe(true)
    }, { timeout: 5_000 })
  })

  it('lets the Lead escalate without addressing itself', async () => {
    const { ctx, lead } = await room()
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'lead decides alone', signal: SIGNAL })
    const escalated = await ctx.agentTeams.roomEscalate(lead, {
      proposalId: opened.id,
      reason: 'needs a human',
      signal: SIGNAL,
    })
    expect(escalated.phase).toBe('escalated')
    expect(delivered(ctx, lead.id).some(text => text.includes('needs a human decision'))).toBe(false)
  })

  it('tells the proposer the collective outcome', async () => {
    const { ctx, lead, alice, bob } = await room()
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'adopt the new schema', signal: SIGNAL })
    await ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: opened.id,
      proposalRevision: 1,
      verdict: 'approve',
      reason: 'clear win',
      signal: SIGNAL,
    })
    const settled = await ctx.agentTeams.roomReview(ctx.agents.get(bob)!, {
      proposalId: opened.id,
      proposalRevision: 1,
      verdict: 'abstain',
      reason: 'no strong view',
      signal: SIGNAL,
    })
    expect(settled).toMatchObject({ phase: 'accepted', approvals: ['alice'], abstentions: ['bob'] })
    await vi.waitFor(() => {
      const outcomes = delivered(ctx, lead.id).filter(text => text.includes('is accepted'))
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).toContain('approvals: alice')
      expect(outcomes[0]).toContain('abstentions: bob')
    }, { timeout: 5_000 })
  })


  it('ignores a turn that produced no text', async () => {
    const { ctx, lead } = await setup([textResponse(''), ...acks(3)])
    const member = await ctx.agentTeams.spawnTeammate(lead, spawnOptions('alice'))
    // The child contributed no text, so only the Lead's reply to its settlement is recorded.
    await vi.waitFor(() => { expect(delivered(ctx, lead.id).length).toBeGreaterThanOrEqual(0) }, { timeout: 5_000 })
    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).messages.map(message => message.authorName)).toEqual(['lead'])
    }, { timeout: 5_000 })
    expect(member.member.name).toBe('alice')
  })

  it('does not attribute a provider-owned subagent to the room', async () => {
    const { ctx, lead } = await setup(acks(4))
    const frames: RoomStreamFrame[] = []
    ctx.on('room/stream', (payload) => { frames.push(payload) })
    const run = await ctx.subagents.start('spawn', {
      parent: lead,
      prompt: content('provider-owned child'),
      signal: SIGNAL,
    })
    await run.result
    expect(run.localAgent).toBeDefined()
    expect(ctx.agentTeams.tryMembership(run.localAgent!)).toBeUndefined()
    expect(frames.filter(frame => frame.participantId === run.localAgent!.id)).toEqual([])
  })

  it('prompts a participant before anyone has spoken', async () => {
    const { ctx, lead } = await setup([HANGING, ...acks(2)])
    await addLiveParticipant(ctx, lead, 'alice')
    expect(ctx.agentTeams.roomView(lead).messages).toEqual([])
    const sent = await ctx.agentTeams.roomPrompt(lead, {
      target: 'alice',
      instruction: content('open the conversation'),
      signal: SIGNAL,
    })
    expect(sent.messageId).toMatch(/^team-message-/)
    expect(ctx.agentTeams.roomView(lead).messages).toEqual([])
  })

  it('refuses a prompt for a name that is not a participant', async () => {
    const { ctx, lead } = await setup(acks(1))
    await expect(ctx.agentTeams.roomPrompt(lead, {
      target: 'nobody',
      instruction: content('hello'),
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  })

  it('rejects room limits that are not positive safe integers or a usable ratio', async () => {
    for (const config of [
      { roomTranscriptWindow: 0 },
      { roomMaxProposalRevisions: 1.5 },
      { roomReviewGraceMs: 0 },
      { roomReviewReminders: -1 },
      { roomApprovalRatio: 0 },
      { roomApprovalRatio: 1.5 },
      { roomApprovalRatio: Number.NaN },
    ]) {
      // Direct construction reaches the deployment validation that schemastery already screens.
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentService)
      expect(() => new TeamService(ctx, config)).toThrow(TeamError)
    }
  })


  it('seats participants on different models in one room', async () => {
    const { ctx, lead } = await setup([HANGING, HANGING])
    const alice = await ctx.agentTeams.spawnTeammate(lead, {
      ...spawnOptions('alice'),
      agentOptions: { provider: 'mock', model: 'mock-flash' },
    })
    const bob = await ctx.agentTeams.spawnTeammate(lead, {
      ...spawnOptions('bob'),
      agentOptions: { provider: 'mock', model: 'mock-pro' },
    })
    await vi.waitFor(() => {
      expect(ctx.agents.get(alice.member.id)?.options.model).toBe('mock-flash')
      expect(ctx.agents.get(bob.member.id)?.options.model).toBe('mock-pro')
    }, { timeout: 5_000 })
    cleanups.push(() => { ctx.agents.get(alice.member.id)?.cancel({ kind: 'parent' }) })
    cleanups.push(() => { ctx.agents.get(bob.member.id)?.cancel({ kind: 'parent' }) })

    // The room view reports what each participant actually runs, so a deployment
    // can see that no two reviewers share one model's failure mode.
    const view = ctx.agentTeams.roomView(lead)
    expect(view.participants.map(participant => participant.model)).toEqual(['mock', 'mock-flash', 'mock-pro'])
  })


  it('keeps each participant on its recorded route after the child stops', async () => {
    const { ctx, lead } = await setup([HANGING, HANGING])
    const alice = await ctx.agentTeams.spawnTeammate(lead, {
      ...spawnOptions('alice'),
      agentOptions: { provider: 'mock', model: 'mock-flash' },
    })
    const bob = await ctx.agentTeams.spawnTeammate(lead, {
      ...spawnOptions('bob'),
      agentOptions: { provider: 'mock', model: 'mock-pro' },
    })
    await vi.waitFor(() => { expect(ctx.agents.get(bob.member.id)).toBeDefined() }, { timeout: 5_000 })
    ctx.agents.get(alice.member.id)?.cancel({ kind: 'parent' })
    ctx.agents.get(bob.member.id)?.cancel({ kind: 'parent' })

    // A reviewer between turns holds no live Agent, and the board must still
    // name the model a deployment seated it on.
    const reviewers = () => ctx.agentTeams.roomView(lead).participants
      .filter(participant => participant.name !== 'lead')
    await vi.waitFor(() => {
      expect(reviewers().map(participant => [participant.name, participant.status])).toEqual([
        ['alice', 'inactive'],
        ['bob', 'inactive'],
      ])
    }, { timeout: 5_000 })
    expect(reviewers().map(participant => participant.model)).toEqual(['mock-flash', 'mock-pro'])
  })


  it('renders the browser room view with transcript entries as text', async () => {
    const { ctx, lead } = await setup(acks(6))
    await addParticipant(ctx, lead, 'alice', 'ack')
    await ctx.agentTeams.roomPropose(lead, { statement: 'a decision for the panel', signal: SIGNAL })

    const view = ctx.agentTeams.remoteRoom(lead)
    // The Remote boundary carries text, not content blocks, because the panel
    // only ever renders text.
    expect(view.messages.some(message => message.author === 'alice' && message.text === 'ack')).toBe(true)
    expect(view.messages.every(message => typeof message.text === 'string')).toBe(true)
    expect(Object.keys(view.messages[0]!)).toEqual(['author', 'text'])
    expect(view.participants.map(participant => participant.name)).toContain('alice')
    expect(view.proposals).toEqual([expect.objectContaining({ statement: 'a decision for the panel' })])
    expect(view.participants.map(participant => participant.name)).toContain(view.chair)
  })


  it('serves each participant from its own provider adapter', async () => {
    const { ctx, lead, adapter } = await setup(acks(2))
    const alt = new MockAdapter(acks(2))
    ctx.llm.registerAdapter(['mock-alt'], alt)

    // A different provider route, not just a different model id on one route:
    // this is the mechanism a multi-vendor room rests on.
    await ctx.agentTeams.spawnTeammate(lead, {
      ...spawnOptions('alice'),
      agentOptions: { provider: 'mock-alt', model: 'alt-model' },
    })

    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).messages.some(message => message.authorName === 'alice')).toBe(true)
    }, { timeout: 5_000 })
    expect(alt.requests.length).toBeGreaterThan(0)
    expect(alt.requests.every(request => request.model === 'alt-model')).toBe(true)
    expect(alt.requests.every(request => request.provider === 'mock-alt')).toBe(true)
    // The Lead's own adapter never served the teammate's turn.
    expect(adapter.requests.some(request => request.model === 'alt-model')).toBe(false)
  })


  it('reminds a silent reviewer, then hands the decision to the human', async () => {
    const { ctx, lead } = await setup([HANGING, ...acks(8)], {
      roomReviewGraceMs: 30,
      roomReviewReminders: 1,
    })
    await addLiveParticipant(ctx, lead, 'alice')
    await ctx.agentTeams.roomPropose(lead, { statement: 'a decision nobody answers', signal: SIGNAL })

    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).proposals[0]?.phase).toBe('escalated')
    }, { timeout: 5_000 })

    const view = ctx.agentTeams.roomView(lead).proposals[0]!
    // The room never invents a standing: it names who went quiet and stops.
    expect(view.stalled).toEqual(['alice'])
    expect(view.awaiting).toEqual([])
    expect(view.approvals).toEqual([])
    expect(view.rejections).toEqual([])

    const timeouts = lead.session.snapshotEvents()
      .flatMap(event => event.type === 'room/review-timeout' ? [event.data.timeout] : [])
    expect(timeouts.map(timeout => timeout.kind)).toEqual(['reminder', 'escalated'])
    expect(timeouts.every(timeout => timeout.stalled.length === 1)).toBe(true)
  })

  it('keeps a decision open while a slower reviewer still has its window', async () => {
    const config = { roomReviewGraceMs: 300, roomReviewReminders: 0 }
    const { ctx, lead } = await setup([HANGING, ...acks(6)], config)
    const alice = await addLiveParticipant(ctx, lead, 'alice')
    await addParticipant(ctx, lead, 'bob', 'ack')
    const opened = await ctx.agentTeams.roomPropose(ctx.agents.get(alice)!, {
      statement: 'bob needs longer', signal: SIGNAL,
    })

    // The Lead answers its own ask promptly, and that answer is its last work.
    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).messages.at(-1)?.authorName).toBe('lead')
    }, { timeout: 5_000 })
    // Bob works just before the Lead's window closes, so Bob's window outlasts
    // it: the room must wait for Bob rather than escalate on the Lead's deadline.
    await new Promise(resolve => setTimeout(resolve, config.roomReviewGraceMs - 50))
    const spoken = ctx.agentTeams.roomView(lead).messages.length
    await ctx.agentTeams.roomPrompt(lead, { target: 'bob', instruction: content('take your time'), signal: SIGNAL })
    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).messages.length).toBeGreaterThan(spoken)
    }, { timeout: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(ctx.agentTeams.roomView(lead).proposals
      .find(proposal => proposal.id === opened.id)?.phase).toBe('open')

    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).proposals
        .find(proposal => proposal.id === opened.id)?.phase).toBe('escalated')
    }, { timeout: 5_000 })
  })

  it('never escalates a decision its reviewers settle', async () => {
    const { ctx, lead, alice, bob } = await room()
    const opened = await ctx.agentTeams.roomPropose(lead, { statement: 'answered promptly', signal: SIGNAL })
    await ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: opened.id, proposalRevision: 1, verdict: 'approve', reason: 'sound', signal: SIGNAL,
    })
    const settled = await ctx.agentTeams.roomReview(ctx.agents.get(bob)!, {
      proposalId: opened.id, proposalRevision: 1, verdict: 'approve', reason: 'agreed', signal: SIGNAL,
    })
    expect(settled).toMatchObject({ phase: 'accepted' })
    expect(lead.session.snapshotEvents().some(event => event.type === 'room/review-timeout')).toBe(false)
  })

  it('refuses a review deadline no timer can serve', async () => {
    const { ctx, lead } = await setup([HANGING, ...acks(4)], { roomReviewGraceMs: 30 }, false)
    await addLiveParticipant(ctx, lead, 'alice')
    await expect(ctx.agentTeams.roomPropose(lead, { statement: 'no timer here', signal: SIGNAL }))
      .rejects.toMatchObject({ code: 'TEAM_TIMER_REQUIRED' })
  })


  it('re-arms review deadlines for decisions that outlive the process', async () => {
    const config = { roomReviewGraceMs: 40, roomReviewReminders: 0 }
    const { ctx, lead, fiber } = await setup([HANGING, HANGING, ...acks(4)], config)
    const alice = await addLiveParticipant(ctx, lead, 'alice')
    // One settled and one open decision, so recovery walks both.
    const settled = await ctx.agentTeams.roomPropose(lead, { statement: 'already decided', signal: SIGNAL })
    await ctx.agentTeams.roomReview(ctx.agents.get(alice)!, {
      proposalId: settled.id, proposalRevision: 1, verdict: 'reject', reason: 'no', signal: SIGNAL,
    })
    const open = await ctx.agentTeams.roomPropose(lead, { statement: 'still waiting', signal: SIGNAL })

    // Stall checks live in memory, so a new process must rebuild them durably.
    await fiber.dispose()
    await ctx.plugin(TeamService, { roomEnabled: true, ...config })

    await vi.waitFor(() => {
      const revived = ctx.agentTeams.roomView(lead).proposals.find(proposal => proposal.id === open.id)
      expect(revived?.phase).toBe('escalated')
      expect(revived?.stalled).toEqual(['alice'])
    }, { timeout: 5_000 })
  })

  it('keeps the same-numbered decisions of two Leads on their own deadlines', async () => {
    const { ctx, lead } = await setup([HANGING, HANGING, ...acks(4)], {
      roomReviewGraceMs: 40,
      roomReviewReminders: 0,
    })
    const other = await ctx.agentLoop.create(SessionId('other-lead'), { provider: 'mock', model: 'mock' })
    await addLiveParticipant(ctx, lead, 'alice')
    await addLiveParticipant(ctx, other, 'bob')
    const first = await ctx.agentTeams.roomPropose(lead, { statement: 'first room', signal: SIGNAL })
    const second = await ctx.agentTeams.roomPropose(other, { statement: 'second room', signal: SIGNAL })
    // Each Team numbers its own decisions, so both rooms open the same id.
    expect(second.id).toBe(first.id)

    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).proposals[0]).toMatchObject({ phase: 'escalated', stalled: ['alice'] })
      expect(ctx.agentTeams.roomView(other).proposals[0]).toMatchObject({ phase: 'escalated', stalled: ['bob'] })
    }, { timeout: 5_000 })
  })


  it('never reminds the Lead, whose silence is the human\'s to resolve', async () => {
    // Both the participant and the Lead's own answer hang, so the Lead is the
    // only silent reviewer left when the deadline passes.
    const { ctx, lead } = await setup([HANGING, HANGING], {
      roomReviewGraceMs: 40,
      roomReviewReminders: 1,
    })
    const alice = await addLiveParticipant(ctx, lead, 'alice')
    await ctx.agentTeams.roomPropose(ctx.agents.get(alice)!, { statement: 'nobody answers', signal: SIGNAL })

    await vi.waitFor(() => {
      expect(ctx.agentTeams.roomView(lead).proposals[0]?.phase).toBe('escalated')
    }, { timeout: 5_000 })
    // Skipping the Lead's reminder is what lets the sweep reach the escalation:
    // a peer message from the Lead to itself is not a delivery.
    const timeouts = lead.session.snapshotEvents()
      .flatMap(event => event.type === 'room/review-timeout' ? [event.data.timeout] : [])
    expect(timeouts.map(timeout => timeout.kind)).toEqual(['reminder', 'escalated'])
    expect(timeouts.every(timeout => timeout.stalled.includes(lead.id))).toBe(true)
    expect(ctx.agentTeams.roomView(lead).proposals[0]?.stalled).toEqual(['lead'])
  })

  it('rotates the chair with the transcript and keeps it free of decision authority', async () => {
    const { ctx, lead } = await setup(acks(8))
    await addParticipant(ctx, lead, 'alice', 'ack')
    await addParticipant(ctx, lead, 'bob', 'ack')
    const seen = ctx.agentTeams.roomView(lead)
    expect(seen.chair).toBe(seen.participants[seen.messages.length % seen.participants.length]!.name)
    expect(['lead', 'alice', 'bob']).toContain(seen.chair)
  })
})
