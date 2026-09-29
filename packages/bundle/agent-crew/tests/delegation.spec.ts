/**
 * One isolated delegation, end to end, through the agent-crew composition:
 * the lead calls `subagent` with `isolation: "worktree"`, a worker child edits
 * its own worktree, the lead calls `accept_worktree`, and an independent
 * reviewer child either passes the exact commit, which the harness merges into
 * the base repository, or fails it, which leaves the base repository alone and
 * the worktree open. It runs for the `dsh-base` `tool-subagent` row mounted at
 * the Host level, as a base-backed profile such as `headless` mounts it, in
 * each order of that row against the `subagent-worktree` service and the
 * worktree tools (the Loader starts sibling rows concurrently), and for the
 * `standard` Web preset's row mounted in a preset scope, whose row the bundle
 * patch cannot reach and which never sets `worktreeIsolation`.
 *
 * Real: git and `ctx.subprocess`, the `subagent-worktree` service at the
 * defaults `dsh-base` mounts it with, `tool-subagent` rows configured by the
 * shipped patch files, the tool registry, the agent loop, the `spawn`
 * provider, JSONL session persistence, and the reviewer's `structured_output`
 * capture. Stubbed: the model, which answers by role from the request, and the
 * worker's file tool, a `write_file` test tool standing in for the fs tools.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentWorktrees from '@deepseek-ai/dsh-subagent-worktree'
import type { Config as WorktreesConfig } from '@deepseek-ai/dsh-subagent-worktree'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import SubagentModelSelectionConfig from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import * as ToolSubagentWorktree from '@deepseek-ai/dsh-tool-subagent-worktree'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { git, initFixtureRepo, removeFixture } from '../../../subagent/subagent-worktree/tests/harness.ts'
import { hostToolSubagentConfig, presetToolSubagentConfig } from './patch-rows.ts'

const LEAD = SessionId('crew-lead')
const PROOF = 'crew-proof\n'

/** The reviewer's verdict on the worker's change. */
type Verdict = 'pass' | 'fail'

const REVIEWS: Record<Verdict, { verdict: Verdict; summary: string; checks: string[]; findings: string[] }> = {
  pass: {
    verdict: 'pass', summary: 'proof.txt matches the task', checks: ['read the diff: proof.txt was added'], findings: [],
  },
  fail: {
    verdict: 'fail',
    summary: 'proof.txt does not match the task',
    checks: ['read the diff: proof.txt was added'],
    findings: ['proof.txt lacks the crew-proof marker'],
  },
}

/**
 * A model that answers by role: the reviewer, recognized by its `structured_output` tool, gives its verdict on
 * the change; the worker writes `proof.txt`, then reports; the lead, woken when the worker settles, only
 * acknowledges. Answering by role keeps the script independent of the order in which the three agents call the
 * model.
 */
class CrewModel extends MockAdapter {
  constructor(private readonly verdict: Verdict) {
    super([])
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.answer(options)
  }

  private answer(options: GenerateOptions): StreamChunk[] {
    if (options.tools?.some(tool => tool.name === STRUCTURED_OUTPUT_TOOL) === true) {
      return toolCallResponse('review-1', STRUCTURED_OUTPUT_TOOL, REVIEWS[this.verdict])
    }
    if (options.sessionId === LEAD) return textResponse('noted')
    return JSON.stringify(options.messages).includes('write-1')
      ? textResponse('wrote proof.txt')
      : toolCallResponse('write-1', 'write_file', { path: 'proof.txt', content: PROOF })
  }
}

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
})

/**
 * Where the `tool-subagent` row is mounted: at the Host level after the service and before the worktree tools,
 * at the Host level before both, at the Host level after both, or inside an agent preset's scope.
 */
type Mount = 'host' | 'host-tool-first' | 'host-tool-last' | 'preset'

