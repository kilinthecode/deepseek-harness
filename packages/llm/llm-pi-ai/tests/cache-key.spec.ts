/**
 * Delegation-tree provider cache-routing key: the gate restricting it to
 * OpenAI's own ChatGPT/Codex routes, the `onPayload` override that installs
 * it on the wire, and its absence everywhere else.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Model } from '@earendil-works/pi-ai'
import { stream as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { stream as streamCodex } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import * as LlmPiAi from '../src/index.ts'
import { PiAiAdapter, overridePromptCacheKey, resolveCacheKeyOverride, sharesPromptCacheKey } from '../src/adapter.ts'
import type { ResolvedPiAiProviderProfile } from '../src/config.ts'
import { createProvider } from '../src/models.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble as assembleThroughLlm } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NO_RETRY: ResolvedRetryPolicy = { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

/** A fake `GenerateOptions.sessionId`: the brand is erased at runtime, so any string round-trips. */
function fakeSessionId(id: string): Branded<'SessionId'> {
  return brandString<Branded<'SessionId'>>(id)
}

/**
 * An unsigned JWT carrying the ChatGPT account claim `extractAccountId` in
 * pi-ai's `openai-codex-responses` module reads; that module never verifies
 * the signature segment, so a placeholder is enough to reach request building.
 */
function fakeCodexApiKey(accountId: string): string {
  const claim = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }
  const payload = Buffer.from(JSON.stringify(claim), 'utf8').toString('base64')
  return `header.${payload}.signature`
}

function model<A extends 'openai-completions' | 'openai-codex-responses'>(api: A, provider: string, baseUrl: string): Model<A> {
  return {
    id: 'm', name: 'm', api, provider, baseUrl, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
  }
}

describe('sharesPromptCacheKey', () => {
  it.each([
    ['openai', 'https://api.openai.com/v1', true],
    // pi-ai's real `openai-codex` provider resolves to ChatGPT's own host, not
    // OpenAI's platform API host — this is the load-bearing row: the gate must
    // recognize the provider regardless of host, or GPT-6/Codex-via-ChatGPT
    // children (this feature's primary target) never share a cache key.
    ['openai-codex', 'https://chatgpt.com/backend-api', true],
    ['azure-openai-responses', 'https://api.openai.com/v1', false],
    // Host alone grants nothing either: a non-shared provider is excluded even
    // on the exact host a shared provider resolves to.
    ['anthropic', 'https://chatgpt.com/backend-api', false],
  ] as const)('provider %s, baseUrl %s -> %s', (provider, baseUrl, expected) => {
    expect(sharesPromptCacheKey(model('openai-completions', provider, baseUrl))).toBe(expected)
  })
})

describe('resolveCacheKeyOverride', () => {
  const base: GenerateOptions = { provider: 'p', model: 'm', messages: [] }

  it('is absent when cacheKey is unset', () => {
    expect(resolveCacheKeyOverride({ ...base, sessionId: fakeSessionId('s') })).toBeUndefined()
  })

  it('is absent when cacheKey equals sessionId (a top-level request)', () => {
    expect(resolveCacheKeyOverride({ ...base, sessionId: fakeSessionId('s'), cacheKey: fakeSessionId('s') })).toBeUndefined()
  })

  it('is the cacheKey when it differs from sessionId', () => {
    expect(resolveCacheKeyOverride({ ...base, sessionId: fakeSessionId('child'), cacheKey: fakeSessionId('root') })).toBe('root')
  })

  it('is the cacheKey even without a sessionId', () => {
    expect(resolveCacheKeyOverride({ ...base, cacheKey: fakeSessionId('root') })).toBe('root')
  })
})

