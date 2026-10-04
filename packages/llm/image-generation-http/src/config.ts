/** Explicit image API routes and deployment limits. */

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Image wire protocols implemented by this provider. */
export type ImageGenerationApi = 'openai-images' | 'openrouter-images' | 'google-generate-content'

/** One explicitly configured image-generation route. */
export interface ImageApiProfile {
  /** Image endpoint protocol; image-input capability never selects this value. */
  api: ImageGenerationApi
  /** API root, including its version segment; operation paths are appended. */
  baseURL: string
  /** Credential reference resolved through the credential service or launch environment. */
  apiKeyEnv?: string
  /** Deployment headers; credentials belong in `apiKeyEnv`. */
  headers?: Record<string, string>
  /** Explicit image model allowlist. At least one entry is required. */
  models: {
    /** Exact model id supported by this image endpoint. */
    id: string
    /** Display name; omission uses the model id. */
    name?: string
  }[]
}

/** HTTP image-generation configuration; an empty provider dictionary is dormant. */
export interface Config {
  /** Named image routes with explicit model lists; an empty dictionary is dormant. */
  providers?: Record<string, ImageApiProfile>
  /** Whole-request deadline in milliseconds, including response body reads. Default 300000. */
  timeoutMs?: number
  /** Limit on complete encoded response bytes, including JSON and base64. Default 33554432. */
  maxResponseBytes?: number
}

/** Loader schema for explicit image models and bounded generation requests. */
export const Config: z<Config> = z.object({
  providers: z.dict(z.object({
    api: z.union(['openai-images', 'openrouter-images', 'google-generate-content'] as const).required(),
    baseURL: z.string().required(),
    apiKeyEnv: z.string(),
    headers: z.dict(z.string()),
    models: z.array(z.object({ id: z.string().required(), name: z.string() })).required(),
  })).default({}),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
  maxResponseBytes: z.number().step(1).min(1).default(32 * 1024 * 1024),
})

/** A configuration whose defaults and self-contained constraints have been resolved. */
export interface ImageHttpSpec {
  readonly providers: Readonly<Record<string, ImageApiProfile>>
  readonly timeoutMs: number
  readonly maxResponseBytes: number
}

/**
 * Materialize defaults and reject unusable routes before mounting the service.
 * @param config - loader-validated configuration or a direct plugin caller's configuration.
 * @returns a detached configuration snapshot.
 */
export function resolveConfig(config: Config): ImageHttpSpec {
  const validated = Config(config)
  const providers = structuredClone(validated.providers ?? {})
  for (const [provider, profile] of Object.entries(providers)) {
    if (provider.trim() === '') throw new Error('image-generation-http: provider id must not be blank')
    const url = new URL(profile.baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`image-generation-http: provider "${provider}" requires an HTTP(S) API root without credentials, query, or fragment`)
    }
    if (profile.apiKeyEnv !== undefined) credentialRef(profile.apiKeyEnv)
    if (profile.models.length === 0) throw new Error(`image-generation-http: provider "${provider}" must list an image model`)
    const ids = new Set<string>()
    for (const model of profile.models) {
      if (model.id.trim() === '' || ids.has(model.id)) {
        throw new Error(`image-generation-http: provider "${provider}" has a blank or duplicate model id`)
      }
      ids.add(model.id)
    }
    new Headers(profile.headers)
  }
  return { providers, timeoutMs: validated.timeoutMs ?? 300_000, maxResponseBytes: validated.maxResponseBytes ?? 32 * 1024 * 1024 }
}
