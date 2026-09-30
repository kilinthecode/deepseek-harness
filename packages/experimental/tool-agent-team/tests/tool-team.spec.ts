import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ReasoningEffortId, ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageInputSupport } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
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
  await ctx.plugin(TeamService)
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
        expect(schema?.properties).toHaveProperty('acceptsImages')
        expect(schema?.properties?.acceptsImages?.enum).toEqual(['supported', 'unsupported', 'undeclared'])
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

  it('merges acceptsImages into list_agents rows and omits it when resolution fails', async () => {
    const { ctx, lead } = await setup(['hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review changes', prompt: 'wait for work',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)
    vi.spyOn(lead.session, 'requestHeader').mockReturnValue({
      config: { provider: 'mock', model: 'lead-model' },
    })
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (_provider, model) => (
      model === 'lead-model'
        ? { inputModalities: ['text', 'image'] }
        : { inputModalities: ['text'] }
    ) as never)
    const listed = JSON.parse(text(await execute(ctx, child, 'list_agents', {}))) as Array<{
      target: string
      acceptsImages?: ImageInputSupport
    }>
    expect(listed).toEqual([
      expect.objectContaining({ target: 'lead', acceptsImages: 'supported' }),
      expect.objectContaining({ target: 'reviewer', acceptsImages: 'unsupported' }),
    ])
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockRejectedValue(new Error('catalog down'))
    const omitted = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{
      target: string
      acceptsImages?: ImageInputSupport
    }>
    expect(omitted).toHaveLength(2)
    expect(omitted.map(row => row.target)).toEqual(['lead', 'reviewer'])
    expect(omitted.every(row => row.acceptsImages === undefined)).toBe(true)
    await execute(ctx, lead, 'interrupt_agent', { target: 'reviewer' })
    await waitNoAgent(ctx, childId)
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

  describe('image handoff', () => {
    const IMAGE_ID = `sha256:${'7'.repeat(64)}`
    const USER_IMAGE_ID = `sha256:${'a'.repeat(64)}`
    const TOOL_IMAGE_ID = `sha256:${'b'.repeat(64)}`
    const imageBlock = {
      type: 'image' as const,
      attachment: {
        attachmentId: AttachmentId(IMAGE_ID),
        mediaType: 'image/png' as const,
        bytes: 75,
        width: 8,
        height: 8,
        name: 'image-1.png',
      },
    }

    /** Put the image into the caller's derived history once. */
    function showImage(agent: Agent): void {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'reference image' }, imageBlock],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }

    const userImageRef = {
      attachmentId: AttachmentId(USER_IMAGE_ID),
      mediaType: 'image/png' as const,
      bytes: 75,
      width: 8,
      height: 8,
      name: 'user.png',
    }
    const toolImageRef = {
      attachmentId: AttachmentId(TOOL_IMAGE_ID),
      mediaType: 'image/png' as const,
      bytes: 75,
      width: 8,
      height: 8,
      name: 'tool.png',
    }

    /** User-message image plus a nested tool-result image; citing one must not copy the other. */
    function showUserAndToolResultImages(agent: Agent): void {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'user image' }, { type: 'image', attachment: userImageRef }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      agent.session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('history-image'),
          content: [{ type: 'image', attachment: toolImageRef }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
    }

    it('hands cited conversation images to a spawned teammate after the prompt text', async () => {
      const { ctx, lead } = await setup([textResponse('image child answer')])
      showImage(lead)
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'image-worker',
        description: 'image worker responsibility',
        prompt: 'Describe the image.',
        images: [IMAGE_ID],
      })
      expect(spawned.isError, text(spawned)).toBe(false)
      const childId = spawnedChildId(ctx, lead, spawned)
      await waitNoAgent(ctx, childId)
      await using persisted = await ctx.sessionPersistence.open(childId, 'read')
      const { events } = await persisted.read()
      const initial = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
      expect(initial?.type === 'user/message' ? initial.data.content.at(-2) : undefined)
        .toEqual({ type: 'text', text: 'Describe the image.' })
      expect(initial?.type === 'user/message' ? initial.data.content.at(-1) : undefined).toEqual(imageBlock)
    })

    it('delivers cited conversation images to a teammate after the message text', async () => {
      const { ctx, lead } = await setup([
        textResponse('first turn'),
        textResponse('image follow-up'),
      ])
      showImage(lead)
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'image-peer', description: 'image peer responsibility', prompt: 'wait',
      })
      expect(spawned.isError, text(spawned)).toBe(false)
      const childId = spawnedChildId(ctx, lead, spawned)
      await waitNoAgent(ctx, childId)

      const sent = await execute(ctx, lead, 'send_message', {
        target: 'image-peer', message: 'see the image', images: [IMAGE_ID],
      })
      expect(sent.isError, text(sent)).toBe(false)
      expect(JSON.parse(text(sent))).toMatchObject({ status: 'accepted' })
      await waitNoAgent(ctx, childId)
      await using persisted = await ctx.sessionPersistence.open(childId, 'read')
      const { events } = await persisted.read()
      const contents = events.flatMap((event) => {
        if (event.type === 'agent/inbox/spliced') return (event.data.inserted ?? []).map(message => message.content)
        if (event.type === 'user/message') return [event.data.content]
        return []
      })
      const delivered = contents.find(content => content.some(block => block.type === 'image'))
      expect(delivered?.at(-2)).toEqual({ type: 'text', text: 'see the image' })
      expect(delivered?.at(-1)).toEqual(imageBlock)
    })

    it('rejects an image id the conversation never showed before any durable Team work', async () => {
      const { ctx, lead } = await setup([])
      const sent = await execute(ctx, lead, 'send_message', { target: 'lead', message: 'm', images: [IMAGE_ID] })
      expect(sent.isError).toBe(true)
      expect(text(sent)).toContain(`"${IMAGE_ID}" is not an image shown in this conversation`)
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'image-worker', description: 'image worker responsibility', prompt: 'p', images: [IMAGE_ID],
      })
      expect(spawned.isError).toBe(true)
      expect(text(spawned)).toContain('is not an image shown in this conversation')
      expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
    })

    it('surfaces the Team image-route refusal unchanged to the model', async () => {
      const { ctx, lead } = await setup([textResponse('image-peer done')])
      showImage(lead)
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'image-peer', description: 'image peer responsibility', prompt: 'wait',
      })
      expect(spawned.isError, text(spawned)).toBe(false)
      await waitNoAgent(ctx, spawnedChildId(ctx, lead, spawned))
      vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue({ inputModalities: ['text'] } as never)
      const sent = await execute(ctx, lead, 'send_message', {
        target: 'image-peer', message: 'see this', images: [IMAGE_ID],
      })
      expect(sent.isError).toBe(true)
      expect(text(sent)).toContain('Model "mock" does not support image input.')
    })

    it('enforces the deployment per-message image limit when the attachments service is present', async () => {
      const { ctx, lead } = await setup([])
      ctx.provide('attachments', { imageLimits: { maxImagesPerMessage: 1 } } as never)
      showImage(lead)
      const sent = await execute(ctx, lead, 'send_message', {
        target: 'lead', message: 'm', images: [IMAGE_ID, `sha256:${'8'.repeat(64)}`],
      })
      expect(sent.isError).toBe(true)
      expect(text(sent)).toContain('images lists 2 attachments, over the per-message image limit of 1')
    })

    it('hands only the cited tool-result image to a spawned teammate when the conversation also shows a user image', async () => {
      const { ctx, lead } = await setup([textResponse('select child answer')])
      showUserAndToolResultImages(lead)
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'image-select',
        description: 'image select responsibility',
        prompt: 'Describe the cited image.',
        images: [TOOL_IMAGE_ID],
      })
      expect(spawned.isError, text(spawned)).toBe(false)
      const childId = spawnedChildId(ctx, lead, spawned)
      await waitNoAgent(ctx, childId)
      await using persisted = await ctx.sessionPersistence.open(childId, 'read')
      const { events } = await persisted.read()
      const initial = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
      const content = initial?.type === 'user/message' ? initial.data.content : []
      expect(content.filter(block => block.type === 'image')).toEqual([{ type: 'image', attachment: toolImageRef }])
      expect(content.at(-2)).toEqual({ type: 'text', text: 'Describe the cited image.' })
      expect(content.at(-1)).toEqual({ type: 'image', attachment: toolImageRef })
    })

    it('rejects duplicated spawn_teammate image ids before provisioning a teammate', async () => {
      const { ctx, lead } = await setup([])
      showImage(lead)
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'dup-worker', description: 'dup worker responsibility', prompt: 'p', images: [IMAGE_ID, IMAGE_ID],
      })
      expect(spawned.isError).toBe(true)
      expect(text(spawned)).toContain(`images lists attachment id "${IMAGE_ID}" more than once`)
      const listed = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{ target: string }>
      expect(listed.map(row => row.target)).toEqual(['lead'])
    })

    it('enforces the spawn_teammate per-message image limit before provisioning a teammate', async () => {
      const { ctx, lead } = await setup([])
      ctx.provide('attachments', { imageLimits: { maxImagesPerMessage: 1 } } as never)
      showUserAndToolResultImages(lead)
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'limit-worker',
        description: 'limit worker responsibility',
        prompt: 'p',
        images: [USER_IMAGE_ID, TOOL_IMAGE_ID],
      })
      expect(spawned.isError).toBe(true)
      expect(text(spawned)).toContain('images lists 2 attachments, over the per-message image limit of 1')
      const listed = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{ target: string }>
      expect(listed.map(row => row.target)).toEqual(['lead'])
    })

    it('strips the history offload mark from spawn_teammate image blocks', async () => {
      const { ctx, lead } = await setup([textResponse('offload child answer')])
      lead.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'reference image' }, { ...imageBlock, offloaded: true as const }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const spawn = vi.spyOn(ctx.agentTeams, 'spawnTeammate')
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'offload-worker',
        description: 'offload worker responsibility',
        prompt: 'Describe the image.',
        images: [IMAGE_ID],
      })
      expect(spawned.isError, text(spawned)).toBe(false)
      const delivered = spawn.mock.calls[0]?.[1].prompt.at(-1)
      expect(delivered).toEqual({ type: 'image', attachment: imageBlock.attachment })
      expect(delivered).not.toHaveProperty('offloaded')
      await waitNoAgent(ctx, spawnedChildId(ctx, lead, spawned))
    })

    it('rejects duplicated send_message image ids before any mailbox enqueue', async () => {
      const { ctx, lead } = await setup([])
      showImage(lead)
      const sent = await execute(ctx, lead, 'send_message', {
        target: 'lead', message: 'm', images: [IMAGE_ID, IMAGE_ID],
      })
      expect(sent.isError).toBe(true)
      expect(text(sent)).toContain(`images lists attachment id "${IMAGE_ID}" more than once`)
      expect(lead.session.snapshotEvents().some(event => event.type === 'team/message/queued')).toBe(false)
    })

    it('strips the history offload mark from send_message image blocks', async () => {
      const { ctx, lead } = await setup([
        textResponse('first turn'),
        textResponse('offload follow-up'),
      ])
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'offload-peer', description: 'offload peer responsibility', prompt: 'wait',
      })
      expect(spawned.isError, text(spawned)).toBe(false)
      const childId = spawnedChildId(ctx, lead, spawned)
      await waitNoAgent(ctx, childId)
      lead.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'reference image' }, { ...imageBlock, offloaded: true as const }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const send = vi.spyOn(ctx.agentTeams, 'sendMessage')
      const sent = await execute(ctx, lead, 'send_message', {
        target: 'offload-peer', message: 'see the image', images: [IMAGE_ID],
      })
      expect(sent.isError, text(sent)).toBe(false)
      expect(send.mock.calls[0]?.[1].content).toEqual([
        { type: 'text', text: 'see the image' },
        { type: 'image', attachment: imageBlock.attachment },
      ])
      expect(send.mock.calls[0]?.[1].content.at(-1)).not.toHaveProperty('offloaded')
      await waitNoAgent(ctx, childId)
    })
  })
})