describe('overridePromptCacheKey', () => {
  const openaiModel = model('openai-completions', 'openai', 'https://api.openai.com/v1')
  const azureModel = model('openai-completions', 'azure-openai-responses', 'https://api.openai.com/v1')

  it('replaces an existing prompt_cache_key on a shared route', () => {
    const hook = overridePromptCacheKey(fakeSessionId('root-session'))
    expect(hook({ prompt_cache_key: 'child-session', other: 'field' }, openaiModel))
      .toEqual({ prompt_cache_key: 'root-session', other: 'field' })
  })

  it('clamps an oversized cache key to OpenAI\'s 64-character limit', () => {
    const long = 'x'.repeat(80)
    const hook = overridePromptCacheKey(fakeSessionId(long))
    const result = hook({ prompt_cache_key: 'child-session' }, openaiModel) as { prompt_cache_key: string }
    expect(result.prompt_cache_key).toHaveLength(64)
    expect(result.prompt_cache_key).toBe('x'.repeat(64))
  })

  it('does not add a key when pi-ai itself set none (cacheRetention: none)', () => {
    const hook = overridePromptCacheKey(fakeSessionId('root-session'))
    expect(hook({ prompt_cache_key: undefined }, openaiModel)).toBeUndefined()
  })

  it('leaves a non-shared route untouched even with a defined key', () => {
    const hook = overridePromptCacheKey(fakeSessionId('root-session'))
    expect(hook({ prompt_cache_key: 'child-session' }, azureModel)).toBeUndefined()
  })

  it('leaves a non-object payload untouched', () => {
    const hook = overridePromptCacheKey(fakeSessionId('root-session'))
    expect(hook(null, openaiModel)).toBeUndefined()
    expect(hook('raw-string', openaiModel)).toBeUndefined()
  })
})

describe('adapter wiring: routes outside the OpenAI family are untouched', () => {
  it('sends the identical wire body and headers whether or not cacheKey is set', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    vi.stubEnv('PI_CACHE_KEY_TEST', 'test-key')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { deepseek: { apiKeyEnv: 'PI_CACHE_KEY_TEST', baseURL: server.url } },
    })
    const request = { model: 'deepseek-flash', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] }
    await assembleThroughLlm(ctx, { ...request, sessionId: fakeSessionId('child') })
    await assembleThroughLlm(ctx, { ...request, sessionId: fakeSessionId('child'), cacheKey: fakeSessionId('root') })
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]).toEqual(server.requests[0])
    expect(server.headers[1]).toEqual(server.headers[0])
    await ctx.fiber.dispose()
  })
})

