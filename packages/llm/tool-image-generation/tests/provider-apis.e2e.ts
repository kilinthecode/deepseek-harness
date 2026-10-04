/** Opt-in real image requests: each route requires both its credential and an explicit image model. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import * as ImageHttp from '@deepseek-ai/dsh-image-generation-http'
import type { ImageGenerationApi } from '@deepseek-ai/dsh-image-generation-http'

const profiles: { api: ImageGenerationApi; baseURL: string; key: string; model: string }[] = [
  { api: 'openai-images', baseURL: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY', model: 'DSH_IMAGE_OPENAI_MODEL' },
  { api: 'openrouter-images', baseURL: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY', model: 'DSH_IMAGE_OPENROUTER_MODEL' },
  { api: 'google-generate-content', baseURL: 'https://generativelanguage.googleapis.com/v1', key: 'GEMINI_API_KEY', model: 'DSH_IMAGE_GEMINI_MODEL' },
]

for (const profile of profiles) {
  it.skipIf(!process.env[profile.key] || !process.env[profile.model])(`generates and persists a raster through ${profile.api}`, { timeout: 360_000, retry: 0 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-image-e2e-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LocalAttachmentStore, { dshHome: root })
      await ctx.plugin(ImageHttp, { providers: { images: {
        api: profile.api, baseURL: profile.baseURL, apiKeyEnv: profile.key,
        models: [{ id: process.env[profile.model]! }],
      } } })
      const result = await ctx.imageGeneration.prepare({ provider: 'images', model: process.env[profile.model]!, prompt: 'A small red circle on a plain white background.' }).generate(new AbortController().signal)
      expect(result.images.length).toBeGreaterThan(0)
      const previews = await ctx.attachments.saveImages(result.images)
      expect((await ctx.attachments.readImage(previews[0]!)).data.byteLength).toBeGreaterThan(0)
      const image = result.images[0]!
      const original = await ctx.attachments.saveFile({ data: image.data, name: 'generated-image' })
      const chunks: Uint8Array[] = []
      for await (const chunk of ctx.attachments.readFileStream(original)) chunks.push(chunk)
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(image.data))
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}
