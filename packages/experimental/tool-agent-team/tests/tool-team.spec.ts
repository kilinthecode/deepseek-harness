import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ReasoningEffortId, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'

function serializeRequest(request: GenerateOptions) {
  const connection = resolveAdapterOptions({ models: [{ id: request.model, systemPromptUpdate: 'in-history' }] })
  return serialize(request, connection, request.messages, new Map(), () => undefined)
}

const SIGNAL = new AbortController().signal
const TOOL_NAMES = [
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
].sort()

const roots: string[] = []
const contexts = new Set<Context>()
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
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  legacyControl = false,
  reasoning?: ConstructorParameters<typeof MockAdapter>[1],
  teamConfig: ConstructorParameters<typeof TeamService>[1] = {},
) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  if (legacyControl) await ctx.plugin(ToolSubagentControl)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService, teamConfig)
  const fiber = await ctx.plugin(toolTeam)
  const adapter = new MockAdapter(script, reasoning)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('tool-team-lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, fiber, adapter }
}

function execute(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: unknown,
  signal: AbortSignal = SIGNAL,
) {
  return ctx.tools.execute({
    callId: ToolCallId(`team-call-${++callNumber}`),
    name,
    arguments: args,
    signal,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function spawnedChildId(ctx: Context, lead: Agent, result: Awaited<ReturnType<typeof execute>>): SessionId {
  const parsed = JSON.parse(text(result)) as { member: { target: string } }
  const member = ctx.agentTeams.listMembers(lead).find(member => member.name === parsed.member.target)
  if (member === undefined) throw new Error('spawn_teammate target has no roster member')
  return member.id
}

async function assembly(ctx: Context, agent: Agent) {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return ctx.systemPrompt.assemble({ scope })
}

async function runTurn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const child = ctx.agents.get(id)
    expect(child?.status).toBe('running')
    return child!
  }, { timeout: 5_000 })
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

describe('dsh-tool-team', () => {
  it.each(['running', 'inactive', 'provisioning', 'failed'] as const)(
    'projects %s members consistently in creation, listing, and schemas', async (status) => {
      const { ctx, lead } = await setup([])
      const member = {
        id: SessionId('private-member-session'), name: 'reviewer', role: 'teammate' as const,
        status, description: 'review changes', diagnostics: [],
      }
      vi.spyOn(ctx.agentTeams, 'spawnTeammate').mockResolvedValue({ member })
      vi.spyOn(ctx.agentTeams, 'listMembers').mockReturnValue([member])
      const expected = {
        target: 'reviewer', role: 'teammate', status,
        description: 'review changes', diagnostics: [],
      }
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'reviewer', description: 'review changes', prompt: 'review',
      })
      const listed = await execute(ctx, lead, 'list_agents', {})
      expect(spawned.isError).toBe(false)
      expect(listed.isError).toBe(false)
      expect(JSON.parse(text(spawned))).toEqual({ member: expected })
      expect(JSON.parse(text(listed))).toEqual([expected])
      const scope = scopeOf(lead.ctx)
      const spawnSchema = ctx.tools.get('spawn_teammate', scope)?.output.schema.properties?.member
      const listSchema = ctx.tools.get('list_agents', scope)?.output.schema.items
      for (const schema of [spawnSchema, listSchema]) {
        expect(schema?.properties).toHaveProperty('target')
        expect(schema?.properties).not.toHaveProperty('id')
        expect(schema?.properties).not.toHaveProperty('name')
        expect(schema?.properties?.status?.enum).toEqual(['running', 'inactive', 'provisioning', 'failed'])
      }
      expect(ctx.agentTeams.listMembers(lead)).toEqual([member])
    },
  )

  it.each(['running', 'inactive'] as const)('returns interrupted %s status', async (previousStatus) => {
    const { ctx, lead } = await setup([])
    const interrupt = vi.spyOn(ctx.agentTeams, 'interrupt').mockReturnValue({ previousStatus })
    const result = await execute(ctx, lead, 'interrupt_agent', { target: 'reviewer' })
    expect(JSON.parse(text(result))).toEqual({ previousStatus })
    expect(interrupt).toHaveBeenCalledWith(lead, 'reviewer')
  })

  it('uses returned targets for messages, interruption, and task assignment', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review changes', prompt: 'wait for work',
    })
    const { member } = JSON.parse(text(spawned)) as { member: { target: string } }
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)
    expect(member).not.toHaveProperty('id')
    expect(member).not.toHaveProperty('name')
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{ target: string }>
    expect(listed.map(row => row.target)).toEqual(['lead', member.target])
    const created = await execute(ctx, lead, 'team_task_create', { subject: 'review', description: 'review changes' })
    const task = JSON.parse(text(created)) as { id: string; revision: number }
    const assigned = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id, expected_revision: task.revision, action: 'reassign', owner: member.target,
    })
    expect(assigned.isError).toBe(false)
    expect(JSON.parse(text(assigned))).toMatchObject({ ownerName: member.target })
    const tasks = await execute(ctx, lead, 'team_task_list', { owner: listed[1]!.target })
    expect(JSON.parse(text(tasks))).toMatchObject({ tasks: [{ id: task.id, ownerName: member.target }] })
    const sent = await execute(ctx, lead, 'send_message', { target: member.target, message: 'review the diff' })
    expect(sent.isError).toBe(false)
    const interrupted = await execute(ctx, lead, 'interrupt_agent', { target: listed[1]!.target })
    expect(interrupted.isError).toBe(false)
    await child.whenIdle()
    expect(child.status).toBe('idle')
    expect(ctx.agentTeams.interrupt(lead, member.target)).toEqual({ previousStatus: 'inactive' })
    const stored = await execute(ctx, lead, 'list_agents', {})
    expect(JSON.parse(text(stored))).toContainEqual(expect.objectContaining({ target: member.target, status: 'inactive' }))
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ id: childId, name: member.target, status: 'inactive' })
  })

  it('installs the complete scoped schema and shared-checkout policy for roots and teammates', async () => {
    const { ctx, lead } = await setup(['hang'])
    const leadAssembly = await assembly(ctx, lead)
    expect(leadAssembly.tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    const leadPrompt = renderPrompt(leadAssembly)
    expect(leadPrompt).toContain('create teammates only when the user explicitly asks')
    expect(leadPrompt).toContain('FS_STALE_VERSION')
    expect(leadPrompt).toContain('Bash, formatters, code generators, and scripts are not fully protected')
    expect(leadPrompt).toContain('Task readiness never starts an owner')
    expect(leadPrompt).toContain('returns noProgress immediately')
    expect(leadPrompt).not.toContain('Your Team role')
    expect(renderContextSnapshot(leadAssembly)).toBe('')

    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'tool-worker',
      description: 'exercise scoped tools',
      prompt: 'stay available',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)
    const childAssembly = await assembly(ctx, child)
    expect(childAssembly.tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    expect(renderPrompt(childAssembly)).toBe(leadPrompt)
    expect(renderContextSnapshot(childAssembly)).not.toContain('team:identity')
    expect(child.session.deriveMessages().some(message => message.content.some(block =>
      block.type === 'text' && block.text === '<system-reminder>\nYou are teammate "tool-worker".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n'))).toBe(true)
    const initialPrompt = child.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    expect(initialPrompt?.type === 'user/message'
      ? initialPrompt.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : []).toEqual(['<system-reminder>\nYou are teammate "tool-worker".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n', 'stay available'])

    const denied = await execute(ctx, child, 'spawn_teammate', {
      name: 'nested', description: 'not allowed', prompt: 'no',
    })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('only the Team Lead')
    await execute(ctx, lead, 'interrupt_agent', { target: 'tool-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it.each([
    ['fresh', undefined], ['fork', undefined], ['fork', 'in-history'],
  ] as const)('records %s teammate identity with update mode %s and keeps the wire prefix', async (mode, systemPromptUpdate) => {
    const { ctx, lead, adapter } = await setup([textResponse('parent answer'), textResponse('child answer')])
    if (systemPromptUpdate !== undefined) adapter.systemPromptUpdate = systemPromptUpdate
    await runTurn(lead, 'Parent task')
    const parentRequest = serializeRequest(adapter.requests[0]!)
    const parentHistory = structuredClone(lead.session.deriveMessages())
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work', context: mode,
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, childId)
    const childRequest = serializeRequest(adapter.requests[1]!)
    expect(childRequest.tools).toEqual(parentRequest.tools)
    expect(childRequest.system).toEqual(parentRequest.system)
    expect(childRequest.system).not.toContain('Your Team role')
    if (mode === 'fork') {
      expect(childRequest.messages.slice(0, parentRequest.messages.length)).toEqual(parentRequest.messages)
      expect(adapter.requests[1]!.messages.slice(0, parentHistory.length)).toEqual(parentHistory)
    } else {
      expect(JSON.stringify(childRequest.messages)).not.toContain('Parent task')
    }
    expect(childRequest.messages.at(-1)?.content.slice(0, 2)).toEqual([
      { type: 'text', text: '<system-reminder>\nYou are teammate "reviewer".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n' },
      { type: 'text', text: 'Review the work' },
    ])
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    const initial = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(initial?.type === 'user/message' ? initial.data.content : []).toEqual([
      { type: 'text', text: '<system-reminder>\nYou are teammate "reviewer".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n' },
      { type: 'text', text: 'Review the work' },
    ])
  })

  it('keeps an ordinary Lead fork free of identity reminders without replacing the inherited prefix', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('parent answer'), textResponse('fork answer')])
    await runTurn(lead, 'Parent task')
    const seed = lead.session.snapshotEvents()
    const childId = SessionId('ordinary-team-fork')
    const handle = await ctx.agents.create({
      sessionId: childId,
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: lead.id, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: SIGNAL,
    })
    await runTurn(handle.agent, 'Continue independently')
    const parentRequest = serializeRequest(adapter.requests[0]!)
    const childRequest = serializeRequest(adapter.requests[1]!)
    expect(childRequest.tools).toEqual(parentRequest.tools)
    expect(childRequest.messages.slice(0, parentRequest.messages.length)).toEqual(parentRequest.messages)
    expect(childRequest.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'Continue independently' })
    expect(JSON.stringify(childRequest.messages)).not.toContain('system-reminder')
    expect(handle.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    expect(ctx.agentTeams.listMembers(handle.agent).map(member => member.name)).toEqual(['lead'])
    await handle.dispose()
  })

  it.each([undefined, 'in-history'] as const)('keeps a teammate fork prefix with update mode %s without a Lead correction', async (systemPromptUpdate) => {
    const { ctx, lead, adapter } = await setup([textResponse('review done'), textResponse('lead notified'), textResponse('fork answer')])
    if (systemPromptUpdate !== undefined) adapter.systemPromptUpdate = systemPromptUpdate
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    const teammateId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, teammateId)
    await using persisted = await ctx.sessionPersistence.open(teammateId, 'read')
    const { events: seed } = await persisted.read()
    const handle = await ctx.agents.create({
      sessionId: SessionId('fork-from-teammate'),
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: teammateId, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: SIGNAL,
    })
    try {
      const inheritedHistory = structuredClone(handle.agent.session.deriveMessages())
      await runTurn(handle.agent, 'Continue independently')
      const original = serializeRequest(adapter.requests.find(request => request.sessionId === teammateId)!)
      const forkRequest = adapter.requests.find(request => request.sessionId === handle.agent.id)!
      const fork = serializeRequest(forkRequest)
      expect(fork.tools).toEqual(original.tools)
      expect(fork.messages.slice(0, original.messages.length)).toEqual(original.messages)
      expect(forkRequest.messages.slice(0, inheritedHistory.length)).toEqual(inheritedHistory)
      expect(fork.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'Continue independently' })
      expect(JSON.stringify(fork.messages)).not.toContain('You are the Team Lead')
      expect(handle.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    } finally {
      await handle.dispose()
    }
  })

  it('leaves initial identity to ordinary history compaction without reinserting it', async () => {
    const { ctx, lead, adapter } = await setup([
      toolCallResponse('first-list', 'list_agents', {}),
      toolCallResponse('second-list', 'list_agents', {}),
      textResponse('done'),
    ])
    ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      if (step === 3) {
        const identity = agent.session.snapshotEvents().find(event => event.type === 'user/message'
          && event.data.source.kind === 'user')
        if (identity === undefined) throw new Error('expected initial teammate reminder')
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'Compacted earlier context.' }],
          source: { kind: 'test-compaction' },
        }), {
          surfaceOp: { op: 'replace', startSeq: identity.seq, endSeq: identity.seq },
          sourceEventSeqs: [identity.seq],
        })
      }
      return next()
    })
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, childId)
    const reminder = '<system-reminder>\nYou are teammate "reviewer".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n'
    const first = serializeRequest(adapter.requests[0]!).messages
    expect(first.at(-1)?.content.slice(0, 2)).toEqual([{ type: 'text', text: reminder }, { type: 'text', text: 'Review the work' }])
    expect(adapter.requests[1]!.messages.filter(message => message.content.some(block =>
      block.type === 'text' && block.text === reminder))).toHaveLength(1)
    expect(JSON.stringify(serializeRequest(adapter.requests[2]!).messages)).not.toContain('You are teammate')
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    expect(events.filter(event => event.type === 'user/message'
      && (event.data.source as { readonly kind?: unknown }).kind === toolTeam.name)).toHaveLength(0)
  })

  it.each(['reject', 'empty', 'abort'] as const)('does not revive a teammate step after %s', async (mode) => {
    const { ctx, lead, adapter } = await setup([])
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (agent === lead) return decision
      if (mode === 'reject') return { kind: 'reject' }
      if (mode === 'abort') agent.cancel({ kind: 'user' })
      return { kind: 'enter', messages: [] }
    })
    await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    const childId = SessionId(ctx.agentTeams.listMembers(lead).find(member => member.name === 'reviewer')!.id)
    await waitNoAgent(ctx, childId)
    expect(adapter.requests.filter(request => request.sessionId === childId)).toEqual([])
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user')).toEqual([])
  })

  it('keeps teammate reminders when runtime context is suppressed', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('worker done')])
    ctx.systemPrompt.suppressRuntimeContext()
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    await waitNoAgent(ctx, spawnedChildId(ctx, lead, spawned))
    expect(serializeRequest(adapter.requests[0]!).messages.at(-1)?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nYou are teammate "reviewer".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n' },
      { type: 'text', text: 'Review the work' },
    ])
  })

  it('returns actionable no-progress output and renders structured wait cancellation', async () => {
    const inactiveSetup = await setup([textResponse('worker done')])
    const inactiveSpawn = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'spawn_teammate', {
      name: 'inactive-worker', description: 'finish immediately', prompt: 'finish',
    })
    const inactiveId = spawnedChildId(inactiveSetup.ctx, inactiveSetup.lead, inactiveSpawn)
    await waitNoAgent(inactiveSetup.ctx, inactiveId)
    const noProgress = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'wait_agent', { timeout_ms: 3_600_000 })
    expect(noProgress.isError).toBe(false)
    expect(JSON.parse(text(noProgress))).toEqual({
      timedOut: false,
      noProgress: {
        reason: 'no-active-peer',
        message: 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.',
      },
    })
    for (const timeout_ms of [9_999, 3_600_001, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'wait_agent', { timeout_ms })
      expect(invalid.isError).toBe(true)
      expect(text(invalid)).toContain('timeoutMs must be an integer from 10000 through 3600000')
    }

    const activeSetup = await setup(['hang'])
    const activeSpawn = await execute(activeSetup.ctx, activeSetup.lead, 'spawn_teammate', {
      name: 'active-worker', description: 'stay active', prompt: 'wait',
    })
    const activeId = spawnedChildId(activeSetup.ctx, activeSetup.lead, activeSpawn)
    await waitRunning(activeSetup.ctx, activeId)
    const controller = new AbortController()
    const waiting = execute(activeSetup.ctx, activeSetup.lead, 'wait_agent', { timeout_ms: 10_000 }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort({ kind: 'user' })
    const aborted = await waiting
    expect(aborted.isError).toBe(true)
    expect(text(aborted)).toBe("Error: wait_agent aborted: { kind: 'user' }")
    await execute(activeSetup.ctx, activeSetup.lead, 'interrupt_agent', { target: 'active-worker' })
    await waitNoAgent(activeSetup.ctx, activeId)
  })

  it('adapts roster, mailbox, wait, and task CAS operations to canonical JSON', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('lead received wakeup')])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'json-worker', description: 'json worker', prompt: 'wait', context: 'fresh',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)

    const roster = await execute(ctx, child, 'list_agents', {})
    expect(JSON.parse(text(roster))).toMatchObject([
      { target: 'lead', role: 'lead' },
      { target: 'json-worker', role: 'teammate' },
    ])
    // Every Team result reaches the model as compact JSON: indentation would
    // spend tokens on every roster, task, and receipt without adding meaning.
    expect(text(roster)).toBe(JSON.stringify(JSON.parse(text(roster))))
    const peer = await execute(ctx, child, 'send_message', { target: 'lead', message: 'progress report' })
    expect(peer.isError).toBe(false)
    expect(JSON.parse(text(peer))).toMatchObject({ status: 'accepted' })
    const followup = await execute(ctx, child, 'send_message', { target: 'lead', message: 'review the report' })
    expect(followup.isError).toBe(false)
    expect(JSON.parse(text(followup))).toMatchObject({ status: 'accepted' })
    await lead.whenIdle()

    const created = await execute(ctx, lead, 'team_task_create', {
      subject: 'tool task',
      description: 'created through tool',
      blocked_by: [],
      write_scopes: ['src/team'],
    })
    const task = JSON.parse(text(created)) as { id: string; revision: number }
    const listed = await execute(ctx, child, 'team_task_list', { ready: true, limit: 1 })
    expect(JSON.parse(text(listed))).toMatchObject({ tasks: [{ id: task.id, ready: true }] })
    const read = await execute(ctx, child, 'team_task_get', { task_id: task.id })
    expect(JSON.parse(text(read))).toMatchObject({ id: task.id, revision: 1 })
    const claimed = await execute(ctx, child, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'claim',
    })
    expect(JSON.parse(text(claimed))).toMatchObject({ status: 'in_progress', ownerName: 'json-worker' })
    const stale = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'delete',
    })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toContain('stale team task')

    const wait = execute(ctx, lead, 'wait_agent', { timeout_ms: 10_000 })
    const completedCall = new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      setTimeout(() => {
        void execute(ctx, child, 'team_task_update', {
          task_id: task.id,
          expected_revision: 2,
          action: 'submit',
        }).then(resolve, reject)
      }, 0)
    })
    await expect(wait).resolves.toMatchObject({ isError: false })
    expect((await completedCall).isError).toBe(false)

    const childInterrupt = await execute(ctx, child, 'interrupt_agent', { target: 'json-worker' })
    expect(childInterrupt.isError).toBe(true)
    await execute(ctx, lead, 'interrupt_agent', { target: 'json-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('records a peer verdict and its reason on submitted work', async () => {
    const { ctx, lead } = await setup(['hang', 'hang', 'hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'verified-worker', description: 'verified worker', prompt: 'wait', context: 'fresh',
    })
    const child = await waitRunning(ctx, spawnedChildId(ctx, lead, spawned))
    const created = JSON.parse(text(await execute(ctx, lead, 'team_task_create', {
      subject: 'verified task', description: 'needs a peer verdict',
    }))) as { id: string; revision: number }
    const claimed = JSON.parse(text(await execute(ctx, child, 'team_task_update', {
      task_id: created.id, expected_revision: created.revision, action: 'claim',
    }))) as { revision: number }
    const submitted = JSON.parse(text(await execute(ctx, child, 'team_task_update', {
      task_id: created.id, expected_revision: claimed.revision, action: 'submit',
    }))) as { revision: number; status: string }
    expect(submitted.status).toBe('verifying')
    // The Lead finds work awaiting a verdict by the status the view reports.
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', { status: 'verifying' }))))
      .toMatchObject({ tasks: [{ id: created.id, status: 'verifying' }] })

    // Only another member's verdict, with its reason, completes submitted work.
    const verified = await execute(ctx, lead, 'team_task_update', {
      task_id: created.id,
      expected_revision: submitted.revision,
      action: 'verify',
      verdict: 'approved',
      reason: 'checked the delivered work',
    })
    expect(verified.isError).toBe(false)
    expect(JSON.parse(text(verified))).toMatchObject({
      status: 'completed',
      verification: { verifierName: 'lead', verdict: 'approved', reason: 'checked the delivered work' },
    })
  })

  it('adapts optional task filters, mutations, pagination, and default waiting', async () => {
    const { ctx, lead } = await setup(['hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'fork-worker', description: 'fork worker', prompt: 'stay active', context: 'fork',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitRunning(ctx, childId)

    const firstResult = await execute(ctx, lead, 'team_task_create', {
      subject: 'first', description: 'first task',
    })
    const secondResult = await execute(ctx, lead, 'team_task_create', {
      subject: 'second', description: 'second task',
    })
    const first = JSON.parse(text(firstResult)) as { id: string; revision: number }
    const second = JSON.parse(text(secondResult)) as { id: string; revision: number }
    const claimed = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id, expected_revision: first.revision, action: 'claim',
    })
    const claim = JSON.parse(text(claimed)) as { revision: number }

    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      status: 'in_progress', owner: 'lead', cursor: 0, limit: 1,
    })))).toMatchObject({ tasks: [{ id: first.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      owner: 'unowned', limit: 1,
    })))).toMatchObject({ tasks: [{ id: second.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      cursor: 0, limit: 1,
    })))).toMatchObject({ nextCursor: 1 })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      cursor: 1,
    })))).not.toHaveProperty('nextCursor')
    expect((await execute(ctx, lead, 'team_task_list', { cursor: -1 })).isError).toBe(true)
    expect((await execute(ctx, lead, 'team_task_list', { limit: 101 })).isError).toBe(true)

    const edited = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: claim.revision,
      action: 'edit',
      subject: 'edited',
      description: 'edited description',
      write_scopes: ['src/team'],
    })
    const edit = JSON.parse(text(edited)) as { revision: number }
    const dependencies = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: edit.revision,
      action: 'set_dependencies',
      blocked_by: [second.id],
    })
    expect(dependencies.isError).toBe(false)
    const dependency = JSON.parse(text(dependencies)) as { revision: number }
    expect((await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: dependency.revision,
      action: 'reassign',
      owner: 'fork-worker',
    })).isError).toBe(true)

    const wait = execute(ctx, lead, 'wait_agent', {})
    const wake = new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      setTimeout(() => {
        void execute(ctx, lead, 'team_task_create', {
          subject: 'wake', description: 'wake default wait',
        }).then(resolve, reject)
      }, 0)
    })
    expect((await wait).isError).toBe(false)
    expect((await wake).isError).toBe(false)

    await execute(ctx, lead, 'interrupt_agent', { target: 'fork-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('removes and reinstalls every scoped registration across plugin HMR without stopping the child', async () => {
    const { ctx, lead, fiber } = await setup(['hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'hmr-worker', description: 'hmr worker', prompt: 'wait',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)

    await fiber.dispose()
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).some(name => TOOL_NAMES.includes(name))).toBe(false)
    expect((await assembly(ctx, child)).tools.map(schema => schema.name).some(name => TOOL_NAMES.includes(name))).toBe(false)
    expect(ctx.agents.get(childId)).toBe(child)

    const replacement = await ctx.plugin(toolTeam)
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    expect((await assembly(ctx, child)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    await execute(ctx, lead, 'interrupt_agent', { target: 'hmr-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    await replacement.dispose()
  })

  it('shadows legacy global control names only inside Team member scopes', async () => {
    const { ctx, lead, fiber } = await setup([], true)
    const teamSchema = (await assembly(ctx, lead)).tools.find(schema => schema.name === 'send_message')
    expect(JSON.stringify(teamSchema)).toContain('target')
    expect(JSON.stringify(teamSchema)).not.toContain('subagent_id')

    await fiber.dispose()
    const legacySchema = (await assembly(ctx, lead)).tools.find(schema => schema.name === 'send_message')
    expect(JSON.stringify(legacySchema)).toContain('agent_id')
  })

  it('rolls back partial scoped installation after a same-scope collision', async () => {
    const { ctx, lead, fiber } = await setup([])
    await fiber.dispose()
    lead.ctx.tools.register(defineContentToolFixture({
      name: 'spawn_teammate',
      description: 'intentional collision',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'collision' }] },
    }))

    await expect(ctx.plugin(toolTeam)).rejects.toThrow(/already registered/u)
    const assembled = await assembly(ctx, lead)
    expect(assembled.tools.filter(schema => TOOL_NAMES.includes(schema.name)).map(schema => schema.name))
      .toEqual(['spawn_teammate'])
    expect(renderContextSnapshot(assembled)).not.toContain('Your Team role is lead')
  })

  it('resolves direct-apply defaults without Loader schema normalization', async () => {
    const { ctx, lead, fiber } = await setup([textResponse('ordinary child')])
    await fiber.dispose()
    toolTeam.apply(ctx, {})
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    const ordinary = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'ordinary child',
      request: { prompt: [{ type: 'text', text: 'finish' }], parent: lead },
      signal: SIGNAL,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(ordinary.childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('reinstalls Team scope before a cold-resumed teammate request', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('first'), textResponse('lead received settlement'), 'hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'cold-worker', description: 'cold worker', prompt: 'finish once',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    expect(await ctx.subagents.listChildren(lead.id)).toContainEqual(expect.objectContaining({
      id: childId,
      mode: 'continuable',
    }))
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === lead.id)).toHaveLength(1)
    })
    await lead.whenIdle()

    const receipt = await ctx.agentTeams.sendMessage(lead, {
      target: 'cold-worker',
      content: [{ type: 'text', text: 'resume with Team scope' }],
      signal: SIGNAL,
    })
    expect(receipt.status).toBe('accepted')
    const resumed = await waitRunning(ctx, childId)
    expect((await assembly(ctx, resumed)).tools.map(schema => schema.name)
      .filter(name => TOOL_NAMES.includes(name)).sort()).toEqual(TOOL_NAMES)
    expect(renderContextSnapshot(await assembly(ctx, resumed))).not.toContain('You are teammate')
    const childRequests = () => adapter.requests.filter(request => request.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('You are teammate "cold-worker".'))))
    await vi.waitFor(() => { expect(childRequests()).toHaveLength(2) })
    const firstMessages = childRequests()[0]!.messages
    expect(childRequests()[1]!.messages.slice(0, firstMessages.length)).toEqual(firstMessages)
    expect(resumed.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user')).toHaveLength(1)
    await execute(ctx, lead, 'interrupt_agent', { target: 'cold-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('fails safely without a calling Agent and has the function-plugin export shape', async () => {
    const { ctx } = await setup([])
    const result = await execute(ctx, undefined, 'list_agents', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown tool "list_agents"')
    expect('default' in toolTeam).toBe(false)
    expect(toolTeam.name).toBe('tool-agent-team')
    expect(toolTeam.inject).toEqual(['agents', 'agentTeams', 'tools', 'systemPrompt'])
  })


  it('routes each teammate to the model route the caller names', async () => {
    const { ctx, lead } = await setup(['hang', 'hang', 'hang'])
    const flash = await execute(ctx, lead, 'spawn_teammate', {
      name: 'flash-worker', description: 'flash worker', prompt: 'wait',
      provider: 'mock', model: 'mock-flash',
    })
    const pro = await execute(ctx, lead, 'spawn_teammate', {
      name: 'pro-worker', description: 'pro worker', prompt: 'wait',
      provider: 'mock', model: 'mock-pro',
    })
    expect(flash.isError).toBe(false)
    expect(pro.isError).toBe(false)
    const flashChild = await waitRunning(ctx, spawnedChildId(ctx, lead, flash))
    const proChild = await waitRunning(ctx, spawnedChildId(ctx, lead, pro))
    expect(flashChild.options).toMatchObject({ provider: 'mock', model: 'mock-flash' })
    expect(proChild.options).toMatchObject({ provider: 'mock', model: 'mock-pro' })
    // A teammate without a named route keeps inheriting the Lead's own.
    const inherited = await execute(ctx, lead, 'spawn_teammate', {
      name: 'inherited-worker', description: 'inherited worker', prompt: 'wait',
    })
    const inheritedChild = await waitRunning(ctx, spawnedChildId(ctx, lead, inherited))
    expect(inheritedChild.options).toMatchObject({ provider: 'mock', model: 'mock' })
    await execute(ctx, lead, 'interrupt_agent', { target: 'flash-worker' })
    await execute(ctx, lead, 'interrupt_agent', { target: 'pro-worker' })
    await execute(ctx, lead, 'interrupt_agent', { target: 'inherited-worker' })
  })


  it('refuses a route that does not declare the requested reasoning effort, before creating a child', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const refused = await execute(ctx, lead, 'spawn_teammate', {
      name: 'effort-worker', description: 'effort worker', prompt: 'wait',
      provider: 'mock', model: 'mock', reasoning_effort: 'high',
    })
    // Misconfiguration is named at the spawn rather than surfacing later as a
    // durability failure, and no child is created for it.
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('does not declare reasoning effort "high"')
    expect(ctx.agentTeams.listMembers(lead).some(member => member.name === 'effort-worker')).toBe(false)

    // The refused name is still free, so a corrected retry seats the teammate.
    const accepted = await execute(ctx, lead, 'spawn_teammate', {
      name: 'effort-worker', description: 'effort worker', prompt: 'wait',
      provider: 'mock', model: 'mock',
    })
    expect(accepted.isError).toBe(false)
    await execute(ctx, lead, 'interrupt_agent', { target: 'effort-worker' })
  })


  it('validates the requested reasoning effort against the route that declares it', async () => {
    const route = { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] }
    const { ctx, lead } = await setup(['hang', 'hang'], false, route)

    // The declared effort is accepted and seats the teammate.
    const accepted = await execute(ctx, lead, 'spawn_teammate', {
      name: 'low-worker', description: 'low worker', prompt: 'wait',
      provider: 'mock', model: 'mock', reasoning_effort: 'low',
    })
    expect(accepted.isError).toBe(false)
    await execute(ctx, lead, 'interrupt_agent', { target: 'low-worker' })

    // An undeclared one is refused, and the refusal names what the route declares.
    const refused = await execute(ctx, lead, 'spawn_teammate', {
      name: 'high-worker', description: 'high worker', prompt: 'wait',
      provider: 'mock', model: 'mock', reasoning_effort: 'high',
    })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('it declares "low"')
    expect(ctx.agentTeams.listMembers(lead).some(member => member.name === 'high-worker')).toBe(false)
  })

  it('refuses an effort the inherited route does not declare', async () => {
    // Naming only an effort still resolves against the caller's own route, so the
    // refusal arrives before any child exists rather than as a failed turn.
    const { ctx, lead } = await setup(['hang'])
    const result = await execute(ctx, lead, 'spawn_teammate', {
      name: 'inherit-worker', description: 'inherit worker', prompt: 'wait',
      reasoning_effort: 'low',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not declare reasoning effort "low"')
    expect(ctx.agentTeams.listMembers(lead).some(member => member.name === 'inherit-worker')).toBe(false)
  })

  it('uses configured fresh and fork provider names', async () => {
    const { ctx, lead, fiber } = await setup([textResponse('custom')])
    await fiber.dispose()
    await ctx.plugin(SubagentSpawn, { providerName: 'team-fresh' })
    await ctx.plugin(toolTeam, { freshProvider: 'team-fresh', forkProvider: 'fork' })
    const result = await execute(ctx, lead, 'spawn_teammate', {
      name: 'custom-provider', description: 'custom provider', prompt: 'go',
    })
    expect(result.isError).toBe(false)
    const childId = spawnedChildId(ctx, lead, result)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ provider: 'team-fresh' })
  })
})