describe('adapter wiring: the shared cache key reaches the wire through the real PiAiAdapter class', () => {
  it('overrides prompt_cache_key end-to-end on an openai-family route', async () => {
    const server = await mockServer([{ events: textEvents }])
    const redirectFetch: typeof fetch = (input, init) => {
      const target = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
      return fetch(`${server.url}${target.pathname}${target.search}`, init)
    }
    const fakeModel = model('openai-completions', 'openai', 'https://api.openai.com/v1')
    const profile: ResolvedPiAiProviderProfile = {
      provider: 'openai',
      displayName: 'Cache Test',
      streamIdleTimeoutMs: 30_000,
      maxRequestImageBytes: 1,
      requestImagePixelBudget: 1,
      requestImageMaxBytes: 1,
      retryPolicy: NO_RETRY,
      modelErrors: new Map(),
      configuredMaxTokens: new Map(),
      // Delegates to the real openai-completions module (forcing `fetch` to the
      // local mock) so this exercises pi-ai's own request building and
      // `onPayload` invocation, not a hand-rolled stand-in for either.
      piProvider: createProvider({
        id: 'openai',
        name: 'Cache Test',
        auth: { apiKey: { name: 'test', resolve: () => Promise.resolve({ auth: { apiKey: 'test-key' } }) } },
        models: [fakeModel],
        api: {
          stream: () => { throw new Error('unused in this test') },
          streamSimple: (m, context, options) =>
            streamCompletions(m as Model<'openai-completions'>, context, { ...options, fetch: redirectFetch }),
        },
      }),
    }
    const adapter = new PiAiAdapter({
      profiles: () => new Map([['openai', profile]]),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    })
    const events = adapter.stream({
      provider: 'openai',
      model: fakeModel.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: fakeSessionId('child-session'),
      cacheKey: fakeSessionId('root-session'),
    })
    for await (const _chunk of events) { /* drain to completion; the mock server's captured request is the assertion. */ }
    expect(server.requests).toHaveLength(1)
    const body = server.requests[0] as { prompt_cache_key?: string }
    expect(body.prompt_cache_key).toBe('root-session')
  })

  it('overrides prompt_cache_key end-to-end on the openai-codex route while its session-id header stays put', async () => {
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_1"}}',
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const redirectFetch: typeof fetch = (input, init) => {
      const target = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
      return fetch(`${server.url}${target.pathname}${target.search}`, init)
    }
    // pi-ai's real openai-codex provider baseUrl is chatgpt.com/backend-api,
    // not api.openai.com — the exact route this whole fix is about.
    const codexModel = model('openai-codex-responses', 'openai-codex', 'https://chatgpt.com/backend-api')
    const profile: ResolvedPiAiProviderProfile = {
      provider: 'openai-codex',
      displayName: 'Cache Test Codex',
      streamIdleTimeoutMs: 30_000,
      maxRequestImageBytes: 1,
      requestImagePixelBudget: 1,
      requestImageMaxBytes: 1,
      // Forces the SSE branch of openai-codex-responses.stream(); the
      // WebSocket branch shares the same onPayload-modified `body` before
      // its own JSON.stringify (see the Agent Note), so this is the simpler
      // of the two transports to drive through a redirected fetch.
      transport: 'sse',
      retryPolicy: NO_RETRY,
      modelErrors: new Map(),
      configuredMaxTokens: new Map(),
      piProvider: createProvider({
        id: 'openai-codex',
        name: 'Cache Test Codex',
        auth: { apiKey: { name: 'test', resolve: () => Promise.resolve({ auth: { apiKey: fakeCodexApiKey('acct_test') } }) } },
        models: [codexModel],
        api: {
          stream: () => { throw new Error('unused in this test') },
          streamSimple: (m, context, options) =>
            streamCodex(m as Model<'openai-codex-responses'>, context, { ...options, fetch: redirectFetch }),
        },
      }),
    }
    const adapter = new PiAiAdapter({
      profiles: () => new Map([['openai-codex', profile]]),
      resolveApiKey: () => Promise.resolve(fakeCodexApiKey('acct_test')),
      auth: memoryAuth(),
    })
    const events = adapter.stream({
      provider: 'openai-codex',
      model: codexModel.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: fakeSessionId('child-session'),
      cacheKey: fakeSessionId('root-session'),
    })
    for await (const _chunk of events) { /* drain to completion; the mock server's captured request is the assertion. */ }
    expect(server.requests).toHaveLength(1)
    const body = server.requests[0] as { prompt_cache_key?: string }
    expect(body.prompt_cache_key).toBe('root-session')
    expect(server.headers[0]?.['session-id']).toBe('child-session')
  })

  it('adds no prompt_cache_key when the route profile sets cacheRetention: none', async () => {
    const server = await mockServer([{ events: textEvents }])
    const redirectFetch: typeof fetch = (input, init) => {
      const target = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
      return fetch(`${server.url}${target.pathname}${target.search}`, init)
    }
    const fakeModel = model('openai-completions', 'openai', 'https://api.openai.com/v1')
    const profile: ResolvedPiAiProviderProfile = {
      provider: 'openai',
      displayName: 'Cache Test No Retention',
      streamIdleTimeoutMs: 30_000,
      maxRequestImageBytes: 1,
      requestImagePixelBudget: 1,
      requestImageMaxBytes: 1,
      // The config schema validates this as one of 'none' | 'short' | 'long'
      // (config.ts); profileOptions() forwards it into SimpleStreamOptions,
      // where pi-ai itself omits prompt_cache_key entirely under 'none'.
      cacheRetention: 'none',
      retryPolicy: NO_RETRY,
      modelErrors: new Map(),
      configuredMaxTokens: new Map(),
      piProvider: createProvider({
        id: 'openai',
        name: 'Cache Test No Retention',
        auth: { apiKey: { name: 'test', resolve: () => Promise.resolve({ auth: { apiKey: 'test-key' } }) } },
        models: [fakeModel],
        api: {
          stream: () => { throw new Error('unused in this test') },
          streamSimple: (m, context, options) =>
            streamCompletions(m as Model<'openai-completions'>, context, { ...options, fetch: redirectFetch }),
        },
      }),
    }
    const adapter = new PiAiAdapter({
      profiles: () => new Map([['openai', profile]]),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    })
    const events = adapter.stream({
      provider: 'openai',
      model: fakeModel.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: fakeSessionId('child-session'),
      cacheKey: fakeSessionId('root-session'),
    })
    for await (const _chunk of events) { /* drain to completion; the mock server's captured request is the assertion. */ }
    expect(server.requests).toHaveLength(1)
    const body = server.requests[0] as { prompt_cache_key?: string }
    expect(body.prompt_cache_key).toBeUndefined()
  })
})