/** Mount the real stack and return the context with the lead agent working in `repoDir`. */
async function mountCrew(
  mount: Mount,
  verdict: Verdict,
  repoDir: string,
  worktreesRoot: string,
  sessionsRoot: string,
): Promise<{ ctx: Context; lead: Agent }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], new CrewModel(verdict))
  // The bundle only inserts the worktree tools, whose row registers the isolation offer: the service stays at its
  // defaults, and the tool row may mount before or after the offer exists.
  if (mount === 'host-tool-first') await ctx.plugin(ToolSubagent, hostToolSubagentConfig())
  await ctx.plugin(SubagentWorktrees, { root: worktreesRoot } as WorktreesConfig)
  if (mount === 'host') await ctx.plugin(ToolSubagent, hostToolSubagentConfig())
  await ctx.plugin(ToolSubagentWorktree)
  if (mount === 'host-tool-last') await ctx.plugin(ToolSubagent, hostToolSubagentConfig())
  ctx.tools.register(defineTool({
    name: 'write_file',
    description: 'Write a file under the calling agent\'s working directory.',
    parameters: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('write_file requires a calling agent with a working directory')
      writeFileSync(join(cwd, args.path), args.content)
      return Promise.resolve(`wrote ${args.path}`)
    },
  }))
  if (mount !== 'preset') {
    return { ctx, lead: await harness.create(LEAD, { provider: 'mock', model: 'mock' }, { cwd: repoDir }) }
  }
  // The preset row samples the Host model-selection setting, so the Host mounts it, off.
  await ctx.plugin(SubagentModelSelectionConfig, { enabled: false, allowedModels: [] })
  const preset = createScope(ctx, { preset: 'agent-crew-delegation' })
  await preset.ctx.plugin(ToolSubagent, presetToolSubagentConfig())
  const { agent } = await ctx.agents.create({
    sessionId: LEAD,
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: repoDir },
    setup: (agentCtx) => { bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!) },
  })
  return { ctx, lead: agent }
}

let calls = 0
function callTool(ctx: Context, lead: Agent, name: string, args: object) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`crew-call-${++calls}`),
    name,
    arguments: args,
    agent: lead,
  })
}

/** One isolated worker the lead started and that has finished writing into its worktree. */
interface StartedWorker {
  ctx: Context
  lead: Agent
  repoDir: string
  /** The base repository's HEAD before the delegation. */
  baseHead: string
  subagentId: string
  worktree: { id: string; path: string; branch: string }
}

/**
 * Mount the crew, have the lead delegate one part into its own worktree as a background child, and wait until the
 * worker has written its file and stopped.
 * @param mount - where the `tool-subagent` row is mounted.
 * @param verdict - what the reviewer will say when the lead accepts.
 * @returns the started worker.
 */
async function startWorker(mount: Mount, verdict: Verdict): Promise<StartedWorker> {
  const repoDir = await initFixtureRepo('dsh-crew-repo-')
  cleanups.push(() => removeFixture(repoDir))
  writeFileSync(join(repoDir, 'README.md'), 'base\n')
  git(repoDir, 'add', 'README.md')
  git(repoDir, 'commit', '-q', '-m', 'base')
  const baseHead = git(repoDir, 'rev-parse', 'HEAD').trim()
  const worktreesRoot = await mkdtemp(join(tmpdir(), 'dsh-crew-worktrees-'))
  cleanups.push(() => removeFixture(worktreesRoot))
  const sessionsRoot = await mkdtemp(join(tmpdir(), 'dsh-crew-sessions-'))
  cleanups.push(() => removeFixture(sessionsRoot))
  const { ctx, lead } = await mountCrew(mount, verdict, repoDir, worktreesRoot, sessionsRoot)

  const started = await callTool(ctx, lead, 'subagent', {
    description: 'add proof',
    prompt: 'Add proof.txt containing "crew-proof".',
    isolation: 'worktree',
  })
  if (started.isError) throw new Error(`subagent failed: ${JSON.stringify(started)}`)
  const { subagentId, worktree } = started.value as {
    kind: 'continuable'
    subagentId: string
    worktree: { id: string; path: string; branch: string }
  }
  expect(started.value).toMatchObject({ kind: 'continuable', worktree: { id: expect.stringMatching(/^wt-[0-9a-f]{8}$/) as string } })

  // The worker writes into its worktree; nothing reaches the lead's checkout.
  await vi.waitFor(() => {
    expect(existsSync(join(worktree.path, 'proof.txt'))).toBe(true)
    expect(ctx.agents.get(SessionId(subagentId))?.status).not.toBe('running')
  }, { timeout: 15_000, interval: 25 })
  expect(readFileSync(join(worktree.path, 'proof.txt'), 'utf8')).toBe(PROOF)
  expect(existsSync(join(repoDir, 'proof.txt'))).toBe(false)
  expect(git(repoDir, 'status', '--porcelain')).toBe('')
  return { ctx, lead, repoDir, baseHead, subagentId, worktree }
}