describe('teammate duties and the /team command', () => {
  const IDENTITY = '<system-reminder>\nYou are teammate "{name}".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).'
  const PLANNER = 'You plan and verify; you cannot change files or run commands. Read the workspace, then write the plan with team_task_create: one task per independently verifiable change, with blocked_by for ordering and write_scopes for the files it will touch. Revise unclaimed tasks with team_task_update edit, set_dependencies, or delete. Message the Lead when the plan is ready. When a task awaits your verdict, check the work itself in the workspace, then record approved or rejected with a reason using team_task_update action "verify".'
  const EXECUTOR = 'You execute planned tasks. Take a ready, unowned task with team_task_update action "claim" at its current revision, implement it within its write_scopes, then hand it over with action "submit". Do not create or verify tasks; message the planner when the plan is missing work. After a rejection, rework the task and submit it again. Take the next ready task until none is left, then report to the Lead.'
  const SUBJECT_POLICY = 'The user started this Agent Team with the subject "Ship the parser". The Lead runs the plan-then-execute flow: spawn one teammate with duty "planner" to write the plan as shared tasks; when the planner reports the plan, spawn teammates with duty "executor" to claim ready tasks, implement them, and submit them; the planner verifies each submission. The Lead waits for the required teammates, then answers the user when every task is completed.'
  const GLOBAL_TOOLS = ['read', 'grep', 'glob', 'write', 'edit', 'bash', 'workflow']

  function identity(name: string, extra: readonly string[] = []): string {
    return `${[IDENTITY.replace('{name}', name), ...extra].join('\n')}\n</system-reminder>\n\n`
  }

  function registerGlobalTools(ctx: Context): void {
    for (const name of GLOBAL_TOOLS) {
      ctx.tools.register(defineContentToolFixture({
        name,
        description: `${name} fixture`,
        parameters: {},
        execute: () => Promise.resolve([{ type: 'text', text: name }]),
      }))
    }
  }

  /** Initial user text blocks recorded in one teammate Session. */
  function initialPrompt(child: Agent): string[] {
    const initial = child.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    return initial?.type === 'user/message'
      ? initial.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : []
  }

  async function inheritedTools(ctx: Context, agent: Agent): Promise<string[]> {
    return (await assembly(ctx, agent)).tools.map(schema => schema.name)
      .filter(name => GLOBAL_TOOLS.includes(name)).sort()
  }

  it('gives each dutied teammate its duty instructions and leaves plain teammates plain', async () => {
    const { ctx, lead } = await setup(['hang', 'hang', 'hang'])
    const plain = await execute(ctx, lead, 'spawn_teammate', { name: 'plain', description: 'plain', prompt: 'help' })
    await ctx.agentTeams.setSubject(lead, 'Ship the parser')
    const planner = await execute(ctx, lead, 'spawn_teammate', {
      name: 'planner', description: 'plan', prompt: 'plan it', duty: 'planner',
    })
    const executor = await execute(ctx, lead, 'spawn_teammate', {
      name: 'builder', description: 'build', prompt: 'build it', duty: 'executor',
    })
    expect(JSON.parse(text(planner))).toMatchObject({ member: { target: 'planner', role: 'teammate', duty: 'planner' } })
    expect((JSON.parse(text(plain)) as { member: object }).member).not.toHaveProperty('duty')

    const plainChild = await waitRunning(ctx, spawnedChildId(ctx, lead, plain))
    const plannerChild = await waitRunning(ctx, spawnedChildId(ctx, lead, planner))
    const executorChild = await waitRunning(ctx, spawnedChildId(ctx, lead, executor))
    // A teammate without a duty keeps the exact pre-duty reminder.
    expect(initialPrompt(plainChild)).toEqual([identity('plain'), 'help'])
    expect(initialPrompt(plannerChild)).toEqual([identity('planner', ['Your duty is "planner".', PLANNER]), 'plan it'])
    expect(initialPrompt(executorChild)).toEqual([identity('builder', ['Your duty is "executor".', EXECUTOR]), 'build it'])
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as { target: string; duty?: string }[]
    expect(listed.map(row => [row.target, row.duty])).toEqual([
      ['lead', undefined], ['plain', undefined], ['planner', 'planner'], ['builder', 'executor'],
    ])
  })

  it('keeps a planner to the read tools the Lead can see and refuses its writes at execution', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    registerGlobalTools(ctx)
    const planner = await execute(ctx, lead, 'spawn_teammate', {
      name: 'planner', description: 'plan', prompt: 'plan it', duty: 'planner',
    })
    const executor = await execute(ctx, lead, 'spawn_teammate', {
      name: 'builder', description: 'build', prompt: 'build it', duty: 'executor',
    })
    const plannerChild = await waitRunning(ctx, spawnedChildId(ctx, lead, planner))
    const executorChild = await waitRunning(ctx, spawnedChildId(ctx, lead, executor))

    // read_image, skill, and the web tools are absent from this composition,
    // so the default list narrows to what the Lead can see.
    expect(await inheritedTools(ctx, plannerChild)).toEqual(['glob', 'grep', 'read'])
    expect(await inheritedTools(ctx, executorChild)).toEqual([...GLOBAL_TOOLS].sort())
    expect((await assembly(ctx, plannerChild)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    const write = await execute(ctx, plannerChild, 'write', {})
    expect(write.isError).toBe(true)
    expect((await execute(ctx, executorChild, 'write', {})).isError).toBe(false)
    const descriptor = plannerChild.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')
    expect(descriptor?.data).toMatchObject({ toolFilter: { allow: ['read', 'grep', 'glob'] } })
  })

  it('applies configured duty instructions and tool lists, including an empty list', async () => {
    const { ctx, lead, fiber } = await setup(['hang', 'hang'])
    registerGlobalTools(ctx)
    await fiber.dispose()
    await ctx.plugin(toolTeam, {
      duties: { planner: { tools: [] }, executor: { instructions: 'Build only.', tools: ['bash', 'missing'] } },
    })
    const planner = await execute(ctx, lead, 'spawn_teammate', {
      name: 'planner', description: 'plan', prompt: 'plan it', duty: 'planner',
    })
    const executor = await execute(ctx, lead, 'spawn_teammate', {
      name: 'builder', description: 'build', prompt: 'build it', duty: 'executor',
    })
    const plannerChild = await waitRunning(ctx, spawnedChildId(ctx, lead, planner))
    const executorChild = await waitRunning(ctx, spawnedChildId(ctx, lead, executor))
    expect(await inheritedTools(ctx, plannerChild)).toEqual([])
    expect(await inheritedTools(ctx, executorChild)).toEqual(['bash'])
    expect(initialPrompt(plannerChild)[0]).toContain(PLANNER)
    expect(initialPrompt(executorChild)[0]).toBe(identity('builder', ['Your duty is "executor".', 'Build only.']))
  })

  it('adds the subject policy to every member\'s Team section once the Lead records a subject', async () => {
    const { ctx, lead } = await setup(['hang'])
    const plain = await execute(ctx, lead, 'spawn_teammate', { name: 'plain', description: 'plain', prompt: 'help' })
    const child = await waitRunning(ctx, spawnedChildId(ctx, lead, plain))
    const before = renderPrompt(await assembly(ctx, lead))
    expect(before).not.toContain('plan-then-execute')

    await ctx.agentTeams.setSubject(lead, 'Ship the parser')
    const leadPrompt = renderPrompt(await assembly(ctx, lead))
    expect(leadPrompt).toContain(SUBJECT_POLICY)
    expect(leadPrompt.startsWith(before.slice(0, before.indexOf('Agent Teams is available')))).toBe(true)
    // The section is uniform, so a teammate renders the Lead's prompt byte for byte.
    expect(renderPrompt(await assembly(ctx, child))).toBe(leadPrompt)
  })

  it('refuses blank duty instructions at load, including a direct apply', async () => {
    const { ctx, fiber } = await setup([])
    await fiber.dispose()
    expect(() => { toolTeam.apply(ctx, { duties: { executor: { instructions: '  ' } } }) })
      .toThrow('tool-agent-team: duties.executor.instructions must be non-empty')
    await expect(ctx.plugin(toolTeam, { duties: { planner: { instructions: '' } } })).rejects
      .toThrow('tool-agent-team: duties.planner.instructions must be non-empty')
  })

  async function withCommands(
    script: ConstructorParameters<typeof MockAdapter>[0],
    title = true,
    teamConfig: ConstructorParameters<typeof TeamService>[1] = {},
  ) {
    const context = await setup(script, false, undefined, teamConfig)
    await context.ctx.plugin(CommandRuntime)
    if (title) await context.ctx.plugin(SessionTitleService, { fallbackMaxWords: 6, fallbackMaxBytes: 80, maxTitleBytes: 80 })
    return context
  }

  it('starts a Team from /team: subject, pinned title, then the subject alone as the user turn', async () => {
    const { ctx, lead, adapter } = await withCommands([textResponse('planning now')])
    const execution = await ctx.commands.execute(lead, '/team   Ship the parser  ', [], SIGNAL)
    expect(execution?.result).toEqual({ kind: 'success', text: 'Agent Team started.' })
    await lead.whenIdle()

    expect(ctx.agentTeams.subjectOf(lead)).toBe('Ship the parser')
    const events = lead.session.snapshotEvents()
    const subjectSeq = events.findIndex(event => event.type === 'team/subject')
    const titleSeq = events.findIndex(event => event.type === 'session/title')
    const turnSeq = events.findIndex(event => event.type === 'turn/start')
    expect(subjectSeq).toBeGreaterThanOrEqual(0)
    expect(subjectSeq).toBeLessThan(titleSeq)
    expect(titleSeq).toBeLessThan(turnSeq)
    expect(events[titleSeq]?.data).toMatchObject({ title: 'Ship the parser', source: { kind: 'user' } })

    const request = adapter.requests[0]!
    const userTexts = request.messages.filter(message => message.role === 'user')
      .map(message => ({ kind: message.source?.kind, text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') }))
    expect(userTexts).toEqual([{ kind: 'user', text: 'Ship the parser' }])
    // The flow reaches the Lead through its Team section, recorded with the request.
    const system = request.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('')
    expect(system).toContain(SUBJECT_POLICY)
  })

  it('refuses /team without a subject, from a teammate, beyond the subject bound, or without the title service', async () => {
    const { ctx, lead } = await withCommands(['hang'])
    const helper = await execute(ctx, lead, 'spawn_teammate', { name: 'helper', description: 'help', prompt: 'help' })
    const teammate = await waitRunning(ctx, spawnedChildId(ctx, lead, helper))
    expect((await ctx.commands.execute(lead, '/team   ', [], SIGNAL))?.result)
      .toEqual({ kind: 'error', text: 'Usage: /team <subject>' })
    expect((await ctx.commands.execute(teammate, '/team mine', [], SIGNAL))?.result)
      .toEqual({ kind: 'error', text: 'Only the Team Lead conversation can start an Agent Team.' })
    expect((await ctx.commands.execute(lead, `/team ${'x'.repeat(201)}`, [], SIGNAL))?.result)
      .toEqual({ kind: 'error', text: 'subject exceeds 200 characters' })
    expect(ctx.agentTeams.subjectOf(lead)).toBeUndefined()

    const untitled = await withCommands([], false)
    expect((await untitled.ctx.commands.execute(untitled.lead, '/team Ship', [], SIGNAL))?.result)
      .toEqual({ kind: 'error', text: '/team needs the session-title service to name the conversation.' })
    expect(untitled.ctx.agentTeams.subjectOf(untitled.lead)).toBeUndefined()
    expect(untitled.lead.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('fails /team loudly when recording the subject fails for a reason other than a Team refusal', async () => {
    const { ctx, lead } = await withCommands([])
    vi.spyOn(ctx.agentTeams, 'setSubject').mockRejectedValue(new Error('flush failed'))
    await expect(ctx.commands.execute(lead, '/team Ship', [], SIGNAL)).rejects.toThrow('flush failed')
    expect(lead.session.snapshotEvents().some(event => event.type === 'session/title')).toBe(false)
    expect(lead.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('withdraws /team with the plugin', async () => {
    const { ctx, lead, fiber } = await withCommands([])
    expect(ctx.commands.list(lead).map(command => command.name)).toContain('team')
    await fiber.dispose()
    expect(ctx.commands.list(lead).map(command => command.name)).not.toContain('team')
    expect(await ctx.commands.execute(lead, '/team Ship', [], SIGNAL)).toBeUndefined()
  })

  it('rejects every invalid --members invocation without recording a subject or spawning anyone', async () => {
    const { ctx, lead } = await withCommands([])
    const cases: [string, string][] = [
      ['/team --members', 'Usage: /team --members <planner|executor,...> <subject>'],
      ['/team --members planner', 'Usage: /team --members <planner|executor,...> <subject>'],
      [
        '/team --members ,executor Ship the parser',
        '/team --members: empty duty in ",executor"; use a comma-separated list of planner or executor.',
      ],
      [
        '/team --members bogus Ship the parser',
        '/team --members: unknown duty "bogus"; use planner or executor.',
      ],
      [
        '/team --members planner,planner Ship the parser',
        '/team --members: at most one planner is allowed.',
      ],
    ]
    for (const [line, expected] of cases) {
      expect((await ctx.commands.execute(lead, line, [], SIGNAL))?.result).toEqual({ kind: 'error', text: expected })
    }
    expect(ctx.agentTeams.subjectOf(lead)).toBeUndefined()
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
    expect(lead.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('refuses --members over the Team\'s remaining capacity, changing nothing', async () => {
    const { ctx, lead } = await withCommands([], true, { maxMembers: 1 })
    const execution = await ctx.commands.execute(lead, '/team --members planner,executor Ship the parser', [], SIGNAL)
    expect(execution?.result).toEqual({
      kind: 'error',
      text: '/team --members requests 2 teammates, but the Team has room for 1 more.',
    })
    expect(ctx.agentTeams.subjectOf(lead)).toBeUndefined()
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
    expect(lead.session.snapshotEvents().some(event => event.type === 'session/title')).toBe(false)
  })

  it('starts a roster from /team --members: subject, ordered duties, then a Lead steer naming who started', async () => {
    const { ctx, lead } = await withCommands(['hang', 'hang', 'hang'])
    const execution = await ctx.commands.execute(
      lead, '/team --members planner,executor,executor Ship the parser', [], SIGNAL,
    )
    expect(execution?.result).toEqual({ kind: 'success', text: 'Agent Team started.' })

    expect(ctx.agentTeams.subjectOf(lead)).toBe('Ship the parser')
    const listed = ctx.agentTeams.listMembers(lead)
    expect(listed.map(member => [member.name, member.duty])).toEqual([
      ['lead', undefined],
      ['planner', 'planner'],
      ['executor-1', 'executor'],
      ['executor-2', 'executor'],
    ])

    const plannerChild = await waitRunning(ctx, listed[1]!.id)
    const executor1Child = await waitRunning(ctx, listed[2]!.id)
    const executor2Child = await waitRunning(ctx, listed[3]!.id)
    expect(initialPrompt(plannerChild)).toEqual([
      identity('planner', ['Your duty is "planner".', PLANNER]),
      'Break "Ship the parser" into tasks on the Team board for the executors. Do not edit files yourself.',
    ])
    expect(initialPrompt(executor1Child)).toEqual([
      identity('executor-1', ['Your duty is "executor".', EXECUTOR]),
      'Coordinate with the planner and the Lead through messages and the board, then complete the tasks assigned to you for "Ship the parser".',
    ])
    expect(initialPrompt(executor2Child)).toEqual([
      identity('executor-2', ['Your duty is "executor".', EXECUTOR]),
      'Coordinate with the planner and the Lead through messages and the board, then complete the tasks assigned to you for "Ship the parser".',
    ])

    const events = lead.session.snapshotEvents()
    const eventTypes = events.map(event => event.type)
    const subjectIndex = eventTypes.indexOf('team/subject')
    const memberIndexes = eventTypes.flatMap((type, index) => type === 'team/member' ? [index] : [])
    const turnIndex = eventTypes.indexOf('turn/start')
    expect(subjectIndex).toBeGreaterThanOrEqual(0)
    expect(memberIndexes.length).toBeGreaterThanOrEqual(3)
    expect(memberIndexes.every(index => index > subjectIndex)).toBe(true)
    expect(turnIndex).toBeGreaterThan(Math.max(...memberIndexes))

    const userMessage = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(userMessage?.type === 'user/message'
      ? userMessage.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : []).toEqual([
      'Ship the parser',
      'Started planner "planner" and executors "executor-1", "executor-2". You lead this Team: assign their work, review it, and integrate the result.',
    ])
  })

  it('names only the Lead in an executor-only roster\'s initial task, with no unstarted planner', async () => {
    const { ctx, lead } = await withCommands(['hang'])
    const execution = await ctx.commands.execute(lead, '/team --members executor Ship the parser', [], SIGNAL)
    expect(execution?.result).toEqual({ kind: 'success', text: 'Agent Team started.' })
    const listed = ctx.agentTeams.listMembers(lead)
    expect(listed.map(member => [member.name, member.duty])).toEqual([
      ['lead', undefined],
      ['executor-1', 'executor'],
    ])
    const child = await waitRunning(ctx, listed[1]!.id)
    expect(initialPrompt(child)).toEqual([
      identity('executor-1', ['Your duty is "executor".', EXECUTOR]),
      'Coordinate with the Lead through messages and the board, then complete the tasks assigned to you for "Ship the parser".',
    ])
  })

  it('omits the executors clause in a planner-only roster\'s initial task, with no unstarted executor', async () => {
    const { ctx, lead } = await withCommands(['hang'])
    const execution = await ctx.commands.execute(lead, '/team --members planner Ship the parser', [], SIGNAL)
    expect(execution?.result).toEqual({ kind: 'success', text: 'Agent Team started.' })
    const listed = ctx.agentTeams.listMembers(lead)
    expect(listed.map(member => [member.name, member.duty])).toEqual([
      ['lead', undefined],
      ['planner', 'planner'],
    ])
    const child = await waitRunning(ctx, listed[1]!.id)
    expect(initialPrompt(child)).toEqual([
      identity('planner', ['Your duty is "planner".', PLANNER]),
      'Break "Ship the parser" into tasks on the Team board. Do not edit files yourself.',
    ])
  })

  it('skips deterministic names already taken by earlier members, across both duties', async () => {
    const { ctx, lead } = await withCommands(['hang', 'hang', 'hang', 'hang', 'hang'])
    for (const name of ['planner', 'executor-1', 'executor-2']) {
      const spawned = await execute(ctx, lead, 'spawn_teammate', { name, description: 'preexisting', prompt: 'wait' })
      expect(spawned.isError, text(spawned)).toBe(false)
    }
    const execution = await ctx.commands.execute(lead, '/team --members planner,executor Ship the parser', [], SIGNAL)
    expect(execution?.result).toEqual({ kind: 'success', text: 'Agent Team started.' })
    expect(ctx.agentTeams.listMembers(lead).map(member => member.name)).toEqual([
      'lead', 'planner', 'executor-1', 'executor-2', 'planner-1', 'executor-3',
    ])
  })

  it('stops a --members batch after the second spawn fails, reporting what started and what remains', async () => {
    const { ctx, lead } = await withCommands(['hang'])
    const original = ctx.agentTeams.spawnTeammate.bind(ctx.agentTeams)
    let callCount = 0
    vi.spyOn(ctx.agentTeams, 'spawnTeammate').mockImplementation(async (caller, request) => {
      callCount += 1
      if (callCount === 2) throw new Error('provider unavailable')
      return original(caller, request)
    })
    const execution = await ctx.commands.execute(
      lead, '/team --members planner,executor,executor Ship the parser', [], SIGNAL,
    )
    expect(execution?.result).toEqual({
      kind: 'error',
      text: '/team --members stopped after teammate "executor-1" (executor) failed to start: provider unavailable. '
        + 'Started: planner "planner". Not started: 1 executor.',
    })
    expect(ctx.agentTeams.subjectOf(lead)).toBe('Ship the parser')
    expect(ctx.agentTeams.listMembers(lead).map(member => member.name)).toEqual(['lead', 'planner'])
    expect(lead.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'user')).toBe(false)
  })

  it('stops a --members batch after the third spawn fails, with nothing left to start', async () => {
    const { ctx, lead } = await withCommands(['hang', 'hang'])
    const original = ctx.agentTeams.spawnTeammate.bind(ctx.agentTeams)
    let callCount = 0
    vi.spyOn(ctx.agentTeams, 'spawnTeammate').mockImplementation(async (caller, request) => {
      callCount += 1
      if (callCount === 3) throw new Error('provider unavailable')
      return original(caller, request)
    })
    const execution = await ctx.commands.execute(
      lead, '/team --members planner,executor,executor Ship the parser', [], SIGNAL,
    )
    expect(execution?.result).toEqual({
      kind: 'error',
      text: '/team --members stopped after teammate "executor-2" (executor) failed to start: provider unavailable. '
        + 'Started: planner "planner" and executor "executor-1". Not started: none.',
    })
    expect(ctx.agentTeams.listMembers(lead).map(member => member.name)).toEqual(['lead', 'planner', 'executor-1'])
  })

  it('renders a non-Error --members spawn failure and names a not-started planner', async () => {
    const { ctx, lead } = await withCommands([])
    vi.spyOn(ctx.agentTeams, 'spawnTeammate').mockRejectedValue('provider offline')
    const execution = await ctx.commands.execute(lead, '/team --members executor,planner Ship the parser', [], SIGNAL)
    expect(execution?.result).toEqual({
      kind: 'error',
      text: '/team --members stopped after teammate "executor-1" (executor) failed to start: provider offline. '
        + 'Started: none. Not started: 1 planner.',
    })
  })

  it('reports a plural executor-only started roster when a later planner spawn fails', async () => {
    const { ctx, lead } = await withCommands(['hang', 'hang'])
    const original = ctx.agentTeams.spawnTeammate.bind(ctx.agentTeams)
    let callCount = 0
    vi.spyOn(ctx.agentTeams, 'spawnTeammate').mockImplementation(async (caller, request) => {
      callCount += 1
      if (callCount === 3) throw new Error('provider unavailable')
      return original(caller, request)
    })
    const execution = await ctx.commands.execute(
      lead, '/team --members executor,executor,planner Ship the parser', [], SIGNAL,
    )
    expect(execution?.result).toEqual({
      kind: 'error',
      text: '/team --members stopped after teammate "planner" (planner) failed to start: provider unavailable. '
        + 'Started: executors "executor-1", "executor-2". Not started: none.',
    })
    expect(ctx.agentTeams.listMembers(lead).map(member => member.name)).toEqual(['lead', 'executor-1', 'executor-2'])
  })

  it('reports a plural all-executor not-started remainder when the first --members spawn fails', async () => {
    const { ctx, lead } = await withCommands([])
    vi.spyOn(ctx.agentTeams, 'spawnTeammate').mockRejectedValue(new Error('provider unavailable'))
    const execution = await ctx.commands.execute(
      lead, '/team --members executor,executor,executor Ship the parser', [], SIGNAL,
    )
    expect(execution?.result).toEqual({
      kind: 'error',
      text: '/team --members stopped after teammate "executor-1" (executor) failed to start: provider unavailable. '
        + 'Started: none. Not started: 2 executors.',
    })
  })
})
