/**
 * Real composition: the actual production reviewer path — real `AgentLoop`,
 * real `spawn`-in-process provider, real structured-output capture — behind a
 * scripted (keyless) model adapter standing in for the network LLM boundary.
 * Not a unit test: this is what proves `runReviewer`'s `ctx.subagents.start`
 * call and `outputSchema` wiring work against the shipping subagent stack,
 * not only against this package's own scripted-reviewer fixture.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentWorktrees from '../src/index.ts'
import { git, initFixtureRepo, removeFixture } from './harness.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const signal = new AbortController().signal
const OPERATOR = { kind: 'operator' as const }

type Script = ConstructorParameters<typeof MockAdapter>[0]

/**
 * Real subagent + agent-loop stack, a scripted model adapter under provider
 * `mock`, and the real `spawn` provider. `requireDistinctReviewer` is off:
 * the only registered model here is `mock`, so the reviewer necessarily runs
 * on the same route as the accepting caller; independence itself is covered
 * by `resolveReviewer`'s own focused tests in subagent-worktree.spec.ts.
 */
async function realHarness(root: string, script: Script): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  await ctx.plugin(SubagentWorktrees, {
    root, branchPrefix: 'dsh/worktree/', maxWorktrees: 16, requireDistinctReviewer: false, testCommand: [],
    reviewDiffMaxBytes: 8192, removeOnMerge: true,
  })
  const parent = await ctx.agentLoop.create(SessionId('operator'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

describe('real composition: reviewer through the shipping subagent stack', () => {
  it('merges a change the real reviewer child passes via a real structured_output capture', async () => {
    const dir = await initFixtureRepo('dsh-e2e-worktree-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-root-'))
    cleanups.push(() => removeFixture(root))

    const { ctx, parent } = await realHarness(root, [
      toolCallResponse('review-1', STRUCTURED_OUTPUT_TOOL, {
        verdict: 'pass', summary: 'the change matches the task', checks: ['read the diff: matches the task'], findings: [],
      }),
    ])

    const provisioned = await ctx.subagentWorktrees.create({
      owner: OPERATOR, baseDir: dir, label: 'add proof.txt', task: 'add proof.txt containing "real-reviewer-proof"', workerRoute: { provider: 'mock', model: 'mock' }, signal,
    })
    await writeFile(join(provisioned.workDir, 'proof.txt'), 'real-reviewer-proof')

    const outcome = await ctx.subagentWorktrees.accept({ id: provisioned.record.id, owner: OPERATOR, parent, signal })
    expect(outcome.kind).toBe('merged')
    if (outcome.kind !== 'merged') throw new Error('unreachable')
    expect(outcome.verdict.summary).toBe('the change matches the task')
    expect(outcome.verdict.reviewerRoute).toEqual({ provider: 'mock', model: 'mock' })
  }, 30_000)

  it('rejects (fails closed) when the real reviewer child never calls structured_output', async () => {
    const dir = await initFixtureRepo('dsh-e2e-worktree-nofail-')
    cleanups.push(() => removeFixture(dir))
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-root-nofail-'))
    cleanups.push(() => removeFixture(root))

    const { ctx, parent } = await realHarness(root, [textResponse('I looked at it and it seems fine.')])

    const provisioned = await ctx.subagentWorktrees.create({
      owner: OPERATOR, baseDir: dir, label: 'add proof.txt', task: 'add proof.txt', workerRoute: { provider: 'mock', model: 'mock' }, signal,
    })
    await writeFile(join(provisioned.workDir, 'proof.txt'), 'proof')

    const outcome = await ctx.subagentWorktrees.accept({ id: provisioned.record.id, owner: OPERATOR, parent, signal })
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind !== 'rejected') throw new Error('unreachable')
    expect(outcome.verdict.findings).toEqual(['the reviewer returned no structured verdict'])
  }, 30_000)
})
