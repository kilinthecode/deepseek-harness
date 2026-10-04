/** Image-model discovery and generation tools with durable previews and original files. */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-image-generation'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, jsonOutput } from '@deepseek-ai/dsh-tools'

/** Loader identity for image-generation tools. */
export const name = 'tool-image-generation'

/** Durable storage and an active generation provider are required for discovery and execution. */
export const inject = ['tools', 'imageGeneration', 'attachments']

const imageSchema = {
  type: 'object', additionalProperties: false, required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object', additionalProperties: false,
      properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } },
    },
  },
} as const

const fileSchema = {
  type: 'object', additionalProperties: false, required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    name: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
  },
} as const

/** Canonical JSON outcome projected into durable result content. */
interface ImageToolValue {
  provider: string
  model: string
  images: { preview: Omit<ImageAttachmentRef, 'attachmentId'> & { attachmentId: string }; original: Omit<FileAttachmentRef, 'attachmentId'> & { attachmentId: string } }[]
  text?: string
}

/** Durable references are reconstructed from the tool's validated canonical value. */
function render(value: ImageToolValue): ContentBlock[] {
  return [
    { type: 'text', text: `Generated ${value.images.length} image(s) with ${value.provider}/${value.model}. Original files are attached.${value.text === undefined ? '' : `\n\n${value.text}`}` },
    ...value.images.flatMap(({ preview, original }): ContentBlock[] => [
      { type: 'image', attachment: { ...preview, attachmentId: AttachmentId(preview.attachmentId) } },
      { type: 'file', attachment: { ...original, attachmentId: AttachmentId(original.attachmentId) } },
    ]),
  ]
}

/**
 * Register discovery and generation. A complete batch is validated before storage; originals retain exact API bytes.
 * @param ctx - context with tools, an image-generation provider, and attachments.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'list_image_models',
    description: 'List configured image-generation models. Use the returned provider and model with generate_image.',
    parameters: {},
    output: jsonOutput({
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
    }),
    isConcurrencySafe: () => true,
    execute() { return Promise.resolve([...ctx.imageGeneration.listModels()]) },
  }))
  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate images from a text description using a model from list_image_models. Returns image previews and original image files.',
    parameters: {
      provider: { type: 'string', required: true, description: 'Provider returned by list_image_models.' },
      model: { type: 'string', required: true, description: 'Image model returned by list_image_models.' },
      prompt: { type: 'string', required: true, description: 'Describe the image to create, including subject, style, composition, and any text.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          text: { type: 'string' },
          images: {
            type: 'array', required: true, items: {
              type: 'object', additionalProperties: false,
              properties: { preview: imageSchema, original: fileSchema },
            },
          },
        },
      },
      render: (_args, value) => render(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ImageToolValue> {
      exec.signal.throwIfAborted()
      const prepared = ctx.imageGeneration.prepare(args)
      const result = await prepared.generate(exec.signal)
      exec.signal.throwIfAborted()
      const inputs = result.images.map((image, index) => ({
        ...image, name: `generated-${index + 1}.${image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType.slice('image/'.length)}`,
      }))
      const previews = await ctx.attachments.saveImages(inputs)
      const images: ImageToolValue['images'] = []
      for (const [index, input] of inputs.entries()) {
        exec.signal.throwIfAborted()
        const original = await ctx.attachments.saveFile(input)
        // saveImages returns one reference per input in the same order.
        images.push({ preview: previews[index] as ImageAttachmentRef, original })
      }
      exec.signal.throwIfAborted()
      return {
        provider: prepared.model.provider, model: prepared.model.model, images,
        ...result.text === undefined ? {} : { text: result.text },
      }
    },
    presentCall(args) {
      return { card: 'generic', title: args.model, kind: 'other', rawInput: args.prompt }
    },
  }))
}
