/** Provider-independent text-to-image generation and prepared calls. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

declare module '@deepseek-ai/cordis' {
  interface Context {
    imageGeneration: ImageGenerationProvider
  }
}

/** A configured model that the image provider can generate with. */
export interface ImageGenerationModel {
  /** Configuration route identifying the provider. */
  readonly provider: string
  /** Exact model identifier accepted by the image API. */
  readonly model: string
  /** Human-readable model name. */
  readonly name: string
}

/** An explicit model selection and text prompt; no chat-model fallback applies. */
export interface ImageGenerationRequest {
  readonly provider: string
  readonly model: string
  readonly prompt: string
}

/** Encoded raster bytes awaiting validation and durable attachment storage. */
export interface GeneratedImage {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
}

/** A complete generation response; providers reject responses without images. */
export interface ImageGenerationResult {
  readonly images: readonly GeneratedImage[]
  /** Provider-visible explanation accompanying the generated images, when present. */
  readonly text?: string
}

/** One request bound to a single provider configuration generation. */
export interface PreparedImageGeneration {
  readonly model: ImageGenerationModel
  /**
   * Generate once per invocation without automatic retries. Consumers persist images before logging results.
   * @param signal - cancellation for the whole provider request.
   * @returns the complete encoded images and any accompanying text.
   */
  generate(signal: AbortSignal): Promise<ImageGenerationResult>
}

/**
 * Image-generation capability. Mount a provider subclass to register `ctx.imageGeneration`.
 * Providers enforce configured model membership for every caller and bind configuration during preparation.
 */
export abstract class ImageGenerationProvider extends Service {
  constructor(ctx: Context) {
    super(ctx, 'imageGeneration')
  }

  /**
   * List explicitly configured generation models, independently of the chat-model catalog.
   * @returns model identities and display names; never credentials or endpoints.
   */
  abstract listModels(): readonly ImageGenerationModel[]

  /**
   * Validate a selection and bind its prompt and provider configuration before any network request.
   * @param request - explicit provider, model, and non-blank generation prompt.
   * @returns a generation call bound to that configuration.
   * @throws when the provider, model, or prompt cannot be served.
   */
  abstract prepare(request: ImageGenerationRequest): PreparedImageGeneration
}

export default ImageGenerationProvider
