/**
 * Live peer-verification certification: one model does the work, a second model
 * on another route clears it through the shipped tools. Self-skips without a
 * DeepSeek credential in the environment or the harness-home store.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalCredentialProvider, resolveSpec } from '@deepseek-ai/dsh-credentials-local'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as toolTeam from '../../tool-agent-team/src/index.ts'
import TeamService from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const PROVIDER = 'deepseek-official'
const WORKER_MODEL = 'deepseek-flash'
const VERIFIER_MODEL = 'deepseek-v4-pro'
/** Distinctive configured grace, so a verdict reason quoting it proves a read. */
const GRACE_MS = 77_000
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

/** Compose the shipped team runtime over a real DeepSeek route. */
async function setup() {
  const ctx = new Context()
  CONTEXTS.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-task-verify-e2e-'))
  ROOTS.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(LocalCredentialProvider, { watch: false })
  await ctx.plugin(LlmDeepSeek, { retryPolicy: { mode: 'normal', maxRetries: 1 } })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TimerService)
  await ctx.plugin(TeamService, { roomEnabled: true, roomReviewGraceMs: GRACE_MS, maxMembers: 4 })
  await ctx.plugin(toolTeam)
  const lead = await ctx.agentLoop.create(SessionId('task-verify-e2e-lead'), { provider: PROVIDER, model: WORKER_MODEL })
  return { ctx, lead }
}

describe.skipIf(!LIVE)('live peer verification', () => {
  it('completes submitted work only through another model verdict', async () => {
    const { ctx, lead } = await setup()
    const noteRoot = mkdtempSync(join(tmpdir(), 'dsh-task-verify-note-'))
    ROOTS.push(noteRoot)
    const notePath = join(noteRoot, 'room-grace.md')
    writeFileSync(notePath, [
      '# Room escalation grace',
      '',
      `A pending reviewer gets ${String(GRACE_MS)} milliseconds of observed silence before the room`,
      'escalates, and every reminder restarts that window.',
      '',
    ].join('\n'))

    const verifier = await ctx.agentTeams.spawnTeammate(lead, {
      name: 'verifier',
      description: 'Verifies submitted work and records its own verdict.',
      prompt: [{
        type: 'text',
        text: 'You verify finished work and record your own verdict; you never claim work you have not read. The Lead will submit a task and hand it to you. Say in one sentence that you are ready, then stop.',
      }],
      context: 'fresh',
      provider: 'spawn',
      agentOptions: { provider: PROVIDER, model: VERIFIER_MODEL },
      signal: SIGNAL,
    })
    // A seated teammate leaves the live registry when its opening turn ends, so
    // the roster reports `inactive` rather than `idle` from then on.
    await vi.waitFor(() => {
      const member = ctx.agentTeams.listMembers(lead).find(candidate => candidate.name === 'verifier')
      expect(['idle', 'inactive']).toContain(member?.status)
    }, { timeout: 120_000, interval: 500 })
    // Route separation is the point: the owner cannot sit on its own appeal.
    expect(verifier.member.model).toBe(VERIFIER_MODEL)

    const created = await ctx.agentTeams.createTask(lead, {
      subject: 'Record the room escalation grace',
      description: [
        'Acceptance criterion: the note states the exact grace in milliseconds and says a reminder restarts the window.',
        '',
        `Deliverable, also written to ${notePath}:`,
        `A pending reviewer gets ${String(GRACE_MS)} milliseconds of observed silence before the room escalates; every reminder restarts that window.`,
      ].join('\n'),
    })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: created.id,
      expectedRevision: created.revision,
      action: 'claim',
    })
    const submitted = await ctx.agentTeams.updateTask(lead, {
      taskId: claimed.id,
      expectedRevision: claimed.revision,
      action: 'submit',
    })
    expect(submitted.status).toBe('verifying')
    expect(submitted.verification?.submittedRevision).toBe(submitted.revision)

    // The owner's own judgement cannot clear the work: the board refuses it
    // before any peer speaks, so the task stands submitted.
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: submitted.id,
      expectedRevision: submitted.revision,
      action: 'verify',
      verdict: 'approved',
      reason: 'Looks done to me.',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_SELF_VERIFICATION' })
    expect(ctx.agentTeams.getTask(lead, created.id).status).toBe('verifying')

    // The mailbox wakes the assigned peer, which reaches its own verdict in its
    // own model turn rather than being scored by the host.
    await ctx.agentTeams.sendMessage(lead, {
      target: 'verifier',
      content: [{
        type: 'text',
        text: [
          `Shared task ${created.id} is submitted for verification at revision ${String(submitted.revision)}.`,
          'Read the board with team_task_list, judge the deliverable against the acceptance criterion,',
          'then record your own verdict with team_task_update using',
          `task_id "${created.id}", expected_revision ${String(submitted.revision)}, action "verify",`,
          'verdict "approved" when the criterion holds, and a reason stating the exact grace in',
          'milliseconds that the deliverable records.',
        ].join(' '),
      }],
      signal: SIGNAL,
    })
    await vi.waitFor(() => {
      expect(ctx.agentTeams.getTask(lead, created.id).status).toBe('completed')
    }, { timeout: 240_000, interval: 1_000 })

    const cleared = ctx.agentTeams.getTask(lead, created.id)
    expect(cleared.verification).toMatchObject({ verdict: 'approved', verifierName: 'verifier' })
    // The reason repeats the value the deliverable records, so the verdict comes
    // from reading the submitted work instead of an agreeable guess.
    expect(cleared.verification?.reason).toMatch(/77/)

    // The verdict reaches the owner as a durable peer notice, so a real owner
    // learns the outcome instead of polling the board.
    await vi.waitFor(() => {
      const notices = lead.session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced'
        ? event.data.inserted.flatMap(input => input.source.kind === 'team-message'
          ? [input.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
          : [])
        : [])
      expect(notices.some(text => text.includes('approved by verifier'))).toBe(true)
    }, { timeout: 60_000 })

    // Durable, not just projected: the verdict survives reopening the log, and
    // the roster keeps naming the route the verifier was seated on.
    expect(ctx.agentTeams.listMembers(lead).find(member => member.name === 'verifier')?.model)
      .toBe(VERIFIER_MODEL)
    await ctx.sessions.flush(lead.session)
    const stored = await ctx.sessionPersistence.open(lead.id, 'read')
    let events
    try {
      events = (await stored.read()).events
    } finally {
      await stored.close()
    }
    const recorded = events
      .flatMap(event => event.type === 'team/task' ? [event.data.task] : [])
      .filter(task => task.id === created.id)
    expect(recorded.at(-1)?.status).toBe('completed')
    expect(recorded.at(-1)?.verification).toMatchObject({
      verdict: 'approved',
      verifierId: verifier.member.id,
      submittedRevision: submitted.revision,
    })
    expect(recorded.at(-1)?.verification?.reason).toMatch(/77/)
    const seated = events
      .flatMap(event => event.type === 'team/member' ? [event.data.member] : [])
      .filter(member => member.id === verifier.member.id)
    expect(seated.at(-1)).toMatchObject({ agentModel: VERIFIER_MODEL, phase: 'active' })
  }, 300_000)
})
