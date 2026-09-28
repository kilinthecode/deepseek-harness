import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { renderWorkerBrief, SubagentWorktrees } from '@deepseek-ai/dsh-subagent-worktree'
import type {
  ProvisionedWorktree,
  WorktreeId,
  WorktreeRecord,
  WorktreeRoute,
} from '@deepseek-ai/dsh-subagent-worktree'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { loadStoredSession } from '../../subagent/tests/persistence-helpers.ts'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  callSubagent,
  disposeSetupProvider,
  fakeAgent,
  modelSelectionSetupAgent,
  setup,
  testToolSignal,
  text,
} from './harness.ts'

/** Create a package-test context with the tool's required projection seam. */
async function projectedContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

/**
 * Drives the REAL plugin body: mounts `dsh-tool-subagent` on a real
 * `ToolRuntime` + `SubagentRuntime`, with a package-local scripted child
 * boundary, and invokes the registered `subagent` tool through
 * `ctx.tools.execute`. Everything downstream of the child boundary is the
 * shipping code path.
 */


describe('dsh-tool-subagent', () => {
  it('rejects continuable background policy when the provider cannot prepare continuable children', async () => {
    let failure: unknown
    try {
      await setup({
        provider: 'mock',
        backgroundMode: 'continuable',
      })
    } catch (error: unknown) {
      failure = error
    }
    expect(String(failure)).toContain(
      'provider "mock" does not support `backgroundMode: continuable`',
    )
  })

  it('rejects configured child agent options at mount when the provider cannot apply them', async () => {
    await expect(setup(
      { provider: 'mock', maxDepth: 'provider-managed', agentOptions: { model: 'configured-model' } },
      { capabilities: { agentOptions: false } },
    )).rejects.toThrow('does not support child agentOptions')
  })

  it('registers a `subagent` tool that delegates to the configured provider and returns its output', async () => {
    const ctx = await setup({ provider: 'mock' }, { reply: 'child says hi' })
    const result = await callSubagent(ctx, {
      description: 'do a thing',
      prompt: 'go research X',
      run_in_background: false,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected subagent success')
    expect(result.value).toEqual({
      kind: 'foreground',
      runId: 'scripted-subagent:mock:parent-1',
      output: [{ type: 'text', text: 'child says hi' }],
    })
    expect(text(result)).toBe('child says hi')
  })

  it('omits run_in_background entirely when the instance disables it (schema and capability never disagree)', async () => {
    const ctx = await setup({ provider: 'mock', enableRunInBackground: false })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual([
      'description',
      'prompt',
    ])
    expect(schema!.description).not.toContain('job_output')
  })

  it('refuses a forced run_in_background at execution time when the instance disables it', async () => {
    // Schema omission is advertising, not enforcement: the arg validator
    // allows undeclared keys, so the opt-out must also hold in execute().
    const ctx = await setup({ provider: 'mock', enableRunInBackground: false })
    const parentId = SessionId('sess-off')
    const parent = {
      id: parentId,
      inject: () => {},
      options: {},
      session: Session.create(parentId),
    } as unknown as Agent

    const forced = await callSubagent(ctx, { description: 'd', prompt: 'p', run_in_background: true }, { agent: parent })
    expect(forced.isError).toBe(true)
    expect(text(forced)).toContain('run_in_background is disabled for this tool instance')
    // The provider was never asked to start a child.
    expect(ctx.subagents.getProvider('mock')).toBeDefined()
    const foreground = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { agent: parent })
    expect(foreground.isError).toBe(false)
  })

  it('classifies foreground and background calls concurrency-safe (sibling delegations overlap)', async () => {
    const ctx = await setup({ provider: 'mock' })
    expect(ctx.tools.executionMode({
      signal: testToolSignal,
      callId: ToolCallId('subagent-foreground'),
      name: 'subagent',
      arguments: { description: 'do work', prompt: 'Reply OK' },
    })).toEqual({ kind: 'parallel' })
    expect(ctx.tools.executionMode({
      signal: testToolSignal,
      callId: ToolCallId('subagent-background'),
      name: 'subagent',
      arguments: { description: 'do work', prompt: 'Reply OK', run_in_background: true },
    })).toEqual({ kind: 'parallel' })
  })

  it('overlaps sibling foreground delegations dispatched concurrently', async () => {
    // Two children each block until both have started: hidden serialization
    // in the tool body, registry pipeline, or provider start path would
    // deadlock here instead of passing silently.
    const started: string[] = []
    let releaseBoth!: () => void
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve })
    const ctx = await setup({ provider: 'mock', enableRunInBackground: false }, {
      onStart: (request: SubagentStartRequest) => {
        started.push(request.label ?? '(unlabeled)')
        if (started.length === 2) releaseBoth()
        return bothStarted
      },
    })
    const results = await Promise.all([
      callSubagent(ctx, { description: 'first', prompt: 'p1' }),
      callSubagent(ctx, { description: 'second', prompt: 'p2' }),
    ])
    expect(started.sort()).toEqual(['first', 'second'])
    for (const result of results) expect(result.isError).toBe(false)
  })

  it.each([
    { stopReason: 'aborted' as const, fragment: 'cancelled' },
    { stopReason: 'error' as const, fragment: 'failed' },
    { stopReason: 'max-tokens' as const, fragment: 'token limit' },
    { stopReason: 'refusal' as const, fragment: 'declined' },
  ])('maps stop reason $stopReason to an isError result (not partial success)', async ({ stopReason, fragment }) => {
    const ctx = await setup({ provider: 'mock' }, { stopReason })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(fragment)
    // The failure is not partial success, but the child's preserved partial
    // answer still reaches the parent model inside the error result.
    expect(text(result)).toContain('scripted subagent reply')
  })

  it('renders provider diagnostics before preserved partial assistant output', async () => {
    const ctx = await setup({ provider: 'mock' }, {
      reply: 'partial assistant text',
      diagnostic: 'Claude Code denied a tool request',
      stopReason: 'error',
    })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: subagent run failed\n'
      + 'Diagnostic: Claude Code denied a tool request\n'
      + 'Partial output before the run ended:\npartial assistant text',
    )
  })

  it('registers under a configurable toolName so multiple providers can coexist', async () => {
    // The defining multi-provider use case: two loads, two distinct tool names,
    // each bound to a different provider — the tool registry rejects duplicate
    // names, so a configurable name is what makes this work.
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'spawn', reply: 'from spawn' })
    await mock.mountScriptedProvider(ctx, { name: 'acp', reply: 'from acp' })
    await ctx.plugin(tool, { provider: 'spawn', toolName: 'subagent' })
    await ctx.plugin(tool, { provider: 'acp', toolName: 'subagent_acp' })

    const names = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('subagent')).sort()
    expect(names).toEqual(['subagent', 'subagent_acp'])

    const viaSpawn = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c-spawn'), name: 'subagent', arguments: { description: 'd', prompt: 'p' }, agent: fakeAgent() })
    const viaAcp = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c-acp'), name: 'subagent_acp', arguments: { description: 'd', prompt: 'p' }, agent: fakeAgent() })
    expect(text(viaSpawn)).toBe('from spawn')
    expect(text(viaAcp)).toBe('from acp')
  })

  it('treats an unknown (plugin-added) stop reason as an isError result', async () => {
    // SubagentStopReason is merge-extensible; the tool's stopReasonError default
    // arm must treat an unrecognized terminal reason as a failure, not success.
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'weird',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('weird-child'),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'partial' }], stopReason: 'frobnicated' as never }),
        dispose: async () => {},
      }),
    })
    await ctx.plugin(tool, { provider: 'weird', maxDepth: 'provider-managed' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('abnormally')
  })

  it('merges model overrides over provider-owned route defaults before preflight', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: { reasoningEffort: ReasoningEffortId('high'), maxTokens: 321 },
      maxDepth: 'provider-managed',
    }, {
      agentRouteDefaults: { provider: 'alpha', model: 'child-model' },
      onStart: (request) => { seen = request },
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
    }))

    await callSubagent(ctx, {
      description: 'd',
      prompt: 'p',
      provider: 'alpha',
      model: 'child-model',
    })
    expect(ctx.tools.schemas(modelSelectionSetupAgent(ctx)).find(schema => schema.name === 'subagent')?.description)
      .toContain('this provider\'s route defaults')
    expect(seen?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'child-model',
      reasoningEffort: 'high',
      maxTokens: 321,
    })
  })

  it('does not inherit parent effort for a provider-owned route default', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      parentAgentOptions: {
        provider: 'alpha',
        model: 'child-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
      maxDepth: 'provider-managed',
    }, {
      agentRouteDefaults: { provider: 'alpha', model: 'child-model' },
      onStart: (request) => { seen = request },
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))
    const parent = modelSelectionSetupAgent(ctx)

    const result = await callSubagent(ctx, {
      description: 'd',
      prompt: 'p',
      provider: 'alpha',
      model: 'child-model',
    }, { agent: parent })

    if (result.isError) throw new Error(text(result))
    expect(result.isError).toBe(false)
    expect(seen?.agentOptions).toEqual({ provider: 'alpha', model: 'child-model' })
  })

  it('defaults toolName and omits agentOptions when apply() is called directly (schema bypass)', async () => {
    // `ctx.plugin` validates+defaults config first (toolName→'subagent', the
    // agentOptions object→{}), so the runtime `?? 'subagent'` fallback and the
    // no-agentOptions branch are only reachable via a direct apply() that
    // bypasses schemastery — the same pattern acp-agent uses for its defaults.
    let seen: { agentOptions?: unknown } | undefined
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'bare',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('bare-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    // Direct apply with only `provider` — no toolName, no agentOptions.
    tool.apply(ctx, { maxDepth: 'provider-managed', provider: 'bare' })
    await new Promise(r => setTimeout(r, 10))

    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.agentOptions).toBeUndefined()
  })

  it('fails loud when invoked without a calling agent', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('registers when the provider appears LATER — no load-order requirement (Loader starts siblings concurrently)', async () => {
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    // Tool first: no provider yet — the tool must be absent, not broken.
    // Direct apply (schema bypass): also covers the waiting-note's default
    // toolName fallback, which validated config pre-fills.
    tool.apply(ctx, { provider: 'mock' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)
    // Backend arrives (as a delayed sibling fiber would): the tool appears.
    await mock.mountScriptedProvider(ctx, { name: 'mock', reply: 'late but fine' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(text(result)).toBe('late but fine')
  })

  it('keeps continuable guidance empty while its provider is absent', async () => {
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    tool.apply(ctx, {
      provider: 'later-continuable',
      backgroundMode: 'continuable',
      maxDepth: 'provider-managed',
    })

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'tool:subagent')?.text).toBe('')
    expect(ctx.tools.schemas().some(schema => schema.name === 'subagent')).toBe(false)
  })

  it('mirrors the provider lifecycle: gone on backend dispose, re-derived wording on re-registration', async () => {
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    const backend = await mock.mountScriptedProvider(ctx, { name: 'mock' }) // fresh conversation (descriptor: false)
    await ctx.plugin(tool, { provider: 'mock' })
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('works in its own context')

    // Backend unloads (HMR shape): the tool must not outlive its provider.
    await backend.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)

    // Backend reloads with a DIFFERENT conversation-history descriptor: the wording is re-derived
    // from the fresh provider, not served stale from the first mount.
    await mock.mountScriptedProvider(ctx, { name: 'mock', inheritsParentContext: true })
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('inherits this conversation')
  })

  it('the tool PLUGIN fiber owns its lifecycle listeners: disposal unmounts, and a disposed fiber never zombie-mounts', async () => {
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)

    // Arm 1: a mounted tool and its prompt section die with the plugin fiber;
    // the provider survives.
    ctx.subagents.registerProvider({
      name: 'continuable',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('lifecycle test does not start a child') },
      prepareContinuable: async () => ({}),
    })
    const mounted = await ctx.plugin(tool, {
      provider: 'continuable',
      backgroundMode: 'continuable',
      maxDepth: 'provider-managed',
    })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'tool:subagent')).toBe(true)
    await mounted.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'tool:subagent')).toBe(false)
    expect(ctx.subagents.getProvider('continuable')).toBeDefined()

    // Arm 2: a fiber disposed while WAITING must not react to the provider
    // arriving later — a surviving listener would re-register a tool that no
    // live plugin owns (the zombie mount).
    const waiting = await ctx.plugin(tool, { provider: 'later', toolName: 'subagent_later' })
    await waiting.dispose()
    await mock.mountScriptedProvider(ctx, { name: 'later' })
    expect(ctx.tools.schemas().some(s => s.name === 'subagent_later')).toBe(false)
  })

  it('ignores lifecycle events for OTHER providers', async () => {
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock' })
    await ctx.plugin(tool, { provider: 'mock' })
    // An unrelated provider registering (added-event with another name) and
    // unregistering (removed-event with another name) must not touch the tool.
    const other = await mock.mountScriptedProvider(ctx, { name: 'other', inheritsParentContext: true })
    expect(ctx.tools.schemas().filter(s => s.name === 'subagent')).toHaveLength(1)
    expect(ctx.tools.schemas().find(s => s.name === 'subagent')!.description).toContain('works in its own context')
    await other.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'subagent')).toBe(true)
  })

  it('derives spawn-shaped wording from a fresh-conversation provider (default mock)', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    expect(schema.description).toContain('works in its own context')
    const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
    expect(props['prompt']!.description).toContain('include everything it needs')
  })

  it('derives inherited-context wording from a seeded-conversation provider', async () => {
    const ctx = await setup({
      provider: 'mock',
      toolName: 'subagent',
    }, { inheritsParentContext: true })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    expect(schema.description).toContain('inherits this conversation')
    expect(schema.description).not.toContain('does not see this conversation')
    expect(schema.description).not.toContain('can prevent provider-side reuse of the inherited conversation prefix')
    const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
    expect(props['prompt']!.description).toContain('completed turns')
  })

  it('disposes the run on the success path (no leaked child)', async () => {
    // Spy on the provider's run.dispose via a wrapping provider registered
    // directly on the service, then point the tool at it.
    const disposed = vi.fn()
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('spy-child'),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
        dispose: async () => void disposed(),
      }),
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('disposes the run on the error path too', async () => {
    const disposed = vi.fn()
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('spy-child'),
        localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'error' as const }),
        dispose: async () => void disposed(),
      }),
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('preserves independent foreground result and disposal failures', async () => {
    const disposed = vi.fn()
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('spy-child'),
        localAgent: undefined,
        result: Promise.reject(new Error('published run failed')),
        dispose: async () => {
          disposed()
          throw new Error('published handle disposal failed')
        },
      }),
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('published run failed')
    expect(text(result)).toContain('published handle disposal failed')
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('reports a foreground disposal failure after a completed result', async () => {
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async () => ({
        id: SessionId('spy-child'),
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: 'completed before disposal' }],
          stopReason: 'completed',
        }),
        dispose: () => Promise.reject(new Error('published handle disposal failed')),
      }),
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('published handle disposal failed')
  })

  it('passes the tool abort signal as the provider cancellation channel', async () => {
    const cancelled = vi.fn()
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async (request) => {
        if (request.signal.aborted) throw new Error('start aborted')
        let resolveResult: (r: { output: never[]; stopReason: 'aborted' }) => void
        const result = new Promise<{ output: never[]; stopReason: 'aborted' }>((res) => { resolveResult = res })
        request.signal.addEventListener('abort', () => {
          cancelled()
          resolveResult({ output: [], stopReason: 'aborted' })
        }, { once: true })
        return {
          id: SessionId('spy-child'),
          localAgent: undefined,
          result,
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const controller = new AbortController()
    const pending = callSubagent(ctx, { description: 'd', prompt: 'p' }, { signal: controller.signal })
    // Let provider.start install its listener before aborting.
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    const result = await pending
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
  })

  it('skips provider startup for an already-aborted signal', async () => {
    const sawAborted = vi.fn()
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'spy',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async (request) => {
        if (request.signal.aborted) sawAborted()
        throw new Error('start aborted')
      },
    })
    await ctx.plugin(tool, { provider: 'spy', maxDepth: 'provider-managed' })

    const controller = new AbortController()
    controller.abort() // already aborted BEFORE the tool runs
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' }, { signal: controller.signal })
    expect(sawAborted).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    })
  })

  it('tools depend on the service: no `subagent` tool without ctx.subagents', async () => {
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // No SubagentRuntime mounted. The tool injects its required services so its
    // apply never runs; the tool is absent rather than half-registered.
    let booted = true
    try {
      await ctx.plugin(tool, { provider: 'mock' })
      await new Promise(r => setTimeout(r, 20))
    } catch {
      booted = false
    }
    // Either it never booted, or it booted but registered no tool.
    const present = ctx.get('tools')?.schemas().some(s => s.name === 'subagent') ?? false
    expect(booted && present).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/Config/apply', () => {
    // Postmortem 0001 guard: this plugin HAS an explicit `inject`, so
    // a stray `export default apply` would collapse the module via
    // `unwrapExports` (`exports.default ?? exports`), DROP `inject`, and crash at
    // load with "cannot get property … without inject". Guard the shape directly.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent')
    expect(tool.inject).toEqual(['tools', 'subagents', 'systemPrompt', 'sessionProjections'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-subagent')
    expect(unwrapped.inject).toEqual(['tools', 'subagents', 'systemPrompt', 'sessionProjections'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })

  it('passes persona/toolFilter/maxDepth config through to the start request', async () => {
    let seen: { persona?: string; toolFilter?: unknown; maxDepth?: number } | undefined
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture2',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: true, toolFilter: true, persona: true, cwd: true },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('capture2-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, {
      provider: 'capture2',
      persona: 'You are the child.',
      toolFilter: { deny: ['subagent'] },
      maxDepth: 2,
    })

    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.persona).toBe('You are the child.')
    expect(seen?.toolFilter).toMatchObject({ deny: ['subagent'] })
    expect(seen?.maxDepth).toBe(2)
  })

  it.each([
    { label: 'a string', value: '1' as unknown as number },
    { label: 'NaN', value: Number.NaN },
    { label: 'positive infinity', value: Number.POSITIVE_INFINITY },
    { label: 'negative infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'a negative integer', value: -1 },
    { label: 'a fractional number', value: 1.5 },
    { label: 'negative zero', value: -0 },
    { label: 'an unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects maxDepth=$label when the plugin loads', async ({ value }) => {
    await expect(setup({ provider: 'mock', maxDepth: value }))
      .rejects.toThrow()
  })

  it('validates maxDepth when apply() is invoked directly without Schemastery', async () => {
    const ctx = await projectedContext()
    expect(() => {
      tool.apply(ctx, {
        provider: 'unused',
        maxDepth: Number.NaN,
      })
    }).toThrow('subagent maxDepth must be a non-negative safe integer')
  })

  it('a partial toolFilter (deny only) does not materialize an empty allow-list (deny-all trap)', async () => {
    let seen: { toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] } } | undefined
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture3',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: true, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('capture3-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture3', toolFilter: { deny: ['subagent'] }, maxDepth: 'provider-managed' })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen?.toolFilter).toEqual({ deny: ['subagent'] })
    expect(seen?.toolFilter).not.toHaveProperty('allow')
  })

  it('an omitted agentOptions does not materialize an empty object onto the request', async () => {
    // Same schemastery trap as toolFilter, adjacent field: an omitted
    // `agentOptions` config key materializes `{}` without the forced default,
    // which reads as present and puts a dishonest `agentOptions: {}` on every
    // start request.
    let seen: { agentOptions?: unknown } | undefined
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture4',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async (request) => {
        seen = request
        return {
          id: SessionId('capture4-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture4', maxDepth: 'provider-managed' })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(seen).toBeDefined()
    expect(seen).not.toHaveProperty('agentOptions')
  })

  it('an explicit empty toolFilter fails at plugin load, not at first delegation', async () => {
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'p',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: true, persona: false, cwd: false },
      inheritsParentContext: false,
      start: () => { throw new Error('unreachable') },
    })
    const fiber = ctx.plugin(tool, { provider: 'p', toolFilter: {} })
    await expect(fiber).rejects.toThrow(/names neither `allow` nor `deny`/)
  })
})

