import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'
import {
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  assertValidDefaultChildRoute,
  defaultChildRouteAllowed,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from '../src/model-selection.ts'
import type { DefaultChildRoute } from '../src/model-selection.ts'
import { callSubagent, modelSelectionSetupAgent, setup, testToolSignal, text } from './harness.ts'

const REASONING = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
} as const

function parentWithRoute(
  options: Agent['options'] = {
    provider: 'alpha',
    model: 'parent-model',
    reasoningEffort: ReasoningEffortId('high'),
  },
): Agent {
  const id = SessionId('parent-with-route')
  return { id, options, session: Session.create(id) } as unknown as Agent
}

describe('dsh-tool-subagent model selection', () => {
  it('rejects empty route ids at the configuration boundary', () => {
    expect(() => { assertAllowedModelRoutes([{ provider: '', model: 'model' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertAllowedModelRoutes([{ provider: 'provider', model: '' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertAllowedModelRoutes({ provider: 'provider', model: 'model' }) })
      .toThrow('requires an array of routes')
    expect(() => { assertAllowedModelRoutes([{ provider: 1, model: 'model' }]) })
      .toThrow('requires non-empty provider and model ids')
  })

  it('validates a default child route\'s shape and its membership in the allowed routes', () => {
    expect(() => { assertValidDefaultChildRoute(null) }).not.toThrow()
    expect(() => { assertValidDefaultChildRoute({ provider: 'alpha', model: 'fast-model' }) }).not.toThrow()
    expect(() => { assertValidDefaultChildRoute({ provider: '', model: 'fast-model' }) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertValidDefaultChildRoute({ provider: 'alpha', model: '' }) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertValidDefaultChildRoute({ provider: 'alpha', model: 'fast-model', reasoningEffort: '' }) })
      .toThrow('requires a non-empty reasoning effort when set')
    expect(() => { assertValidDefaultChildRoute({ provider: 'alpha', model: 'fast-model', reasoningEffort: 'max' }) })
      .not.toThrow()
    expect(() => { assertValidDefaultChildRoute('alpha/fast-model') })
      .toThrow('requires non-empty provider and model ids')

    const allowed = [{ provider: 'alpha', model: 'fast-model' }, { provider: 'beta', model: 'other-model' }]
    expect(defaultChildRouteAllowed({ provider: 'alpha', model: 'fast-model' }, allowed)).toBe(true)
    expect(defaultChildRouteAllowed({ provider: 'alpha', model: 'other-model' }, allowed)).toBe(false)
  })

  it('allows pure inheritance but rejects explicit values outside a Session allowlist', () => {
    const policy = {
      routes: [{ provider: 'alpha', model: 'allowed-model' }],
    }
    const parent = { provider: 'alpha', model: 'parent-model' }

    expect(() => { assertAllowedModelSelection(policy, parent, undefined, {}) }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(
        policy,
        parent,
        { provider: 'alpha', model: 'allowed-model' },
        { provider: 'alpha', model: 'allowed-model' },
      )
    }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(
        policy,
        parent,
        { provider: 'alpha', model: 'other-model' },
        { provider: 'alpha', model: 'other-model' },
      )
    }).toThrow('is not allowed for this Session')
    expect(() => {
      assertAllowedModelSelection(
        policy,
        parent,
        { reasoningEffort: ReasoningEffortId('low') },
        { reasoning_effort: 'low' },
      )
    }).toThrow('alpha/parent-model')
    expect(() => {
      assertAllowedModelSelection(
        policy,
        {},
        { reasoningEffort: ReasoningEffortId('low') },
        { reasoning_effort: 'low' },
      )
    }).toThrow('without an effective provider and model')
  })

  it('leaves deployment or parent defaults outside the allowlist usable when the call selects nothing', async () => {
    let starts = 0
    const ctx = await setup(
      { provider: 'mock', withModelSelection: true },
      { onStart: () => { starts += 1 } },
    )
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = {
      provider: 'deployment-provider',
      model: 'deployment-model',
    }

    const result = await callSubagent(ctx, { description: 'default route', prompt: 'do it' })

    expect(result.isError).toBe(false)
    expect(starts).toBe(1)
  })
  it('exposes Session-authorized route fields and discovery when selection is enabled', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    const agent = modelSelectionSetupAgent(ctx)
    const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual([
      'description',
      'model',
      'prompt',
      'provider',
      'reasoning_effort',
      'run_in_background',
    ])
    expect(schema.description).toContain('list_subagent_models')
    expect(ctx.tools.get('list_subagent_models', agent)).toBeDefined()
    expect(schema.description).not.toContain('alpha')

    const registration = ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))
    const definition = ctx.tools.get('subagent', agent)
    registration.replace(['beta'])
    expect(ctx.tools.get('subagent', agent)).toBe(definition)
    expect(definition?.description).not.toContain('beta')
  })

  it('hides and rejects route fields when selection is disabled', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(entry => entry.name === 'subagent')!
    const props = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['description', 'prompt', 'run_in_background'])
    expect(schema.description).not.toContain('list_subagent_models')
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()

    const result = await callSubagent(ctx, {
      description: 'forced route',
      prompt: 'do it',
      provider: 'alpha',
      model: 'fast-model',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('child model selection is disabled for this tool instance')
  })

  it('rejects enabled model selection when the provider cannot apply Agent options', async () => {
    await expect(setup(
      { provider: 'mock', withModelSelection: true, maxDepth: 'provider-managed' },
      { capabilities: { agentOptions: false } },
    )).rejects.toThrow('provider "mock" does not support child model selection')
  })

  it('selects an unlisted complete route and clears a configured effort when the route changes', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: {
        provider: 'alpha',
        model: 'configured-model',
        reasoningEffort: ReasoningEffortId('high'),
        maxTokens: 321,
      },
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = parentWithRoute().options

    const selected = await callSubagent(ctx, {
      description: 'route work',
      prompt: 'do it',
      provider: 'alpha',
      model: 'unlisted-model',
    })
    expect(selected.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'unlisted-model',
      maxTokens: 321,
    })

    const effort = await callSubagent(ctx, {
      description: 'same route effort',
      prompt: 'do it',
      provider: 'alpha',
      model: 'configured-model',
      reasoning_effort: 'low',
    })
    expect(effort.isError).toBe(false)
    expect(requests[1]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'configured-model',
      reasoningEffort: 'low',
      maxTokens: 321,
    })
  })

  it('accepts an effort-only override for the effective configured or parent route', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: { provider: 'alpha' },
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = parentWithRoute().options

    const result = await callSubagent(ctx, {
      description: 'effort work',
      prompt: 'do it',
      reasoning_effort: 'low',
    })
    expect(result.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({ provider: 'alpha', reasoningEffort: 'low' })

    const inherited = await setup({ provider: 'mock', withModelSelection: true })
    inherited.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const inheritedParent = modelSelectionSetupAgent(inherited)
    ;(inheritedParent as { options: Agent['options'] }).options = parentWithRoute().options
    const inheritedResult = await callSubagent(inherited, {
      description: 'parent effort work',
      prompt: 'do it',
      reasoning_effort: 'low',
    })
    expect(inheritedResult.isError).toBe(false)
  })

  it('inherits a parent effort only when an explicit route stays unchanged', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = parentWithRoute().options
    const result = await callSubagent(ctx, {
      description: 'same route work',
      prompt: 'do it',
      provider: 'alpha',
      model: 'parent-model',
    })
    expect(result.isError).toBe(false)
  })

  it('compares explicit routes with the latest logged parent selection', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      agentOptions: { reasoningEffort: ReasoningEffortId('high') },
    }, { onStart: (request) => { requests.push(request) } })
    ctx.llm.registerAdapter(['current-provider'], new MockAdapter([], REASONING))
    const parent = modelSelectionSetupAgent(ctx)
    ;(parent as { options: Agent['options'] }).options = {
      provider: 'created-provider', model: 'created-model',
    }
    parent.session.append('request/header', {
      header: { config: { provider: 'current-provider', model: 'current-model' } },
      reason: 'initial',
    })

    const result = await callSubagent(ctx, {
      description: 'same current route',
      prompt: 'do it',
      provider: 'current-provider',
      model: 'current-model',
    })

    expect(result.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'high',
    })
  })

  it('rejects an effort without any effective route', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    const result = await callSubagent(ctx, {
      description: 'missing route',
      prompt: 'do it',
      reasoning_effort: 'low',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('without an effective provider and model')
  })

  it('rejects preflight without an effective provider and model', async () => {
    const ctx = await setup({ provider: 'mock' })
    await expect(preflightChildLlmRoute(ctx.llm, {}, undefined, AbortSignal.abort()))
      .rejects.toThrow('without an effective provider and model')
  })

  it.each([
    { provider: 'alpha' },
    { model: 'fast-model' },
  ])('rejects a partial model-facing route before child creation', async (route) => {
    let starts = 0
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: () => { starts += 1 } })
    const result = await callSubagent(ctx, { description: 'partial route', prompt: 'do it', ...route })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`provider` and `model` must be supplied together')
    expect(starts).toBe(0)
  })

  it.each([
    { provider: '', model: 'fast-model', expected: '`provider` must be non-empty' },
    { provider: 'alpha', model: '', expected: '`model` must be non-empty' },
    { reasoning_effort: '', expected: '`reasoning_effort` must be non-empty' },
  ])('rejects empty model-facing values', async ({ expected, ...selection }) => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    const result = await callSubagent(ctx, { description: 'empty route', prompt: 'do it', ...selection })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(expected)
  })

  it('uses the LLM runtime for provider and reasoning-effort validation before child creation', async () => {
    let starts = 0
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: () => { starts += 1 } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))

    const unsupported = await callSubagent(ctx, {
      description: 'bad effort',
      prompt: 'do it',
      provider: 'alpha',
      model: 'fast-model',
      reasoning_effort: 'max',
    })
    expect(unsupported.isError).toBe(true)
    expect(text(unsupported)).toContain('does not support reasoning effort "max"')

    const missing = await callSubagent(ctx, {
      description: 'bad provider',
      prompt: 'do it',
      provider: 'missing',
      model: 'fast-model',
    })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('no adapter registered for provider "missing"')
    expect(starts).toBe(0)
  })

  it('validates a configured effort before child creation', async () => {
    let starts = 0
    const ctx = await setup({
      provider: 'mock',
      agentOptions: {
        provider: 'alpha',
        model: 'parent-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
    }, { onStart: () => { starts += 1 } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
      defaultEffort: ReasoningEffortId('low'),
    }))

    const result = await callSubagent(
      ctx,
      { description: 'same route', prompt: 'do it' },
      { agent: parentWithRoute() },
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support reasoning effort "high"')
    expect(starts).toBe(0)
  })

  it('validates a configured route before child creation', async () => {
    let starts = 0
    const ctx = await setup({
      provider: 'mock',
      agentOptions: { provider: 'missing', model: 'configured-model' },
    }, { onStart: () => { starts += 1 } })

    const result = await callSubagent(
      ctx,
      { description: 'configured route', prompt: 'do it' },
      { agent: parentWithRoute() },
    )

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no adapter registered for provider "missing"')
    expect(starts).toBe(0)
  })

  it('rejects selected routes or configured efforts when the LLM service is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock' })
    await ctx.plugin(tool, {
      provider: 'mock',
      agentOptions: {
        provider: 'alpha',
        model: 'fast-model',
        reasoningEffort: ReasoningEffortId('high'),
      },
    })

    const configured = await callSubagent(ctx, { description: 'configured effort', prompt: 'do it' })
    expect(configured.isError).toBe(true)
    expect(text(configured)).toContain('`llm` service is unavailable')

  })

  it('keeps pure inherited routing usable without an LLM service lookup', async () => {
    let starts = 0
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock', onStart: () => { starts += 1 } })
    await ctx.plugin(tool, { provider: 'mock' })

    const result = await callSubagent(ctx, { description: 'inherit route', prompt: 'do it' })
    expect(result.isError).toBe(false)
    expect(starts).toBe(1)
  })

  it('warns that changing a fork route can lose inherited-prefix reuse', async () => {
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { inheritsParentContext: true })
    const schema = ctx.tools.schemas(modelSelectionSetupAgent(ctx)).find(entry => entry.name === 'subagent')!
    expect(schema.description).toContain('inherits this conversation')
    expect(schema.description).toContain('can prevent provider-side reuse of the inherited conversation prefix')
  })

  it('propagates an exact-route resolver failure before child creation', async () => {
    let starts = 0
    const ctx = await setup({ provider: 'mock', withModelSelection: true }, { onStart: () => { starts += 1 } })
    const adapter = new MockAdapter([])
    vi.spyOn(adapter, 'resolveModel').mockRejectedValue(new Error('selected route unavailable'))
    ctx.llm.registerAdapter(['alpha'], adapter)

    const result = await callSubagent(ctx, {
      description: 'route work',
      prompt: 'do it',
      provider: 'alpha',
      model: 'fast-model',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('selected route unavailable')
    expect(starts).toBe(0)
  })
})