describe.each<Mount>(['host', 'host-tool-first', 'host-tool-last', 'preset'])(
  'agent-crew delegation through a %s-mounted tool-subagent row',
  (mount) => {
    it('lands a worker\'s file in the base repository only after the reviewer passes the exact commit', async () => {
      const { ctx, lead, repoDir, subagentId, worktree } = await startWorker(mount, 'pass')

      // The lead lists the open worktree with its worker, then accepts it.
      const listed = await callTool(ctx, lead, 'list_worktrees', {})
      expect(listed.isError ? '' : listed.value).toEqual([
        expect.objectContaining({ id: worktree.id, state: 'open', workerAgentId: subagentId, path: worktree.path }),
      ])
      const accepted = await callTool(ctx, lead, 'accept_worktree', { worktree_id: worktree.id })
      if (accepted.isError) throw new Error(`accept_worktree failed: ${JSON.stringify(accepted)}`)
      expect(accepted.value).toMatchObject({
        kind: 'merged',
        id: worktree.id,
        reviewer: { provider: 'mock', model: 'mock' },
        summary: 'proof.txt matches the task',
      })
      const { mergeCommit, commit } = accepted.value as { mergeCommit: string; commit: string }

      // The base repository holds a --no-ff merge of the reviewed commit, with the worker's file, and the worktree is gone.
      expect(git(repoDir, 'rev-parse', 'HEAD').trim()).toBe(mergeCommit)
      expect(git(repoDir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
      expect(git(repoDir, 'merge-base', '--is-ancestor', commit, 'HEAD')).toBe('')
      expect(readFileSync(join(repoDir, 'proof.txt'), 'utf8')).toBe(PROOF)
      expect(git(repoDir, 'status', '--porcelain')).toBe('')
      expect(existsSync(worktree.path)).toBe(false)
      expect(git(repoDir, 'branch', '--list', worktree.branch)).toBe('')
    }, 60_000)

    it('rejects the change and leaves the base repository unchanged and the worktree open when the reviewer fails it', async () => {
      const { ctx, lead, repoDir, baseHead, subagentId, worktree } = await startWorker(mount, 'fail')

      const accepted = await callTool(ctx, lead, 'accept_worktree', { worktree_id: worktree.id })
      if (accepted.isError) throw new Error(`accept_worktree failed: ${JSON.stringify(accepted)}`)
      expect(accepted.value).toMatchObject({
        kind: 'rejected',
        id: worktree.id,
        reviewer: { provider: 'mock', model: 'mock' },
        summary: 'proof.txt does not match the task',
        findings: ['proof.txt lacks the crew-proof marker'],
      })

      // Nothing reached the base repository, whose branch and checkout are as they were.
      expect(git(repoDir, 'rev-parse', 'HEAD').trim()).toBe(baseHead)
      expect(existsSync(join(repoDir, 'proof.txt'))).toBe(false)
      expect(git(repoDir, 'status', '--porcelain')).toBe('')
      // The worktree and its branch stay, open, for the worker to fix and the lead to accept again.
      expect(existsSync(worktree.path)).toBe(true)
      expect(git(repoDir, 'branch', '--list', worktree.branch)).toContain(worktree.branch)
      const listed = await callTool(ctx, lead, 'list_worktrees', {})
      expect(listed.isError ? '' : listed.value).toEqual([
        expect.objectContaining({ id: worktree.id, state: 'open', workerAgentId: subagentId, path: worktree.path }),
      ])
    }, 60_000)
  },
)
