import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as HttpPlugin from '../src/index.ts'
import { Config, resolveConfig } from '../src/config.ts'
import type { ImageGenerationApi } from '../src/config.ts'
import { decodeImageResponse, readImageResponse } from '../src/response.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const imageReply = { data: [{ b64_json: png }] }
const contexts = new Map<Context, () => Promise<void>>()
afterEach(async () => {
  for (const dispose of contexts.values()) await dispose()
  contexts.clear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function provider(api: ImageGenerationApi = 'openai-images', overrides: Partial<Config> = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(HttpPlugin, {
    providers: { images: { api, baseURL: 'https://images.example/v1', models: [{ id: 'draw', name: 'Drawing' }] } },
    ...overrides,
  })
  contexts.set(ctx, async () => { await fiber.dispose() })
  return ctx
}

describe('explicit image API configuration', () => {
  it('keeps an empty provider dictionary dormant', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(HttpPlugin, {})
    contexts.set(ctx, async () => { await fiber.dispose() })
    expect(ctx.get('imageGeneration')).toBeUndefined()
  })

  it.each([
    { baseURL: 'file:///tmp/api' }, { baseURL: 'https://user:secret@example.com/v1' },
    { baseURL: 'https://example.com/v1?key=x' }, { baseURL: 'https://example.com/v1#x' },
    { models: [] }, { models: [{ id: ' ' }] }, { models: [{ id: 'draw' }, { id: 'draw' }] },
    { apiKeyEnv: 'invalid ref' }, { headers: { 'bad\nheader': 'x' } },
  ])('refuses unusable routes at load: %j', (override) => {
    expect(() => resolveConfig({ providers: { images: {
      api: 'openai-images', baseURL: 'https://example.com/v1', models: [{ id: 'draw' }], ...override,
    } } })).toThrow()
  })

  it('rejects blank route ids and invalid bounds', () => {
    expect(() => resolveConfig({ providers: { ' ': { api: 'openai-images', baseURL: 'https://example.com', models: [{ id: 'draw' }] } } })).toThrow('provider id')
    expect(() => Config({ timeoutMs: 0 })).toThrow()
    expect(() => Config({ maxResponseBytes: 0 })).toThrow()
  })
})

describe('complete image response receipt', () => {
  it('accepts the exact encoded-body limit and rejects a byte less', async () => {
    const text = JSON.stringify(imageReply)
    const bytes = Buffer.byteLength(text)
    const signal = new AbortController().signal
    await expect(readImageResponse(new Response(text), bytes, signal)).resolves.toEqual(imageReply)
    await expect(readImageResponse(new Response(text), bytes - 1, signal)).rejects.toThrow('byte limit')
  })

  it('counts multibyte text and cancels an overflowing body', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('"画像"')) }, cancel })
    await expect(readImageResponse(new Response(body), 3, new AbortController().signal)).rejects.toThrow('byte limit')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('refuses an absent body, malformed JSON, and caller cancellation', async () => {
    const controller = new AbortController()
    await expect(readImageResponse(new Response(null), 100, controller.signal)).rejects.toThrow('no response body')
    await expect(readImageResponse(new Response('{'), 100, controller.signal)).rejects.toThrow()
    controller.abort(new Error('caller stopped'))
    await expect(readImageResponse(new Response('{}'), 100, controller.signal)).rejects.toThrow('caller stopped')
  })

  it('accepts OpenAI and OpenRouter inline rasters and keeps revised prompt text', () => {
    for (const api of ['openai-images', 'openrouter-images'] as const) {
      const result = decodeImageResponse(api, { data: [{ b64_json: png, media_type: 'image/png', revised_prompt: 'A red pixel' }] })
      expect(result.images[0]?.data).toEqual(Buffer.from(png, 'base64'))
      expect(result.images[0]?.mediaType).toBe('image/png')
      expect(result.text).toBe('A red pixel')
    }
  })

  it('keeps Gemini visible text and final images, excluding thought images', () => {
    const result = decodeImageResponse('google-generate-content', { candidates: [{ finishReason: 'STOP', content: { parts: [
      { thought: true, inlineData: { data: 'invalid', mimeType: 'image/png' } },
      { text: 'Here it is.' }, { inlineData: { data: png, mimeType: 'image/png' } },
    ] } }] })
    expect(result.images).toHaveLength(1)
    expect(result.text).toBe('Here it is.')
  })

  it.each([
    null, [], {}, { data: [] }, { data: [{ url: 'https://example.com/image.png' }] },
    { data: [{ b64_json: 'invalid' }] }, { data: [{ b64_json: Buffer.from('abc').toString('base64') }] },
    { data: [{ b64_json: png, media_type: 'image/jpeg' }] },
  ])('refuses invalid or absent inline images: %j', (value) => {
    expect(() => decodeImageResponse('openai-images', value)).toThrow()
  })

  it.each([
    {}, { candidates: [] }, { candidates: [{ finishReason: 'SAFETY' }] },
    { candidates: [{ content: {} }] }, { candidates: [{ content: { parts: [{ text: 'Refused' }] } }] },
  ])('refuses Gemini incomplete or imageless responses: %j', (value) => {
    expect(() => decodeImageResponse('google-generate-content', value)).toThrow()
  })
})