describe('dsh-tool-subagent default child route', () => {
  const PARENT_OPTIONS = {
    provider: 'parent-provider',
    model: 'parent-model',
    reasoningEffort: ReasoningEffortId('parent-effort'),
  }
  const SAME_ROUTE: DefaultChildRoute = { provider: 'parent-provider', model: 'parent-model' }
  const SAME_ROUTE_WITH_EFFORT: DefaultChildRoute = {
    provider: 'parent-provider', model: 'parent-model', reasoningEffort: ReasoningEffortId('default-effort'),
  }
  const OTHER_ROUTE: DefaultChildRoute = { provider: 'default-provider', model: 'default-model' }
  const OTHER_ROUTE_WITH_EFFORT: DefaultChildRoute = {
    provider: 'default-provider', model: 'default-model', reasoningEffort: ReasoningEffortId('default-effort'),
  }
  const CONFIGURED_EFFORT_ONLY = { reasoningEffort: ReasoningEffortId('configured-effort') }

  describe('requestedAgentOptions precedence', () => {
    it('leaves pure inheritance untouched without a recorded default', () => {
      expect(requestedAgentOptions(PARENT_OPTIONS, undefined, {}, false)).toBeUndefined()
    })

    it('applies a route-changing default without an effort when nothing else selects a route', () => {
      expect(requestedAgentOptions(PARENT_OPTIONS, undefined, {}, true, OTHER_ROUTE)).toEqual({
        provider: 'default-provider', model: 'default-model',
      })
    })

    it('applies a route-changing default with its own effort', () => {
      expect(requestedAgentOptions(PARENT_OPTIONS, undefined, {}, true, OTHER_ROUTE_WITH_EFFORT)).toEqual({
        provider: 'default-provider', model: 'default-model', reasoningEffort: 'default-effort',
      })
    })

    it('names the parent route explicitly when the default matches it, so preflight still validates it', () => {
      expect(requestedAgentOptions(PARENT_OPTIONS, undefined, {}, true, SAME_ROUTE)).toEqual({
        provider: 'parent-provider', model: 'parent-model',
      })
    })

    it('drops a route-agnostic configured effort exactly when the default changes the route', () => {
      expect(requestedAgentOptions(PARENT_OPTIONS, CONFIGURED_EFFORT_ONLY, {}, true, OTHER_ROUTE)).toEqual({
        provider: 'default-provider', model: 'default-model',
      })
    })

    it('preserves a route-agnostic configured effort when the default route matches the parent', () => {
      expect(requestedAgentOptions(PARENT_OPTIONS, CONFIGURED_EFFORT_ONLY, {}, true, SAME_ROUTE)).toEqual({
        provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'configured-effort',
      })
    })

    it('lets the default\'s own effort win over a route-agnostic configured effort even when the route is unchanged', () => {
      expect(requestedAgentOptions(PARENT_OPTIONS, CONFIGURED_EFFORT_ONLY, {}, true, SAME_ROUTE_WITH_EFFORT)).toEqual({
        provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'default-effort',
      })
    })

    it('lets the default\'s own effort win over a route-agnostic configured effort when the route also changes', () => {
      expect(requestedAgentOptions(PARENT_OPTIONS, CONFIGURED_EFFORT_ONLY, {}, true, OTHER_ROUTE_WITH_EFFORT)).toEqual({
        provider: 'default-provider', model: 'default-model', reasoningEffort: 'default-effort',
      })
    })

    it('lets a configured route win outright over the default, contributing nothing', () => {
      expect(requestedAgentOptions(
        PARENT_OPTIONS,
        { provider: 'configured-provider', model: 'configured-model' },
        {},
        true,
        OTHER_ROUTE_WITH_EFFORT,
      )).toEqual({ provider: 'configured-provider', model: 'configured-model' })
    })

    it('lets an explicit model request override the default route and clear its effort on the new route', () => {
      expect(requestedAgentOptions(
        PARENT_OPTIONS,
        undefined,
        { provider: 'requested-provider', model: 'requested-model' },
        true,
        OTHER_ROUTE_WITH_EFFORT,
      )).toEqual({ provider: 'requested-provider', model: 'requested-model' })
    })

    it('applies an effort-only model request on top of the default route', () => {
      expect(requestedAgentOptions(
        PARENT_OPTIONS,
        undefined,
        { reasoning_effort: 'requested-effort' },
        true,
        OTHER_ROUTE_WITH_EFFORT,
      )).toEqual({ provider: 'default-provider', model: 'default-model', reasoningEffort: 'requested-effort' })
    })
  })

  describe('wired through the delegation tool', () => {
    it('reaches the recorded default route and effort when a call omits provider and model', async () => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({
        provider: 'mock',
        withModelSelection: true,
        modelSelectionDefault: { provider: 'alpha', model: 'fast-model', reasoningEffort: ReasoningEffortId('high') },
      }, { onStart: (request) => { requests.push(request) } })
      ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
      const parent = modelSelectionSetupAgent(ctx)
      ;(parent as { options: Agent['options'] }).options = parentWithRoute().options

      const result = await callSubagent(ctx, { description: 'default work', prompt: 'do it' })

      expect(result.isError).toBe(false)
      expect(requests[0]?.agentOptions).toEqual({ provider: 'alpha', model: 'fast-model', reasoningEffort: 'high' })
    })

    it('names the default in the tool description and param text, and marks it in list_subagent_models', async () => {
      const ctx = await setup({
        provider: 'mock',
        withModelSelection: true,
        modelSelectionDefault: { provider: 'alpha', model: 'fast-model', reasoningEffort: ReasoningEffortId('high') },
      })
      const agent = modelSelectionSetupAgent(ctx)
      const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')!
      expect(schema.description).toBe(
        'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
        + 'to offload focused, independent work — research, a scoped '
        + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
        + 'returns its result, not its intermediate steps. This call waits for the result by default. '
        + 'Child LLM selection is optional. Omit `provider` and `model` to run the child on `alpha/fast-model` '
        + 'at reasoning effort `high`. Supply `provider` and `model` together after using `list_subagent_models` '
        + 'to inspect advertised routes and efforts. Changing the effective route without naming an effort uses '
        + 'the selected model\'s default effort.',
      )
      const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
      expect(props['provider']?.description).toBe(
        'LLM provider route for the child. Supply together with model; omit both to run the child on `alpha/fast-model`.',
      )
      expect(props['model']?.description).toBe(
        'Model id interpreted by provider. Supply together with provider; omit both to run the child on `alpha/fast-model`.',
      )
      expect(props['reasoning_effort']?.description).toBe(
        'Adapter-owned reasoning effort for the effective child route. Omit to use `high` on the default route, '
        + 'or a newly selected model\'s default on another route.',
      )

      ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
      const inspected = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('default-route-inspect-model'),
        name: 'list_subagent_models',
        arguments: { provider: 'alpha', model: 'fast-model' },
        agent,
      })
      expect(text(inspected)).toContain('alpha/fast-model (default) — fast-model')
      const other = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('default-route-inspect-other-model'),
        name: 'list_subagent_models',
        arguments: { provider: 'alpha', model: 'other-model' },
        agent,
      })
      expect(text(other)).toContain('alpha/other-model — other-model')
      // The model route is unmarked; "high (default)" still names the reasoning effort default.
      expect(text(other)).not.toContain('alpha/other-model (default)')
    })

    it('keeps the description and param text byte-identical to the no-default wording when no default is recorded', async () => {
      const ctx = await setup({ provider: 'mock', withModelSelection: true })
      const agent = modelSelectionSetupAgent(ctx)
      const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')!
      expect(schema.description).toBe(
        'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
        + 'to offload focused, independent work — research, a scoped '
        + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
        + 'returns its result, not its intermediate steps. This call waits for the result by default. '
        + 'Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured '
        + 'child defaults and inherit compatible missing values from the parent Agent. Supply `provider` and '
        + '`model` together after using `list_subagent_models` to inspect advertised routes and efforts. '
        + 'Changing the effective route without naming an effort uses the selected model\'s default effort.',
      )
      const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
      expect(props['provider']?.description).toBe(
        'LLM provider route for the child. Supply together with model; omit both to use configured child defaults or inherit the parent route.',
      )
      expect(props['model']?.description).toBe(
        'Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or inherit the parent route.',
      )
      expect(props['reasoning_effort']?.description).toBe(
        'Adapter-owned reasoning effort for the effective child route. Omit to inherit a compatible '
        + 'configured/parent effort or use a newly selected model\'s default.',
      )
    })

    it('runs LLM preflight for the recorded default even without any request or configured options', async () => {
      const ctx = await setup({
        provider: 'mock',
        withModelSelection: true,
        modelSelectionDefault: { provider: 'alpha', model: 'fast-model' },
      })
      // No adapter registered for "alpha": preflight must reject before the child is created.
      const result = await callSubagent(ctx, { description: 'default work', prompt: 'do it' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('no adapter registered for provider "alpha"')
    })

    it('lets a recorded default win over a provider\'s own route defaults', async () => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({
        provider: 'mock',
        withModelSelection: true,
        modelSelectionDefault: { provider: 'alpha', model: 'fast-model', reasoningEffort: ReasoningEffortId('high') },
      }, {
        agentRouteDefaults: { provider: 'alpha', model: 'other-model' },
        onStart: (request) => { requests.push(request) },
      })
      ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
      const agent = modelSelectionSetupAgent(ctx)
      const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')!
      expect(schema.description).toContain(
        'Omit `provider` and `model` to run the child on `alpha/fast-model` at reasoning effort `high`.',
      )

      const result = await callSubagent(ctx, { description: 'default over provider', prompt: 'do it' })
      expect(result.isError).toBe(false)
      expect(requests[0]?.agentOptions).toEqual({ provider: 'alpha', model: 'fast-model', reasoningEffort: 'high' })

      const inspected = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('default-over-provider-inspect'),
        name: 'list_subagent_models',
        arguments: { provider: 'alpha', model: 'fast-model' },
        agent,
      })
      expect(text(inspected)).toContain('alpha/fast-model (default) — ')
    })

    it('lets a configured tool route win over a recorded default, keeping today\'s no-default wording', async () => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({
        provider: 'mock',
        withModelSelection: true,
        agentOptions: { provider: 'alpha', model: 'configured-model' },
        modelSelectionDefault: { provider: 'alpha', model: 'fast-model', reasoningEffort: ReasoningEffortId('high') },
      }, { onStart: (request) => { requests.push(request) } })
      ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
      const agent = modelSelectionSetupAgent(ctx)
      const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')!
      expect(schema.description).toContain(
        'Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and inherit '
        + 'compatible missing values from the parent Agent.',
      )
      expect(schema.description).not.toContain('run the child on')

      const result = await callSubagent(ctx, { description: 'tool route wins', prompt: 'do it' })
      expect(result.isError).toBe(false)
      expect(requests[0]?.agentOptions).toEqual({ provider: 'alpha', model: 'configured-model' })

      const inspected = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('tool-route-wins-inspect'),
        name: 'list_subagent_models',
        arguments: { provider: 'alpha', model: 'fast-model' },
        agent,
      })
      // The model route is unmarked; "high (default)" still names the reasoning effort default.
      expect(text(inspected)).not.toContain('alpha/fast-model (default)')
    })

    it('drops the effort when a recorded default with none of its own changes the route, reaching the adapter\'s own default', async () => {
      const requests: SubagentStartRequest[] = []
      const ctx = await setup({
        provider: 'mock',
        withModelSelection: true,
        modelSelectionDefault: { provider: 'alpha', model: 'fast-model' },
      }, { onStart: (request) => { requests.push(request) } })
      ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
      const parent = modelSelectionSetupAgent(ctx)
      const schema = ctx.tools.schemas(parent).find(entry => entry.name === 'subagent')!
      const props = (schema.parameters as { properties: Record<string, { description: string }> }).properties
      expect(props['reasoning_effort']?.description).toBe(
        'Adapter-owned reasoning effort for the effective child route. Omit to inherit a compatible parent '
        + 'effort when the default route matches the parent\'s, or use the selected model\'s default otherwise.',
      )
      // Parent runs alpha/parent-model at effort high; the default names a
      // DIFFERENT model on the same provider, so the route changes and the
      // parent's effort must not carry over.
      ;(parent as { options: Agent['options'] }).options = parentWithRoute().options

      const result = await callSubagent(ctx, { description: 'effort-less default', prompt: 'do it' })

      expect(result.isError).toBe(false)
      expect(requests[0]?.agentOptions).toEqual({ provider: 'alpha', model: 'fast-model' })
    })
  })
})
