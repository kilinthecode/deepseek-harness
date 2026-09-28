/**
 * One isolated delegation, end to end, through the agent-crew composition:
 * the lead calls `subagent` with `isolation: "worktree"`, a worker child edits
 * its own worktree, the lead calls `accept_worktree`, an independent reviewer
 * child passes the exact commit, and the harness merges it into the base
 * repository. It runs twice: with the `dsh-base` `tool-subagent` row mounted at
 * the Host level, as a base-backed profile such as `headless` mounts it, and
 * with the `standard` Web preset's row mounted in a preset scope, whose row the
 * bundle patch cannot reach and which never sets `worktreeIsolation`.
 *
 * Real: git and `ctx.subprocess`, the `subagent-worktree` service configured
 * by the agent-crew patch, `tool-subagent` rows configured by the shipped
 * patch files, the tool registry, the agent loop, the `spawn` provider, JSONL
 * session persistence, and the reviewer's `structured_output` capture.
 * Stubbed: the model, which answers by role from the request, and the
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
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import SubagentModelSelectionConfig from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import * as ToolSubagentWorktree from '@deepseek-ai/dsh-tool-subagent-worktree'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { git, initFixtureRepo, removeFixture } from '../../../subagent/subagent-worktree/tests/harness.ts'
import { crewWorktreesConfig, hostToolSubagentConfig, presetToolSubagentConfig } from './patch-rows.ts'

const LEAD = SessionId('crew-lead')
const PROOF = 'crew-proof\n'

/**
 * A model that answers by role: the reviewer, recognized by its `structured_output` tool, passes the change; the
 * worker writes `proof.txt`, then reports; the lead, woken when the worker settles, only acknowledges. Answering
 * by role keeps the script independent of the order in which the three agents call the model.
 */
class CrewModel extends MockAdapter {
  constructor() {
    super([])
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.answer(options)
  }

  private answer(options: GenerateOptions): StreamChunk[] {
    if (options.tools?.some(tool => tool.name === STRUCTURED_OUTPUT_TOOL) === true) {
      return toolCallResponse('review-1', STRUCTURED_OUTPUT_TOOL, {
        verdict: 'pass', summary: 'proof.txt matches the task', checks: ['read the diff: proof.txt was added'], findings: [],
      })
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

/** Where the `tool-subagent` row is mounted: at the Host level, or inside an agent preset's scope. */
type Mount = 'host' | 'preset'

/** Mount the real stack and return the context with the lead agent working in `repoDir`. */
async function mountCrew(
  mount: Mount,
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
  ctx.llm.registerAdapter(['mock'], new CrewModel())
  // The service row before the tool row, as the tool reads the service's isolation switch when it mounts.
  await ctx.plugin(SubagentWorktrees, crewWorktreesConfig({ root: worktreesRoot }))
  if (mount === 'host') await ctx.plugin(ToolSubagent, hostToolSubagentConfig())
  await ctx.plugin(ToolSubagentWorktree)
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
  if (mount === 'host') {
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

describe.each<Mount>(['host', 'preset'])('agent-crew delegation through a %s-mounted tool-subagent row', (mount) => {
  it('lands a worker\'s file in the base repository only after the reviewer passes the exact commit', async () => {
    const repoDir = await initFixtureRepo('dsh-crew-repo-')
    cleanups.push(() => removeFixture(repoDir))
    writeFileSync(join(repoDir, 'README.md'), 'base\n')
    git(repoDir, 'add', 'README.md')
    git(repoDir, 'commit', '-q', '-m', 'base')
    const worktreesRoot = await mkdtemp(join(tmpdir(), 'dsh-crew-worktrees-'))
    cleanups.push(() => removeFixture(worktreesRoot))
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'dsh-crew-sessions-'))
    cleanups.push(() => removeFixture(sessionsRoot))
    const { ctx, lead } = await mountCrew(mount, repoDir, worktreesRoot, sessionsRoot)

    // The lead delegates one part into its own worktree, as a background child.
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
})
