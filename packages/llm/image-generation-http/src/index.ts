/** Explicit OpenAI, OpenRouter, and Gemini image APIs behind one image-generation provider. */

import { Context } from '@deepseek-ai/cordis'
import { ImageGenerationProvider } from '@deepseek-ai/dsh-image-generation'
import type { ImageGenerationModel, ImageGenerationRequest, ImageGenerationResult, PreparedImageGeneration } from '@deepseek-ai/dsh-image-generation'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { attributionHeaders, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { Config, resolveConfig } from './config.ts'
import type { ImageApiProfile, ImageHttpSpec } from './config.ts'
import { decodeImageResponse, readImageResponse } from './response.ts'

export { Config } from './config.ts'
export type { ImageApiProfile, ImageGenerationApi } from './config.ts'

/** Loader identity for the HTTP image provider. */
export const name = 'image-generation-http'

/** Credential resolution belongs to its service; cancellation stops this caller waiting for it. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await Promise.race([work, aborted.promise])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * HTTP implementation with explicit model membership and no automatic retry.
 * Disposal cancels and awaits its outstanding network requests.
 */
export class HttpImageGenerationProvider extends ImageGenerationProvider {
  private readonly spec: ImageHttpSpec
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<ImageGenerationResult>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.spec = resolveConfig(config)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Image-generation provider was disposed'))
      await Promise.allSettled([...this.active])
    }, 'image-generation-http requests')
  }

  listModels(): readonly ImageGenerationModel[] {
    return Object.entries(this.spec.providers).flatMap(([provider, profile]) => profile.models.map(model => ({
      provider, model: model.id, name: model.name ?? model.id,
    })))
  }

  prepare(request: ImageGenerationRequest): PreparedImageGeneration {
    this.lifetime.signal.throwIfAborted()
    const profile = Object.hasOwn(this.spec.providers, request.provider) ? this.spec.providers[request.provider] : undefined
    const selected = profile?.models.find(model => model.id === request.model)
    if (profile === undefined || selected === undefined) {
      throw new Error(`Image model "${request.provider}/${request.model}" is not configured`)
    }
    if (request.prompt.trim() === '') throw new Error('Image generation requires a non-blank prompt')
    const provider = request.provider
    const model = request.model
    const prompt = request.prompt
    return {
      model: { provider, model, name: selected.name ?? model },
      generate: (signal) => {
        const work = this.generateWith(profile, model, prompt, signal)
        this.active.add(work)
        void work.then(() => this.active.delete(work), () => this.active.delete(work))
        return work
      },
    }
  }

  private async generateWith(
    profile: ImageApiProfile, model: string, prompt: string, upstream: AbortSignal,
  ): Promise<ImageGenerationResult> {
    const signal = AbortSignal.any([upstream, this.lifetime.signal])
    signal.throwIfAborted()
    using timer = deadline(signal, this.spec.timeoutMs, 'IMAGE_GENERATION_TIMEOUT')
    const headers = new Headers({ ...attributionHeaders(), ...profile.headers })
    headers.set('Content-Type', 'application/json')
    if (profile.apiKeyEnv !== undefined) {
      const ref = credentialRef(profile.apiKeyEnv)
      const credentials = this.ctx.get('credentials')
      const key = credentials === undefined
        ? launchEnvironmentOf(this.ctx).get(profile.apiKeyEnv)?.value
        : (await abortable(credentials.resolve(ref), timer.signal))?.value
      if (key === undefined) throw new Error(`Image generation credential "${profile.apiKeyEnv}" is not available`)
      const normalized = normalizeApiKey(key)
      if (!normalized.ok) throw new Error(`Image generation credential "${profile.apiKeyEnv}" is invalid`)
      headers.set(profile.api === 'google-generate-content' ? 'x-goog-api-key' : 'Authorization',
        profile.api === 'google-generate-content' ? normalized.value : `Bearer ${normalized.value}`)
    }
    timer.signal.throwIfAborted()
    const root = profile.baseURL.replace(/\/+$/, '')
    const url = profile.api === 'google-generate-content'
      ? `${root}/models/${encodeURIComponent(model)}:generateContent`
      : `${root}/images${profile.api === 'openai-images' ? '/generations' : ''}`
    const body = profile.api === 'google-generate-content'
      ? { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }
      : { model, prompt }
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: timer.signal, redirect: 'error' })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Image API returned HTTP ${response.status}`)
    }
    const json = await readImageResponse(response, this.spec.maxResponseBytes, timer.signal)
    timer.signal.throwIfAborted()
    return decodeImageResponse(profile.api, json)
  }
}

/**
 * Mount the provider only when at least one explicit image route is configured.
 * @param ctx - provider plugin context.
 * @param config - explicit routes and HTTP limits.
 */
export function apply(ctx: Context, config: Config): void {
  const spec = resolveConfig(config)
  if (Object.keys(spec.providers).length > 0) ctx.plugin(HttpImageGenerationProvider, spec)
}