describe('real pi-ai openai-completions module: wire-level prompt_cache_key override', () => {
  it('overrides prompt_cache_key for the openai provider while sessionId-derived routing stays put', async () => {
    const server = await mockServer([{ events: textEvents }])
    const redirectFetch: typeof fetch = (input, init) => {
      const target = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
      return fetch(`${server.url}${target.pathname}${target.search}`, init)
    }
    const context = normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] })
    const events = streamCompletions(model('openai-completions', 'openai', 'https://api.openai.com/v1'), context, {
      apiKey: 'test-key',
      sessionId: 'child-session',
      fetch: redirectFetch,
      onPayload: overridePromptCacheKey(fakeSessionId('root-session')),
    })
    for await (const _event of events) { /* drain to completion; the mock server's captured request is the assertion. */ }
    expect(server.requests).toHaveLength(1)
    const body = server.requests[0] as { prompt_cache_key?: string }
    expect(body.prompt_cache_key).toBe('root-session')
    // The override is scoped to the body's cache-routing field alone: this
    // request's own session id, not the cache key, still reaches the wire
    // wherever pi-ai carries session-affinity data.
    expect(Object.values(server.headers[0] ?? {})).not.toContain('root-session')
  })

  it('leaves prompt_cache_key alone against a non-OpenAI base URL', async () => {
    const server = await mockServer([{ events: textEvents }])
    const context = normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] })
    const events = streamCompletions(model('openai-completions', 'openai', server.url), context, {
      apiKey: 'test-key',
      sessionId: 'child-session',
      onPayload: overridePromptCacheKey(fakeSessionId('root-session')),
    })
    for await (const _event of events) { /* drain to completion; the mock server's captured request is the assertion. */ }
    expect(server.requests).toHaveLength(1)
    const body = server.requests[0] as { prompt_cache_key?: string }
    expect(body.prompt_cache_key).toBeUndefined()
  })
})

describe('real pi-ai openai-codex-responses module: wire-level prompt_cache_key override', () => {
  it('overrides prompt_cache_key for the openai-codex provider while its own session-id header stays put', async () => {
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_1"}}',
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const redirectFetch: typeof fetch = (input, init) => {
      const target = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
      return fetch(`${server.url}${target.pathname}${target.search}`, init)
    }
    // pi-ai's real openai-codex provider baseUrl is chatgpt.com/backend-api,
    // not api.openai.com; this is the route sharesPromptCacheKey must accept.
    const codexModel = model('openai-codex-responses', 'openai-codex', 'https://chatgpt.com/backend-api')
    const context = normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] })
    const events = streamCodex(codexModel, context, {
      apiKey: fakeCodexApiKey('acct_test'),
      sessionId: 'child-session',
      transport: 'sse',
      fetch: redirectFetch,
      onPayload: overridePromptCacheKey(fakeSessionId('root-session')),
    })
    for await (const _event of events) { /* drain to completion; the mock server's captured request is the assertion. */ }
    expect(server.requests).toHaveLength(1)
    const body = server.requests[0] as { prompt_cache_key?: string }
    expect(body.prompt_cache_key).toBe('root-session')
    // The websocket/SSE session-id header keeps routing on this request's own
    // session id; only the body's cache-routing field changes.
    expect(server.headers[0]?.['session-id']).toBe('child-session')
  })
})