describe('dsh-tool-subagent background mode', () => {
  /** A live parent with a dedicated scope fiber for structural task cleanup. */
  async function ownerAgent(ctx: Context, sessionId: string, inject: (...args: unknown[]) => void = () => {}): Promise<Agent> {
    const scopeFiber = ctx.plugin(() => {})
    const id = SessionId(sessionId)
    const agent = {
      id,
      ctx: scopeFiber.ctx,
      inject,
      options: {},
      session: Session.create(id),
    } as unknown as Agent
    await ctx.agents.register(agent)
    return agent
  }

  async function backgroundSetup(toolConfig: tool.Config, mockConfig: Partial<mock.Config> = {}) {
    const ctx = await setup(toolConfig, mockConfig)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs, {})
    return ctx
  }

  it('keeps a continuable-capable provider one-shot when backgroundMode selects one-shot', async () => {
    const ctx = await backgroundSetup({ provider: 'mock' })
    const parent = await ownerAgent(ctx, 'sess-parent')
    let prepareCalls = 0
    ctx.subagents.registerProvider({
      name: 'resumable',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async request => ({
        id: SessionId('one-shot-child'),
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: 'one-shot answer' }],
          stopReason: request.signal.aborted ? 'aborted' : 'completed',
        }),
        dispose: () => Promise.resolve(),
      }),
      prepareContinuable: async () => {
        prepareCalls += 1
        throw new Error('one-shot policy must not prepare a continuable child')
      },
    })
    tool.apply(ctx, {
      provider: 'resumable',
      toolName: 'subagent_resumable',
      backgroundMode: 'one-shot',
      maxDepth: 'provider-managed',
    })

    const started = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('resumable-one-shot'),
      name: 'subagent_resumable',
      arguments: { description: 'work', prompt: 'go', run_in_background: true },
      agent: parent,
    })

    expect(text(started)).toBe('started background subagent job subagent-1')
    expect(prepareCalls).toBe(0)
  })

  it('returns a job id immediately and the answer is collected through job_output', async () => {
    const ctx = await backgroundSetup({ provider: 'mock' }, { reply: 'background answer' })
    const parent = await ownerAgent(ctx, 'sess-parent')

    const start = await callSubagent(ctx, { description: 'deep research', prompt: 'dig in', run_in_background: true }, { agent: parent })
    expect(start.isError).toBe(false)
    if (start.isError) throw new Error('expected background subagent success')
    expect(start.value).toEqual({ kind: 'background', jobId: 'subagent-1' })
    expect(text(start)).toBe('started background subagent job subagent-1')

    const collected = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('collect-1'),
      name: 'job_output',
      arguments: { job_id: 'subagent-1', wait: true },
      agent: parent,
    })
    expect(text(collected)).toBe('background answer\n[status: completed]')

    // The result rides the first read after settlement; a later read carries only the status.
    const again = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('collect-2'),
      name: 'job_output',
      arguments: { job_id: 'subagent-1' },
      agent: parent,
    })
    expect(text(again)).toBe('(no new output)\n[status: completed]')
  })

  it('preserves provider diagnostics in one-shot background failure detail', async () => {
    const ctx = await backgroundSetup({ provider: 'mock' }, {
      reply: 'not background output',
      diagnostic: 'Claude Code cancelled an unattended dialog',
      stopReason: 'error',
    })
    const parent = await ownerAgent(ctx, 'sess-parent')

    const started = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('diagnostic-background-start'),
      name: 'subagent',
      arguments: { description: 'd', prompt: 'p', run_in_background: true },
      agent: parent,
    })
    expect(text(started)).toBe('started background subagent job subagent-1')

    const output = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('diagnostic-background-output'),
      name: 'job_output',
      arguments: { job_id: 'subagent-1', wait: true },
      agent: parent,
    })
    expect(text(output)).toBe(
      '(no new output)\n'
      + '[status: failed, error; diagnostic: Claude Code cancelled an unattended dialog]',
    )
  })

  it('fails loud when the tasks runtime is not loaded', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', run_in_background: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('background jobs unavailable: load @deepseek-ai/dsh-jobs')
  })

  it('skips background startup when the tool signal is already aborted', async () => {
    const ctx = await backgroundSetup({ provider: 'mock' })
    const parent = await ownerAgent(ctx, 'sess-parent')
    const controller = new AbortController()
    controller.abort()
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', run_in_background: true }, { agent: parent, signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    })
    expect(text(result)).toBe('Error: tool call aborted before dispatch')
  })

  it('skips background startup when cancellation wins asynchronous route preflight', async () => {
    const ctx = await backgroundSetup({
      provider: 'mock',
      agentOptions: { provider: 'alpha', model: 'selected-model' },
    })
    const parent = await ownerAgent(ctx, 'sess-parent')
    const adapter = new MockAdapter([])
    let releasePreflight!: () => void
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve })
    const resolveModel = vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, model) => {
      await preflightGate
      return { provider, id: model, name: model }
    })
    ctx.llm.registerAdapter(['alpha'], adapter)
    const controller = new AbortController()

    const resultPromise = callSubagent(ctx, {
      description: 'cancelled selection',
      prompt: 'do it',
      run_in_background: true,
    }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(resolveModel).toHaveBeenCalledOnce() })
    controller.abort()
    releasePreflight()
    const result = await resultPromise

    expect(result.isError).toBe(true)
    expect(ctx.jobs.list(parent.id)).toEqual([])
  })

  it('rejects startup when the provider changes during asynchronous route preflight', async () => {
    const oldStart = vi.fn()
    const replacementStart = vi.fn(async (): Promise<never> => { throw new Error('replacement provider must not start') })
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
    }, {
      agentRouteDefaults: { provider: 'alpha', model: 'selected-model' },
      onStart: oldStart,
    })
    const adapter = new MockAdapter([])
    let releasePreflight!: () => void
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve })
    const resolveModel = vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, model) => {
      await preflightGate
      return { provider, id: model, name: model }
    })
    ctx.llm.registerAdapter(['alpha'], adapter)

    const pending = callSubagent(ctx, {
      description: 'swapped provider',
      prompt: 'do it',
      provider: 'alpha',
      model: 'selected-model',
    })
    await vi.waitFor(() => { expect(resolveModel).toHaveBeenCalledOnce() })
    await disposeSetupProvider(ctx)
    ctx.subagents.registerProvider({
      name: 'mock',
      capabilities: { agentOptions: true, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      agentRouteDefaults: { provider: 'beta', model: 'replacement-model' },
      start: replacementStart,
    })
    releasePreflight()

    const result = await pending
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('changed while resolving the child LLM route')
    expect(oldStart).not.toHaveBeenCalled()
    expect(replacementStart).not.toHaveBeenCalled()
  })

  it('settles an asynchronous provider-start failure as a failed task', async () => {
    const ctx = await backgroundSetup({ provider: 'mock' })
    const parent = await ownerAgent(ctx, 'sess-parent')
    ctx.subagents.registerProvider({
      name: 'broken-start',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('setup failed') },
    })
    tool.apply(ctx, { maxDepth: 'provider-managed', provider: 'broken-start', toolName: 'subagent_broken' })

    const started = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('broken-start'),
      name: 'subagent_broken',
      arguments: { description: 'broken', prompt: 'p', run_in_background: true },
      agent: parent,
    })
    expect(text(started)).toBe('started background subagent job subagent-1')
    const output = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('broken-output'),
      name: 'job_output',
      arguments: { job_id: 'subagent-1', wait: true },
      agent: parent,
    })
    expect(text(output)).toContain('[status: failed, Error: setup failed]')
  })

  it('kills a subagent task while provider readiness is still pending', async () => {
    const ctx = await backgroundSetup({ provider: 'mock' })
    const parent = await ownerAgent(ctx, 'sess-parent')
    ctx.subagents.registerProvider({
      name: 'pending-start',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: request => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { reject(new Error('startup aborted')) }, { once: true })
      }),
    })
    tool.apply(ctx, { maxDepth: 'provider-managed', provider: 'pending-start', toolName: 'subagent_pending' })

    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('pending-start'),
      name: 'subagent_pending',
      arguments: { description: 'pending', prompt: 'p', run_in_background: true },
      agent: parent,
    })
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('pending-kill'),
      name: 'job_kill',
      arguments: { job_id: 'subagent-1', reason: 'no longer needed' },
      agent: parent,
    })
    const output = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('pending-output'),
      name: 'job_output',
      arguments: { job_id: 'subagent-1', wait: true },
      agent: parent,
    })
    // The registry records the model's kill reason as the terminal detail.
    expect(text(output)).toBe('(no new output)\n[status: killed, no longer needed]')
  })

  it('reports startup rollback failure after cancellation as a failed job', async () => {
    const ctx = await backgroundSetup({ provider: 'mock' })
    const parent = await ownerAgent(ctx, 'sess-parent')
    ctx.subagents.registerProvider({
      name: 'broken-start-rollback',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: request => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new AggregateError(
            [new Error('startup aborted'), new Error('cleanup failed')],
            'startup failed and cleanup also failed',
          ))
        }, { once: true })
      }),
    })
    tool.apply(ctx, { maxDepth: 'provider-managed', provider: 'broken-start-rollback', toolName: 'subagent_broken_rollback' })

    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('broken-rollback-start'),
      name: 'subagent_broken_rollback',
      arguments: { description: 'broken rollback', prompt: 'p', run_in_background: true },
      agent: parent,
    })
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('broken-rollback-kill'),
      name: 'job_kill',
      arguments: { job_id: 'subagent-1' },
      agent: parent,
    })
    const output = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('broken-rollback-output'),
      name: 'job_output',
      arguments: { job_id: 'subagent-1', wait: true },
      agent: parent,
    })
    expect(text(output)).toContain('[status: failed, AggregateError: startup failed and cleanup also failed]')
  })

  it('forwards job_kill reasons through the run signal (and defaults one when absent)', async () => {
    // Use a provider that remains live until its signal is aborted.
    const ctx = await backgroundSetup({ provider: 'mock', agentOptions: { model: 'child-model' } })
    const parent = await ownerAgent(ctx, 'sess-parent')
    const cancels: (string | undefined)[] = []
    let starts = 0
    ctx.subagents.registerProvider({
      name: 'hanging',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async (request) => {
        let settle!: (value: { output: { type: 'text'; text: string }[]; stopReason: 'aborted' }) => void
        const id = SessionId(`hang-${++starts}`)
        const result = new Promise<{ output: { type: 'text'; text: string }[]; stopReason: 'aborted' }>((res) => { settle = res })
        request.signal.addEventListener('abort', () => {
          cancels.push(typeof request.signal.reason === 'string' ? request.signal.reason : undefined)
          settle({ output: [], stopReason: 'aborted' })
        }, { once: true })
        return {
          id,
          localAgent: undefined,
          result,
          dispose: () => Promise.resolve(),
        }
      },
    })
    // Direct apply preserves omitted agentOptions instead of applying schema defaults.
    tool.apply(ctx, { maxDepth: 'provider-managed', provider: 'hanging', toolName: 'subagent_hang' })

    const startOne = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('h1'), name: 'subagent_hang', arguments: { description: 'one', prompt: 'p', run_in_background: true }, agent: parent })
    const startTwo = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('h2'), name: 'subagent_hang', arguments: { description: 'two', prompt: 'p', run_in_background: true }, agent: parent })
    expect(text(startOne)).toBe('started background subagent job subagent-1')
    expect(text(startTwo)).toBe('started background subagent job subagent-2')

    const withReason = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('k1'), name: 'job_kill', arguments: { job_id: 'subagent-1', reason: 'superseded' }, agent: parent })
    const withoutReason = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('k2'), name: 'job_kill', arguments: { job_id: 'subagent-2' }, agent: parent })
    expect(text(withReason)).toBe('requested cancellation of job subagent-1')
    expect(text(withoutReason)).toBe('requested cancellation of job subagent-2')
    expect(cancels).toEqual(['superseded', 'background subagent task killed'])

    // The aborted children settle as killed tasks.
    const killed = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('w1'), name: 'job_output', arguments: { job_id: 'subagent-1', wait: true }, agent: parent })
    expect(text(killed)).toBe('(no new output)\n[status: killed, superseded]')
  })

})