describe('plain fork parity with Team installation', () => {
  it('mirrors the Lead\'s Team section and tools onto a plain subagent_fork, with the Lead\'s prefix', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('lead answer'), textResponse('fork answer')])
    await runTurn(lead, 'Lead task')
    const leadRequest = serializeRequest(adapter.requests[0]!)
    const run = await ctx.subagents.start('fork', {
      label: 'fork task',
      prompt: [{ type: 'text', text: 'Continue independently' }],
      parent: lead,
      signal: SIGNAL,
    })
    await run.result
    const forkRequest = serializeRequest(adapter.requests[1]!)
    expect(forkRequest.tools).toEqual(leadRequest.tools)
    expect(forkRequest.system).toEqual(leadRequest.system)
    expect(forkRequest.messages.slice(0, leadRequest.messages.length)).toEqual(leadRequest.messages)
    await run.dispose()
  })

  it('rejects send_message from a plain fork as a non-member, delivering nothing', async () => {
    const { ctx, lead } = await setup([textResponse('lead answer'), textResponse('fork answer')])
    await runTurn(lead, 'Lead task')
    const beforeMessages = structuredClone(lead.session.deriveMessages())
    const run = await ctx.subagents.start('fork', {
      label: 'fork task',
      prompt: [{ type: 'text', text: 'independent task' }],
      parent: lead,
      signal: SIGNAL,
    })
    const fork = run.localAgent!
    // Deterministic under the header-origin classification rule: the one-shot
    // `subagent/descriptor` is not appended yet at this synchronous point (it
    // lands lazily in the fork's first `agent/pre-step`), so this assertion is
    // false under the old descriptor-fold classification, which would read no
    // descriptor yet and misclassify this fresh fork as an implicit new Lead.
    expect(ctx.agentTeams.tryMembership(fork)).toBeUndefined()
    const result = await execute(ctx, fork, 'send_message', { target: 'lead', message: 'I am the Lead now' })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('TEAM_NOT_MEMBER')
    expect(lead.session.deriveMessages()).toEqual(beforeMessages)
    await run.dispose()
  })

  it('rejects spawn_teammate from a plain fork as a non-member, creating no teammate', async () => {
    const { ctx, lead } = await setup([textResponse('lead answer'), textResponse('fork answer')])
    await runTurn(lead, 'Lead task')
    const beforeMembers = ctx.agentTeams.listMembers(lead)
    const run = await ctx.subagents.start('fork', {
      label: 'fork task',
      prompt: [{ type: 'text', text: 'independent task' }],
      parent: lead,
      signal: SIGNAL,
    })
    const fork = run.localAgent!
    // See the equivalent assertion in the send_message rejection test above.
    expect(ctx.agentTeams.tryMembership(fork)).toBeUndefined()
    const result = await execute(ctx, fork, 'spawn_teammate', {
      name: 'rogue', description: 'unauthorized', prompt: 'act as the lead',
    })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('TEAM_NOT_MEMBER')
    expect(ctx.agentTeams.listMembers(lead)).toEqual(beforeMembers)
    await run.dispose()
  })

  const FORK_DENIAL_CASES = [
    ['spawn_teammate', { name: 'rogue', description: 'unauthorized', prompt: 'act as the lead' }],
    ['send_message', { target: 'lead', message: 'I am the Lead now' }],
    ['list_agents', {}],
    ['wait_agent', {}],
    ['interrupt_agent', { target: 'witness' }],
    ['team_task_create', { subject: 'rogue task', description: 'unauthorized task' }],
    ['team_task_list', {}],
    ['team_task_get', { task_id: 'missing-task' }],
    ['team_task_update', { task_id: 'missing-task', expected_revision: 1, action: 'claim' }],
  ] as const

  it('covers every Team tool in the plain-fork denial table', () => {
    expect(FORK_DENIAL_CASES.map(([toolName]) => toolName).sort()).toEqual(TOOL_NAMES)
  })

  it.each(FORK_DENIAL_CASES)('rejects %s from a plain fork of the Lead as a non-member, with no side effect', async (toolName, args) => {
    const { ctx, lead } = await setup([textResponse('lead answer'), 'hang', textResponse('fork answer')])
    await runTurn(lead, 'Lead task')
    const witnessSpawn = await execute(ctx, lead, 'spawn_teammate', {
      name: 'witness', description: 'stay available', prompt: 'wait',
    })
    const witnessId = spawnedChildId(ctx, lead, witnessSpawn)
    await waitRunning(ctx, witnessId)
    await execute(ctx, lead, 'team_task_create', { subject: 'baseline', description: 'baseline task' })

    const beforeMembers = ctx.agentTeams.listMembers(lead)
    const beforeTasks = ctx.agentTeams.listTasks(lead)
    const beforeMessages = structuredClone(lead.session.deriveMessages())

    const run = await ctx.subagents.start('fork', {
      label: 'fork task', prompt: [{ type: 'text', text: 'independent task' }], parent: lead, signal: SIGNAL,
    })
    const fork = run.localAgent!
    expect(ctx.agentTeams.tryMembership(fork)).toBeUndefined()

    const result = await execute(ctx, fork, toolName, args)
    expect(result.isError, text(result)).toBe(true)
    expect(result.error?.info?.code).toBe('TEAM_NOT_MEMBER')
    expect(ctx.agentTeams.listMembers(lead)).toEqual(beforeMembers)
    expect(ctx.agentTeams.listTasks(lead)).toEqual(beforeTasks)
    expect(lead.session.deriveMessages()).toEqual(beforeMessages)

    await run.dispose()
    await execute(ctx, lead, 'interrupt_agent', { target: 'witness' })
    await vi.waitFor(() => { expect(ctx.agents.get(witnessId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('does not install Team tools on a persona or toolFilter fork', async () => {
    // Continuable, not one-shot: a continuable descriptor records persona and
    // toolFilter durably (a one-shot descriptor never does, see
    // plain-fork.ts), so this is the reliable way to exercise the exclusion.
    const { ctx, lead } = await setup([textResponse('lead answer')])
    await runTurn(lead, 'Lead task')
    // A known global tool name for the toolFilter case below: restrict()
    // validates deny/allow entries against registered global tools, and
    // every Team tool is scoped rather than global.
    ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'test-only fixture tool', parameters: {}, async execute() { return [] },
    }))

    const personaId = SessionId('gate-persona-fork')
    await ctx.subagents.startContinuable({
      childId: personaId,
      provider: 'fork',
      label: 'x',
      request: { prompt: [{ type: 'text', text: 'x' }], parent: lead, persona: 'You are a narrow specialist.' },
      signal: SIGNAL,
    })
    expect(ctx.tools.get('spawn_teammate', ctx.agents.get(personaId))).toBeUndefined()
    await ctx.subagents.drainContinuableChildren(lead, [personaId])

    const toolFilterId = SessionId('gate-toolfilter-fork')
    await ctx.subagents.startContinuable({
      childId: toolFilterId,
      provider: 'fork',
      label: 'x',
      request: { prompt: [{ type: 'text', text: 'x' }], parent: lead, toolFilter: { allow: ['probe'] } },
      signal: SIGNAL,
    })
    expect(ctx.tools.get('spawn_teammate', ctx.agents.get(toolFilterId))).toBeUndefined()
    await ctx.subagents.drainContinuableChildren(lead, [toolFilterId])
  })

  it('does not install Team tools on a fresh subagent child of the Lead', async () => {
    const { ctx, lead } = await setup([textResponse('lead answer'), textResponse('fresh')])
    await runTurn(lead, 'Lead task')
    const freshRun = await ctx.subagents.start('spawn', {
      label: 'x', prompt: [{ type: 'text', text: 'x' }], parent: lead, signal: SIGNAL,
    })
    expect(ctx.tools.get('spawn_teammate', freshRun.localAgent)).toBeUndefined()
    await freshRun.dispose()
  })

  it('does not install Team tools on a one-shot outputSchema fork', async () => {
    // A one-shot `subagent/descriptor` never records outputSchema (see
    // descriptor.ts), so classification relies on the in-process composition
    // record `applyChildComposition` sets from the driver's own
    // `request.outputSchema`, not on anything read back from the log.
    const { ctx, lead } = await setup([textResponse('lead answer'), textResponse('child')])
    await runTurn(lead, 'Lead task')
    const run = await ctx.subagents.start('fork', {
      label: 'x', prompt: [{ type: 'text', text: 'x' }], parent: lead, signal: SIGNAL,
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    })
    expect(ctx.tools.get('spawn_teammate', run.localAgent)).toBeUndefined()
    await run.dispose()
  })

  it('does not install Team tools on a one-shot persona or toolFilter fork', async () => {
    // Mirrors the continuable case above through the one-shot driver instead:
    // a one-shot `subagent/descriptor` never records persona or toolFilter
    // either (see plain-fork.ts), so this exercises the same in-process
    // composition record from the other creation path.
    const { ctx, lead } = await setup([
      textResponse('lead answer'), textResponse('persona child'), textResponse('toolFilter child'),
    ])
    await runTurn(lead, 'Lead task')
    // A known global tool name for the toolFilter case below: restrict()
    // validates deny/allow entries against registered global tools, and
    // every Team tool is scoped rather than global.
    ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'test-only fixture tool', parameters: {}, async execute() { return [] },
    }))

    const personaRun = await ctx.subagents.start('fork', {
      label: 'x', prompt: [{ type: 'text', text: 'x' }], parent: lead, signal: SIGNAL,
      persona: 'You are a narrow specialist.',
    })
    expect(ctx.tools.get('spawn_teammate', personaRun.localAgent)).toBeUndefined()
    await personaRun.dispose()

    const toolFilterRun = await ctx.subagents.start('fork', {
      label: 'x', prompt: [{ type: 'text', text: 'x' }], parent: lead, signal: SIGNAL,
      toolFilter: { allow: ['probe'] },
    })
    expect(ctx.tools.get('spawn_teammate', toolFilterRun.localAgent)).toBeUndefined()
    await toolFilterRun.dispose()
  })

  it('extends Team tools transitively through a plain fork of a plain fork', async () => {
    const { ctx, lead, adapter } = await setup([
      textResponse('lead answer'), textResponse('fork1 answer'), textResponse('fork2 answer'),
    ])
    await runTurn(lead, 'Lead task')
    const fork1Run = await ctx.subagents.start('fork', {
      label: 'fork1', prompt: [{ type: 'text', text: 'fork1 task' }], parent: lead, signal: SIGNAL,
    })
    const fork1 = fork1Run.localAgent!
    await fork1Run.result
    // fork1 is a plain fork of the member Lead, so it gets Team tools, but it
    // is not itself a member — the roster still rejects it as a caller.
    expect(ctx.tools.get('spawn_teammate', fork1)).toBeDefined()
    expect(() => ctx.agentTeams.membership(fork1)).toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))
    const fork1Request = serializeRequest(adapter.requests[1]!)

    const fork2Run = await ctx.subagents.start('fork', {
      label: 'fork2', prompt: [{ type: 'text', text: 'fork2 task' }], parent: fork1, signal: SIGNAL,
    })
    const fork2 = fork2Run.localAgent!
    await fork2Run.result
    // fork2's immediate parent (fork1) is not itself a Team member, so only a
    // transitive walk through fork1's own plain-fork parent (the member Lead)
    // extends the section and tools here; a one-hop check would stop at
    // fork1 and drop them, missing the provider prompt cache on fork2's
    // first request.
    expect(ctx.tools.get('spawn_teammate', fork2)).toBeDefined()
    const fork2Request = serializeRequest(adapter.requests[2]!)
    expect(fork2Request.tools).toEqual(fork1Request.tools)
    expect(fork2Request.system).toEqual(fork1Request.system)
    const denied = await execute(ctx, fork2, 'spawn_teammate', {
      name: 'rogue', description: 'unauthorized', prompt: 'act as the lead',
    })
    expect(denied.isError).toBe(true)
    expect(denied.error?.info?.code).toBe('TEAM_NOT_MEMBER')

    await fork2Run.dispose()
    await fork1Run.dispose()
  })

  it('does not extend Team tools through a plain fork chain whose root is not a member', async () => {
    const { ctx, lead } = await setup([
      textResponse('lead answer'), textResponse('fresh answer'), textResponse('fork-of-fresh answer'),
    ])
    await runTurn(lead, 'Lead task')
    const freshRun = await ctx.subagents.start('spawn', {
      label: 'fresh', prompt: [{ type: 'text', text: 'fresh task' }], parent: lead, signal: SIGNAL,
    })
    const freshChild = freshRun.localAgent!
    await freshRun.result
    // A fresh child is not seeded, so plainForkParentOf never resolves a
    // parent for it: it terminates the lineage walk, and it is not a Team
    // member.
    expect(ctx.tools.get('spawn_teammate', freshChild)).toBeUndefined()

    const forkOfFreshRun = await ctx.subagents.start('fork', {
      label: 'fork-of-fresh', prompt: [{ type: 'text', text: 'fork of fresh task' }], parent: freshChild, signal: SIGNAL,
    })
    const forkOfFresh = forkOfFreshRun.localAgent!
    // forkOfFresh's plain-fork walk reaches freshChild and stops there:
    // freshChild is neither a member nor itself a plain fork, so the
    // lineage's root is not a member and the walk finds nothing to inherit.
    expect(ctx.tools.get('spawn_teammate', forkOfFresh)).toBeUndefined()

    await forkOfFreshRun.dispose()
    await freshRun.dispose()
  })

  it('re-installs Team tools after a cold resume of a continuable plain fork of the Lead', async () => {
    const { ctx, lead } = await setup([textResponse('lead answer'), textResponse('fork answer'), textResponse('resumed answer')])
    await runTurn(lead, 'Lead task')
    const childId = SessionId('lead-plain-fork-cold')
    await ctx.subagents.startContinuable({
      childId,
      provider: 'fork',
      label: 'fork task',
      request: { prompt: [{ type: 'text', text: 'fork task' }], parent: lead },
      signal: SIGNAL,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    await queueHostSubagentPrompt(
      ctx.subagents, lead, childId, [{ type: 'text', text: 'continue' }], { kind: 'user' }, SIGNAL,
    )
    const resumed = await waitRunning(ctx, childId)
    expect((await assembly(ctx, resumed)).tools.map(schema => schema.name)
      .filter(name => TOOL_NAMES.includes(name)).sort()).toEqual(TOOL_NAMES)
    await ctx.subagents.drainContinuableChildren(lead, [childId])
  })
})
