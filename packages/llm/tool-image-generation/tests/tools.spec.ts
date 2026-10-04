import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ImageGenerationProvider } from '@deepseek-ai/dsh-image-generation'
import type { ImageGenerationRequest, PreparedImageGeneration } from '@deepseek-ai/dsh-image-generation'
import { createToolResultMessage, LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '../src/index.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

class ImageFixture extends ImageGenerationProvider {
  count = 1
  listModels() { return [{ provider: 'images', model: 'draw', name: 'Drawing' }] }
  prepare(request: ImageGenerationRequest): PreparedImageGeneration {
    if (request.provider !== 'images' || request.model !== 'draw') throw new Error('Unknown image model')
    return { model: this.listModels()[0]!, generate: async () => ({
      images: Array.from({ length: this.count }, () => ({ data: png, mediaType: 'image/png' })), text: 'A red pixel',
    }) }
  }
}

async function setup(limits = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-tools-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: root, ...limits })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ImageFixture)
  const tools = await ctx.plugin(Tools)
  return { ctx, tools, root }
}

function generate(ctx: Context, model = 'draw') {
  return ctx.tools.execute({
    name: 'generate_image', arguments: { provider: 'images', model, prompt: 'A red pixel' },
    callId: ToolCallId('generate-1'), signal: new AbortController().signal,
  })
}

describe('durable image-generation tools', () => {
  it('discovers configured image models and removes tools when their fiber unloads', async () => {
    const { ctx, tools } = await setup()
    const result = await ctx.tools.execute({ name: 'list_image_models', arguments: {}, callId: ToolCallId('list-1'), signal: new AbortController().signal })
    expect(result.content).toEqual([{ type: 'text', text: '[{"provider":"images","model":"draw","name":"Drawing"}]' }])
    await tools.dispose()
    expect(ctx.tools.get('generate_image')).toBeUndefined()
    expect(ctx.tools.get('list_image_models')).toBeUndefined()
  })

  it('returns readable previews and exact original files after committing all bytes', async () => {
    const { ctx } = await setup()
    const result = await generate(ctx)
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Generated 1 image(s) with images/draw. Original files are attached.\n\nA red pixel' })
    const preview = result.content.find(block => block.type === 'image')
    const original = result.content.find(block => block.type === 'file')
    expect(preview?.attachment).toMatchObject({ width: 1, height: 1, name: 'generated-1.png' })
    expect(original?.attachment).toMatchObject({ bytes: png.byteLength, name: 'generated-1.png' })
    if (preview === undefined || original === undefined) throw new Error('Missing generated attachments')
    expect((await ctx.attachments.readImage(preview.attachment)).data.byteLength).toBeGreaterThan(0)
    const chunks: Uint8Array[] = []
    for await (const chunk of ctx.attachments.readFileStream(original.attachment)) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(png)
  })

  it('rejects an unknown model through the executor', async () => {
    const { ctx } = await setup()
    const result = await generate(ctx, 'chat-only')
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: Unknown image model' }])
  })

  it('validates a whole batch before writing any previews or originals', async () => {
    const { ctx, root } = await setup({ maxImagesPerMessage: 1 })
    const provider = ctx.imageGeneration
    if (!(provider instanceof ImageFixture)) throw new Error('Missing fixture provider')
    provider.count = 2
    const saveFile = vi.spyOn(ctx.attachments, 'saveFile')
    const result = await generate(ctx)
    expect(result.isError).toBe(true)
    expect(saveFile).not.toHaveBeenCalled()
    expect(await readdir(join(root, 'attachments'), { recursive: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })).toEqual([])
  })

  it('projects generated previews and originals for a subsequent text-only chat request', async () => {
    const { ctx } = await setup()
    const result = await generate(ctx)
    let received: GenerateOptions | undefined
    class TextAdapter extends LlmAdapter {
      override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] as const }) }
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        received = options
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DONE' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['text'], new TextAdapter())
    const message = createToolResultMessage({ callId: ToolCallId('generate-1'), content: result.content, isError: result.isError })
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'text', model: 'chat', messages: [message] })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(received?.messages[0]?.content.every(block => block.type === 'text')).toBe(true)
    expect(JSON.stringify(received?.messages)).toContain('generated-1.png')
  })
})