describe('dsh-tool-subagent continuable background mode', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /** Boot the real continuable stack without any model-facing follow-up adapter. */
  async function continuableSetup() {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-tool-subagent-continuable-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs, {})
    await ctx.plugin(tool, { provider: 'spawn', backgroundMode: 'continuable' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      textResponse('continuable answer'),
    ]))
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    return { ctx, parent }
  }

  it('classifies continuable background calls concurrency-safe', async () => {
    const { ctx } = await continuableSetup()
    expect(ctx.tools.executionMode({
      signal: testToolSignal,
      callId: ToolCallId('subagent-continuable'),
      name: 'subagent',
      arguments: { description: 'do work', prompt: 'Reply OK' },
    })).toEqual({ kind: 'parallel' })
  })

  it('defaults continuable delegation to background and returns only its durable id', async () => {
    const { ctx, parent } = await continuableSetup()
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    // Continuable delegation has no Task, so the schema promises no collection.
    expect(schema.description).not.toContain('job_output')
    expect(schema.description).not.toContain('job_kill')
    expect(schema.description).toContain('send_message')
    expect(schema.description).toContain('you are notified when the run settles')
    expect(schema.description).not.toContain('send_message` starts a later turn')
    expect(schema.description).toContain('runs in the background by default')
    expect(schema.description).not.toContain('never poll or wait on it')
    const properties = (schema.parameters as {
      properties: Record<string, { description?: string }>
    }).properties
    expect(properties.run_in_background?.description).toContain('Defaults to true')
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(parent))
    const guidance = assembly.sections.find(section => section.name === 'tool:subagent')
    expect(guidance?.text).toContain('Start independent subagent delegations together')

    const started = await callSubagent(
      ctx,
      { description: 'continuable work', prompt: 'dig in' },
      { agent: parent },
    )
    expect(started.isError).toBe(false)
    const match = /^started subagent (\S+)$/.exec(text(started))
    expect(match).not.toBeNull()
    const [, childId] = match!
    // No Task was created for the continuable child.
    expect(ctx.jobs.list(parent.id)).toEqual([])

    await vi.waitFor(() => {
      expect(ctx.agents.get(SessionId(childId!))).toBeUndefined()
    }, { timeout: 5_000 })
    // The child id names a durable session carrying its continuation descriptor.
    const loaded = await loadStoredSession(ctx.sessionPersistence, SessionId(childId!))
    expect(loaded.events.some(event => event.type === 'subagent/descriptor')).toBe(true)
    expect(loaded.events.some(event => event.type === 'assistant/message')).toBe(true)
  })

  it('hides continuable guidance when the current agent cannot see the tool', async () => {
    const { ctx, parent } = await continuableSetup()
    parent.ctx.tools.restrict({ deny: ['subagent'] })

    expect(ctx.tools.get('subagent', parent)).toBeUndefined()
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(parent))
    expect(assembly.sections.find(section => section.name === 'tool:subagent')?.text).toBe('')
  })

  it('waits for a continuable provider only when run_in_background is explicitly false', async () => {
    const { ctx, parent } = await continuableSetup()
    const result = await callSubagent(
      ctx,
      { description: 'blocking work', prompt: 'dig in', run_in_background: false },
      { agent: parent },
    )
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected foreground subagent success')
    expect(result.value).toMatchObject({ kind: 'foreground' })
    expect(text(result)).toBe('continuable answer')
    expect(ctx.jobs.list(parent.id)).toEqual([])
  })

  it('isolates a cancelled continuable preparation from a concurrent sibling', async () => {
    const { ctx, parent } = await continuableSetup()
    const bothPreparing = Promise.withResolvers<undefined>()
    const releasePreparations = Promise.withResolvers<undefined>()
    const cancelled = new AbortController()
    let preparationCount = 0
    let cancelledChildId: ReturnType<typeof SessionId> | undefined
    let survivingChildId: ReturnType<typeof SessionId> | undefined
    ctx.subagents.registerProvider({
      name: 'gated',
      capabilities: { agentOptions: false, outputSchema: true, depthLimit: true, toolFilter: true, persona: true, cwd: true },
      inheritsParentContext: false,
      start: async () => { throw new Error('continuable policy must not start a one-shot child') },
      prepareContinuable: async (request) => {
        preparationCount += 1
        if (request.signal === cancelled.signal) cancelledChildId = request.sessionId
        else survivingChildId = request.sessionId
        if (preparationCount === 2) bothPreparing.resolve(undefined)
        await releasePreparations.promise
        return {}
      },
    })
    tool.apply(ctx, {
      provider: 'gated',
      toolName: 'subagent_gated',
      backgroundMode: 'continuable',
      maxDepth: 3,
    })

    const execute = (callId: string, description: string, signal: AbortSignal) => ctx.tools.execute({
      signal,
      callId: ToolCallId(callId),
      name: 'subagent_gated',
      arguments: { description, prompt: 'work', run_in_background: true },
      agent: parent,
    })
    const cancelledResult = execute('continuable-cancelled', 'cancelled sibling', cancelled.signal)
    const survivingResult = execute('continuable-surviving', 'surviving sibling', testToolSignal)
    await bothPreparing.promise
    cancelled.abort()
    releasePreparations.resolve(undefined)

    const [failed, succeeded] = await Promise.all([cancelledResult, survivingResult])
    expect(preparationCount).toBe(2)
    expect(failed.isError).toBe(true)
    expect(succeeded.isError).toBe(false)
    expect(cancelledChildId).toBeDefined()
    expect(survivingChildId).toBeDefined()
    expect(ctx.agents.get(cancelledChildId!)).toBeUndefined()
    await expect(loadStoredSession(ctx.sessionPersistence, cancelledChildId!)).rejects.toThrow(/not found/)

    expect(succeeded.isError ? undefined : succeeded.value).toEqual({
      kind: 'continuable',
      subagentId: survivingChildId,
    })
    await vi.waitFor(() => {
      expect(ctx.agents.get(survivingChildId!)).toBeUndefined()
    }, { timeout: 5_000 })
    const loaded = await loadStoredSession(ctx.sessionPersistence, survivingChildId!)
    expect(loaded.events.some(event => event.type === 'subagent/descriptor')).toBe(true)
    expect(loaded.events.some(event => event.type === 'assistant/message')).toBe(true)
  })

})