describe('prepared generation calls', () => {
  it.each([
    ['openai-images', '/images/generations'], ['openrouter-images', '/images'],
    ['google-generate-content', '/models/draw:generateContent'],
  ] as const)('sends the declared %s protocol', async (api, path) => {
    const response = api === 'google-generate-content'
      ? { candidates: [{ content: { parts: [{ inlineData: { data: png, mimeType: 'image/png' } }] } }] }
      : imageReply
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response)))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await provider(api)
    const call = ctx.imageGeneration.prepare({ provider: 'images', model: 'draw', prompt: 'Draw a red pixel' })
    await expect(call.generate(new AbortController().signal)).resolves.toMatchObject({ images: [{ mediaType: 'image/png' }] })
    const [url, options] = fetchMock.mock.calls[0]!
    expect(url).toBe(`https://images.example/v1${path}`)
    expect(options?.redirect).toBe('error')
    expect(options?.body).toBe(JSON.stringify(api === 'google-generate-content'
      ? { contents: [{ role: 'user', parts: [{ text: 'Draw a red pixel' }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }
      : { model: 'draw', prompt: 'Draw a red pixel' }))
  })

  it('enforces membership and prompt validity before any request and detaches request values', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(imageReply)))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await provider()
    expect(ctx.imageGeneration.listModels()).toEqual([{ provider: 'images', model: 'draw', name: 'Drawing' }])
    expect(() => ctx.imageGeneration.prepare({ provider: 'other', model: 'draw', prompt: 'x' })).toThrow('not configured')
    for (const provider of ['constructor', 'toString', '__proto__']) {
      expect(() => ctx.imageGeneration.prepare({ provider, model: 'draw', prompt: 'x' })).toThrow('not configured')
    }
    expect(() => ctx.imageGeneration.prepare({ provider: 'images', model: 'chat-only', prompt: 'x' })).toThrow('not configured')
    expect(() => ctx.imageGeneration.prepare({ provider: 'images', model: 'draw', prompt: ' ' })).toThrow('non-blank')
    expect(fetchMock).not.toHaveBeenCalled()
    const request = { provider: 'images', model: 'draw', prompt: 'original' }
    const prepared = ctx.imageGeneration.prepare(request)
    request.prompt = 'changed'
    await prepared.generate(new AbortController().signal)
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ model: 'draw', prompt: 'original' }))
  })

  it('uses the named credential and deployment headers', async () => {
    vi.stubEnv('DSH_IMAGE_TEST_KEY', ' test-key ')
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(imageReply)))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await provider('openai-images', { providers: { images: { api: 'openai-images', baseURL: 'https://images.example', apiKeyEnv: 'DSH_IMAGE_TEST_KEY', headers: { 'X-Deployment': 'test', 'content-type': 'application/json' }, models: [{ id: 'draw' }] } } })
    await ctx.imageGeneration.prepare({ provider: 'images', model: 'draw', prompt: 'x' }).generate(new AbortController().signal)
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer test-key')
    expect(headers.get('X-Deployment')).toBe('test')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('fails a missing credential and an HTTP error without retrying', async () => {
    vi.stubEnv('DSH_IMAGE_TEST_MISSING', '')
    const fetchMock = vi.fn().mockResolvedValue(new Response('provider error', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await provider()
    await expect(ctx.imageGeneration.prepare({ provider: 'images', model: 'draw', prompt: 'x' }).generate(new AbortController().signal)).rejects.toThrow('HTTP 429')
    expect(fetchMock).toHaveBeenCalledOnce()
    const keyed = await provider('openai-images', { providers: { images: { api: 'openai-images', baseURL: 'https://images.example', apiKeyEnv: 'DSH_IMAGE_TEST_MISSING', models: [{ id: 'draw' }] } } })
    await expect(keyed.imageGeneration.prepare({ provider: 'images', model: 'draw', prompt: 'x' }).generate(new AbortController().signal)).rejects.toThrow('credential')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('aborts outstanding requests and waits for their settlement on disposal', async () => {
    let entered!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => { reject(new Error('Image-generation provider was disposed')) }, { once: true })
      entered()
    })))
    const ctx = await provider()
    const prepared = ctx.imageGeneration.prepare({ provider: 'images', model: 'draw', prompt: 'x' })
    const work = prepared.generate(new AbortController().signal)
    const rejected = expect(work).rejects.toThrow('disposed')
    await ready
    await contexts.get(ctx)!()
    await rejected
    expect(ctx.get('imageGeneration')).toBeUndefined()
    await expect(prepared.generate(new AbortController().signal)).rejects.toThrow('disposed')
  })

  it.each(['caller', 'deadline', 'disposal'] as const)('settles pending credential lookup on %s cancellation without sending a request', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-image-credentials-'))
    const ctx = await provider('openai-images', {
      timeoutMs: 100,
      providers: { images: { api: 'openai-images', baseURL: 'https://images.example', apiKeyEnv: 'DSH_IMAGE_TEST_KEY', models: [{ id: 'draw' }] } },
    })
    const credentials = await ctx.plugin(LocalCredentials, { dshHome: root })
    const disposeProvider = contexts.get(ctx)!
    contexts.set(ctx, async () => {
      await disposeProvider()
      await credentials.dispose()
      await rm(root, { recursive: true, force: true })
    })
    const pending = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.credentials, 'resolve').mockReturnValue(pending.promise)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const controller = new AbortController()
    const work = ctx.imageGeneration.prepare({ provider: 'images', model: 'draw', prompt: 'x' }).generate(controller.signal)
    const rejected = expect(work).rejects.toThrow(mode === 'caller' ? 'caller stopped' : mode === 'deadline' ? 'IMAGE_GENERATION_TIMEOUT' : 'disposed')
    if (mode === 'caller') controller.abort(new Error('caller stopped'))
    else if (mode === 'deadline') await vi.advanceTimersByTimeAsync(100)
    else await disposeProvider()
    await rejected
    pending.resolve(undefined)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