describe('background preflight failure (no orphaned child, by construction)', () => {
  it('never starts the child when tasks.start preflight throws', async () => {
    // With no job controller, preflight fails before the provider can spawn.
    const ctx = await setup({ provider: 'mock' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    const scopeFiber = ctx.plugin(() => {})
    const id = SessionId('sess-p')
    const parent = {
      id,
      ctx: scopeFiber.ctx,
      inject: () => {},
      options: {},
      session: Session.create(id),
    } as unknown as Agent
    await ctx.agents.register(parent)

    let starts = 0
    ctx.subagents.registerProvider({
      name: 'probe',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async () => {
        starts += 1
        return {
          id: SessionId('probe-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
          dispose: () => Promise.resolve(),
        }
      },
    })
    tool.apply(ctx, { maxDepth: 'provider-managed', provider: 'probe', toolName: 'subagent_probe' })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('probe-1'),
      name: 'subagent_probe',
      arguments: { description: 'd', prompt: 'p', run_in_background: true },
      agent: parent,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no job controller serves this agent')
    // Declare-then-execute: the failed preflight means no child ever existed.
    expect(starts).toBe(0)
  })
})

describe('depth budget configuration', () => {
  /** Mount the tool over a request-capturing provider with full capabilities. */
  async function captureSetup(config: Omit<tool.Config, 'provider'> = {}) {
    const requests: SubagentStartRequest[] = []
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'capture',
      capabilities: { agentOptions: false, outputSchema: true, depthLimit: true, toolFilter: true, persona: true, cwd: true },
      inheritsParentContext: false,
      start: async (request) => {
        requests.push(request)
        return {
          id: SessionId(`capture-child-${requests.length}`),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture', ...config })
    return { ctx, requests }
  }

  it('defaults maxDepth to 1 and forwards it in the start request', async () => {
    const { ctx, requests } = await captureSetup()
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(requests[0]?.label).toBe('d')
    expect(requests[0]?.maxDepth).toBe(1)
    expect(requests[0]?.toolFilter).toBeUndefined()
  })

  it('forwards an explicit tool filter unchanged instead of encoding the depth policy into it', async () => {
    const { ctx, requests } = await captureSetup({ toolFilter: { deny: ['dangerous'] }, maxDepth: 0 })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(requests[0]?.maxDepth).toBe(0)
    expect(requests[0]?.toolFilter).toEqual({ deny: ['dangerous'] })
  })

  it('rejects a numeric maxDepth on a provider without the depthLimit capability at mount', async () => {
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'no-depth',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('unreachable') },
    })
    await expect(ctx.plugin(tool, { provider: 'no-depth' }))
      .rejects.toThrow(/provider-managed/)
  })

  it("'provider-managed' omits the cap so a capability-less provider mounts and starts", async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'external',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: false },
      inheritsParentContext: false,
      start: async (request) => {
        requests.push(request)
        return {
          id: SessionId('external-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'external', maxDepth: 'provider-managed' })
    await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(requests[0]?.maxDepth).toBeUndefined()
    expect(requests[0]?.toolFilter).toBeUndefined()
  })
})

describe('subagent tool worktree isolation', () => {
  const workerRoute: WorktreeRoute = { provider: 'parent-provider', model: 'parent-model' }
  const reviewerRoute: WorktreeRoute = { provider: 'reviewer-provider', model: 'reviewer-model' }

  /** A parent Agent with the effective route and cwd the isolation executor requires. */
  function isolationParent(
    cwd: string,
    options: Agent['options'] = { provider: workerRoute.provider, model: workerRoute.model },
  ): Agent {
    const base = fakeAgent('isolation-parent')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: base.id,
      createdAt: 1_700_000_000_000,
      isSeeded: false,
      cwd,
    }
    return { ...base, options, session: Session.create(base.id, undefined, header) }
  }

  function fakeWorktreeRecord(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
    return {
      id: brandString<WorktreeId>('wt-aaaaaaaa'),
      repoRoot: '/repo',
      path: '/repo-worktrees/wt-aaaaaaaa',
      branch: 'dsh/worktree/wt-aaaaaaaa',
      baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      owner: { kind: 'session', sessionId: SessionId('isolation-parent') },
      label: 'd',
      task: 'the task',
      state: 'open',
      createdAt: 1_700_000_000_000,
      workerSessionIds: [],
      workerRoute,
      ...overrides,
    }
  }

  function fakeProvisioned(overrides: Partial<ProvisionedWorktree> = {}): ProvisionedWorktree {
    return {
      record: fakeWorktreeRecord(),
      // A real, always-present directory: the continuable path validates `cwd`
      // against the filesystem (`assertUsableCwd`), unlike the synthetic
      // foreground "capture" provider, which never inspects it.
      workDir: tmpdir(),
      ...overrides,
    }
  }

  const workerBriefFor = (provisioned: ProvisionedWorktree): string => renderWorkerBrief({
    workDir: provisioned.workDir,
    branch: provisioned.record.branch,
    baseCommit: provisioned.record.baseCommit,
    repoRoot: provisioned.record.repoRoot,
  })

  /**
   * A worktree-service shell with every method the executor calls stubbed, because the
   * real `@deepseek-ai/dsh-subagent-worktree` git implementation is developed in parallel.
   * `SubagentWorktrees.create/attach/resolveReviewer/discard` throw `not implemented`
   * bodies; constructing the real class and spying over its methods keeps `ctx.get`
   * resolution, injection typing, and the public contract real while faking only the
   * unimplemented behavior.
   */
  function installFakeWorktrees(ctx: Context): SubagentWorktrees {
    const worktrees = new SubagentWorktrees(ctx, {
      branchPrefix: 'test/',
      maxWorktrees: 4,
      requireDistinctReviewer: false,
      testCommand: [],
      reviewDiffMaxBytes: 4096,
      removeOnMerge: true,
    })
    vi.spyOn(worktrees, 'resolveReviewer').mockReturnValue(reviewerRoute)
    vi.spyOn(worktrees, 'create').mockResolvedValue(fakeProvisioned())
    vi.spyOn(worktrees, 'attach').mockImplementation(async request => fakeWorktreeRecord({
      workerSessionIds: [request.workerSessionId],
    }))
    vi.spyOn(worktrees, 'discard').mockResolvedValue(fakeWorktreeRecord({ state: 'discarded' }))
    return worktrees
  }

  /** Mount the tool over a request-capturing one-shot provider with the cwd capability. */
  async function foregroundCaptureSetup(config: Omit<tool.Config, 'provider' | 'worktreeIsolation'> = {}) {
    const requests: SubagentStartRequest[] = []
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    let startCount = 0
    ctx.subagents.registerProvider({
      name: 'capture',
      capabilities: { agentOptions: true, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: true },
      inheritsParentContext: false,
      start: async (request) => {
        requests.push(request)
        startCount += 1
        return {
          id: SessionId(`capture-child-${startCount}`),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
          dispose: async () => {},
        }
      },
    })
    await ctx.plugin(tool, { provider: 'capture', worktreeIsolation: true, maxDepth: 'provider-managed', ...config })
    return { ctx, requests }
  }

  const parent = isolationParent('/repo/packages/foo')

  it('omits the isolation parameter by default', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    const properties = (schema.parameters as { properties: Record<string, unknown> }).properties
    expect('isolation' in properties).toBe(false)
    await disposeSetupProvider(ctx)
  })

  it('exposes the isolation parameter, verbatim, when worktreeIsolation is enabled', async () => {
    const ctx = await setup({ provider: 'mock', worktreeIsolation: true })
    const schema = ctx.tools.schemas().find(s => s.name === 'subagent')!
    const properties = (schema.parameters as {
      properties: Record<string, { type: string; enum?: string[]; description?: string }>
    }).properties
    expect(properties.isolation).toEqual({
      type: 'string',
      enum: ['worktree'],
      description: 'Set to "worktree" to give the child its own git worktree, branched from your current commit, '
        + 'so parallel children cannot overwrite your files or each other\'s. Nothing it changes reaches your '
        + 'checkout until you call accept_worktree, which has an independent reviewer check the change before '
        + 'merging it. Omit to let the child work in your checkout.',
    })
    await disposeSetupProvider(ctx)
  })

  it('rejects the isolation argument at execute time when worktreeIsolation is disabled', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', isolation: 'worktree' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent: isolation is not enabled for this tool')
    await disposeSetupProvider(ctx)
  })

  it('throws when the subagent-worktree service is not loaded', async () => {
    const { ctx } = await foregroundCaptureSetup()
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', isolation: 'worktree' }, { agent: parent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent: worktree isolation requires the subagent-worktree service')
  })

  it("rejects isolation for a background job under backgroundMode: 'one-shot'", async () => {
    const { ctx } = await foregroundCaptureSetup()
    installFakeWorktrees(ctx)
    const result = await callSubagent(
      ctx,
      { description: 'd', prompt: 'p', isolation: 'worktree', run_in_background: true },
      { agent: parent },
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(
      "subagent: worktree isolation does not support a background job under backgroundMode: 'one-shot'",
    )
  })

  it('requires the parent session to have a working directory', async () => {
    const { ctx } = await foregroundCaptureSetup()
    installFakeWorktrees(ctx)
    const result = await callSubagent(
      ctx,
      { description: 'd', prompt: 'p', isolation: 'worktree' },
      { agent: fakeAgent('no-cwd-parent') },
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent: worktree isolation requires the parent session to have a working directory')
  })

  it('requires an effective provider and model to resolve a worktree route', async () => {
    const { ctx } = await foregroundCaptureSetup()
    installFakeWorktrees(ctx)
    const routeless = isolationParent('/repo/packages/foo', {})
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', isolation: 'worktree' }, { agent: routeless })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent: worktree isolation requires an effective provider and model')
  })

  it('calls resolveReviewer before create, and its throw prevents create', async () => {
    const { ctx } = await foregroundCaptureSetup()
    const worktrees = installFakeWorktrees(ctx)
    vi.spyOn(worktrees, 'resolveReviewer').mockImplementation(() => {
      throw new Error("the reviewer would run on the worker's route")
    })
    const createSpy = vi.spyOn(worktrees, 'create')

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', isolation: 'worktree' }, { agent: parent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("the reviewer would run on the worker's route")
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('resolves the worker route from configured child agentOptions, including its reasoning effort, over the parent route', async () => {
    // The scripted 'mock' provider (harness.ts) supports agentOptions and cwd,
    // and configuring a route requires the `llm` service to preflight it.
    const ctx = await setup({
      provider: 'mock',
      worktreeIsolation: true,
      agentOptions: { provider: 'configured-provider', model: 'configured-model', reasoningEffort: ReasoningEffortId('high') },
    })
    ctx.llm.registerAdapter(['configured-provider'], new MockAdapter([], {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
    }))
    const worktrees = installFakeWorktrees(ctx)
    const resolveReviewerSpy = vi.spyOn(worktrees, 'resolveReviewer')
    const attachSpy = vi.spyOn(worktrees, 'attach')

    const result = await callSubagent(ctx, { description: 'd', prompt: 'the task', isolation: 'worktree' }, { agent: parent })

    const configuredRoute: WorktreeRoute = {
      provider: 'configured-provider',
      model: 'configured-model',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect(result.isError).toBe(false)
    expect(resolveReviewerSpy).toHaveBeenCalledWith({ workerRoute: configuredRoute, callerRoute: workerRoute })
    expect(attachSpy).toHaveBeenCalledWith(expect.objectContaining({ workerRoute: configuredRoute }))
    await disposeSetupProvider(ctx)
  })

  it('propagates a non-isolated foreground start failure without attempting a discard', async () => {
    const { ctx } = await foregroundCaptureSetup()
    const worktrees = installFakeWorktrees(ctx)
    const discardSpy = vi.spyOn(worktrees, 'discard')
    ctx.subagents.registerProvider({
      name: 'failing3',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: true },
      inheritsParentContext: false,
      start: async () => { throw new Error('plain start failure') },
    })
    await ctx.plugin(tool, { provider: 'failing3', toolName: 'subagent_failing3', maxDepth: 'provider-managed' })

    // No `isolation` argument and no `worktreeIsolation` on this mount: the
    // ordinary non-isolated path must not touch the worktree service at all.
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('failing3-1'),
      name: 'subagent_failing3',
      arguments: { description: 'd', prompt: 'p' },
      agent: parent,
    })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('plain start failure')
    expect(discardSpy).not.toHaveBeenCalled()
  })

  it('passes the worktree cwd and brief-prefixed prompt to the foreground request, attaches the worker, and renders the worktree line', async () => {
    const { ctx, requests } = await foregroundCaptureSetup()
    const worktrees = installFakeWorktrees(ctx)
    const attachSpy = vi.spyOn(worktrees, 'attach')
    const resolveReviewerSpy = vi.spyOn(worktrees, 'resolveReviewer')

    const result = await callSubagent(ctx, { description: 'd', prompt: 'the task', isolation: 'worktree' }, { agent: parent })

    expect(resolveReviewerSpy).toHaveBeenCalledWith({ workerRoute, callerRoute: workerRoute })
    const provisioned = fakeProvisioned()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.cwd).toBe(provisioned.workDir)
    expect(requests[0]?.prompt).toEqual([{ type: 'text', text: `${workerBriefFor(provisioned)}the task` }])

    expect(attachSpy).toHaveBeenCalledWith({
      id: provisioned.record.id,
      owner: { kind: 'session', sessionId: parent.id },
      workerSessionId: SessionId('capture-child-1'),
      workerRoute,
    })

    expect(result.isError).toBe(false)
    expect(result.isError ? undefined : result.value).toMatchObject({
      kind: 'foreground',
      worktree: {
        id: provisioned.record.id,
        path: provisioned.record.path,
        branch: provisioned.record.branch,
        baseCommit: provisioned.record.baseCommit,
      },
    })
    expect(text(result)).toBe(
      `ok\nWorktree ${provisioned.record.id} (branch ${provisioned.record.branch}) holds this child's changes; `
      + 'call accept_worktree to review and merge them.',
    )
  })

  it('keeps the foreground render byte-identical when isolation is configured but not requested', async () => {
    const { ctx, requests } = await foregroundCaptureSetup()
    installFakeWorktrees(ctx)

    const result = await callSubagent(ctx, { description: 'd', prompt: 'the task' }, { agent: parent })

    expect(requests[0]?.cwd).toBeUndefined()
    expect(requests[0]?.prompt).toEqual([{ type: 'text', text: 'the task' }])
    expect(result.isError).toBe(false)
    expect(result.isError ? undefined : result.value).toEqual({ kind: 'foreground', runId: SessionId('capture-child-1'), output: [{ type: 'text', text: 'ok' }] })
    expect(text(result)).toBe('ok')
  })

  it('discards the fresh worktree, best effort, when the foreground start fails, and rethrows the original error', async () => {
    const { ctx } = await foregroundCaptureSetup()
    const worktrees = installFakeWorktrees(ctx)
    const discardSpy = vi.spyOn(worktrees, 'discard')
    const attachSpy = vi.spyOn(worktrees, 'attach')
    ctx.subagents.registerProvider({
      name: 'failing',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: true },
      inheritsParentContext: false,
      start: async () => { throw new Error('provider start failed') },
    })
    await ctx.plugin(tool, { provider: 'failing', toolName: 'subagent_failing', worktreeIsolation: true, maxDepth: 'provider-managed' })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('failing-1'),
      name: 'subagent_failing',
      arguments: { description: 'd', prompt: 'p', isolation: 'worktree' },
      agent: parent,
    })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('provider start failed')
    const provisioned = fakeProvisioned()
    expect(discardSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: provisioned.record.id,
      owner: { kind: 'session', sessionId: parent.id },
    }))
    expect(discardSpy.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
    expect(attachSpy).not.toHaveBeenCalled()
  })

  it('logs a warning, but still rethrows the original start failure, when the best-effort discard itself fails', async () => {
    const { ctx } = await foregroundCaptureSetup()
    const worktrees = installFakeWorktrees(ctx)
    vi.spyOn(worktrees, 'discard').mockRejectedValue(new Error('discard failed too'))
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.subagents.registerProvider({
      name: 'failing2',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false, cwd: true },
      inheritsParentContext: false,
      start: async () => { throw new Error('provider start failed') },
    })
    await ctx.plugin(tool, { provider: 'failing2', toolName: 'subagent_failing2', worktreeIsolation: true, maxDepth: 'provider-managed' })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('failing2-1'),
      name: 'subagent_failing2',
      arguments: { description: 'd', prompt: 'p', isolation: 'worktree' },
      agent: parent,
    })

    expect(result.isError).toBe(true)
    // The ORIGINAL failure reaches the caller; the discard failure is only logged.
    expect(text(result)).toContain('provider start failed')
    expect(text(result)).not.toContain('discard failed too')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('discard failed too'))
  })

  describe('continuable background isolation', () => {
    const roots: string[] = []
    afterEach(() => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })

    /** Boot the real continuable stack (spawn provider, which has the cwd capability) with isolation enabled. */
    async function continuableIsolationSetup() {
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      const root = mkdtempSync(path.join(tmpdir(), 'dsh-tool-subagent-worktree-'))
      roots.push(root)
      await ctx.plugin(JsonlSessionPersistence, { root })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
      await ctx.plugin(tool, { provider: 'spawn', backgroundMode: 'continuable', worktreeIsolation: true })
      ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('continuable answer')]))
      const worktrees = installFakeWorktrees(ctx)
      const routedParent = await ctx.agentLoop.create(
        SessionId('worktree-parent'),
        { provider: 'mock', model: 'mock' },
        { cwd: '/repo/packages/foo' },
      )
      return { ctx, parent: routedParent, worktrees }
    }

    it('passes the worktree cwd and brief-prefixed prompt to the continuable request, attaches the worker, and renders the worktree line', async () => {
      const { ctx, parent: routedParent, worktrees } = await continuableIsolationSetup()
      const attachSpy = vi.spyOn(worktrees, 'attach')

      const result = await callSubagent(
        ctx,
        { description: 'd', prompt: 'the task', isolation: 'worktree' },
        { agent: routedParent },
      )

      expect(result.isError).toBe(false)
      const provisioned = fakeProvisioned()
      expect(attachSpy).toHaveBeenCalledTimes(1)
      const attachCall = attachSpy.mock.calls[0]?.[0]
      expect(attachCall).toMatchObject({
        id: provisioned.record.id,
        owner: { kind: 'session', sessionId: routedParent.id },
        workerRoute: { provider: 'mock', model: 'mock' },
      })
      expect(result.isError ? undefined : result.value).toMatchObject({
        kind: 'continuable',
        worktree: {
          id: provisioned.record.id,
          path: provisioned.record.path,
          branch: provisioned.record.branch,
          baseCommit: provisioned.record.baseCommit,
        },
      })
      expect(attachCall?.workerSessionId).toBe(result.isError ? undefined : (result.value as { subagentId: unknown }).subagentId)
      expect(text(result)).toBe(
        `started subagent ${attachCall?.workerSessionId} in worktree ${provisioned.record.id} `
        + `(branch ${provisioned.record.branch}, base ${provisioned.record.baseCommit})`,
      )
    })

    it('appends the uncommitted-changes note when the worktree left base-checkout changes behind', async () => {
      const { ctx, parent: routedParent, worktrees } = await continuableIsolationSetup()
      vi.spyOn(worktrees, 'create').mockResolvedValue(fakeProvisioned({ baseDirty: { entries: ['M file.ts'], total: 1 } }))

      const result = await callSubagent(
        ctx,
        { description: 'd', prompt: 'the task', isolation: 'worktree' },
        { agent: routedParent },
      )

      expect(result.isError).toBe(false)
      expect(text(result)).toContain('Your checkout has 1 uncommitted change(s) that the worktree does not contain.')
    })

    it('discards the fresh worktree, best effort, when the continuable start fails', async () => {
      const { ctx, parent: routedParent, worktrees } = await continuableIsolationSetup()
      const discardSpy = vi.spyOn(worktrees, 'discard')
      const attachSpy = vi.spyOn(worktrees, 'attach')
      // A relative cwd fails the seam's own validation inside startContinuable,
      // after this tool has already created the worktree.
      vi.spyOn(worktrees, 'create').mockResolvedValue(fakeProvisioned({ workDir: 'relative/dir' }))

      const result = await callSubagent(
        ctx,
        { description: 'd', prompt: 'the task', isolation: 'worktree' },
        { agent: routedParent },
      )

      expect(result.isError).toBe(true)
      expect(text(result)).toContain('must be an absolute path')
      expect(discardSpy).toHaveBeenCalledWith(expect.objectContaining({
        id: fakeWorktreeRecord().id,
        owner: { kind: 'session', sessionId: routedParent.id },
      }))
      expect(discardSpy.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
      expect(attachSpy).not.toHaveBeenCalled()
    })
  })
})
