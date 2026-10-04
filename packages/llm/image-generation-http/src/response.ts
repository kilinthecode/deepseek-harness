/** Bounded JSON receipt and complete inline raster-image decoding. */

import { sniffImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { GeneratedImage, ImageGenerationResult } from '@deepseek-ai/dsh-image-generation'
import type { ImageGenerationApi } from './config.ts'

/** Narrow a provider JSON object without assigning trust to its members. */
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Image API returned an invalid response object')
  }
  return value as Record<string, unknown>
}

/** Decode canonical inline bytes and require a supported raster signature. */
function image(encoded: unknown, declared: unknown): GeneratedImage {
  if (typeof encoded !== 'string' || encoded.length === 0) throw new Error('Image API did not return inline image bytes')
  const data = Buffer.from(encoded, 'base64')
  if (data.toString('base64') !== encoded) throw new Error('Image API returned invalid base64 image bytes')
  const mediaType = sniffImageMediaType(data)
  if (mediaType === undefined || (declared !== undefined && declared !== mediaType)) {
    throw new Error('Image API returned an unsupported raster format or a mismatched media type')
  }
  return { data, mediaType }
}

/**
 * Read the complete response without exceeding the encoded-body limit.
 * @param response - provider response whose body is tied to the request's abort signal.
 * @param maxBytes - maximum complete encoded JSON bytes.
 * @param signal - request cancellation, including its deadline.
 * @returns parsed, untrusted JSON.
 */
export async function readImageResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) throw new Error('Image API returned no response body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let ended = false
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) { ended = true; break }
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error(`Image API response exceeds the ${maxBytes}-byte limit`)
      chunks.push(chunk.value)
    }
    signal.throwIfAborted()
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  } finally {
    if (!ended) {
      try {
        await reader.cancel()
      } catch (error) {
        // A body already aborted by Fetch cannot be cancelled again.
        void error
      }
    }
    reader.releaseLock()
  }
}

/**
 * Decode one completed provider response. Refusals and responses without images fail.
 * @param api - explicitly selected image protocol.
 * @param value - untrusted response JSON.
 * @returns every returned raster image and non-reasoning provider text.
 */
export function decodeImageResponse(api: ImageGenerationApi, value: unknown): ImageGenerationResult {
  const response = object(value)
  const images: GeneratedImage[] = []
  const text: string[] = []
  if (api === 'google-generate-content') {
    if (!Array.isArray(response.candidates) || response.candidates.length === 0) {
      throw new Error('Image API returned no image candidate; generation may have been refused')
    }
    const candidate = object(response.candidates[0])
    if (candidate.finishReason !== undefined && candidate.finishReason !== 'STOP') {
      throw new Error('Image API did not complete image generation')
    }
    const parts = object(candidate.content).parts
    if (!Array.isArray(parts)) throw new Error('Image API returned no image parts')
    for (const item of parts) {
      const part = object(item)
      if (part.thought === true) continue
      if (typeof part.text === 'string') text.push(part.text)
      if (part.inlineData !== undefined) {
        const inline = object(part.inlineData)
        images.push(image(inline.data, inline.mimeType))
      }
    }
  } else {
    if (!Array.isArray(response.data)) throw new Error('Image API returned no image data')
    for (const item of response.data) {
      const entry = object(item)
      images.push(image(entry.b64_json, entry.media_type))
      if (typeof entry.revised_prompt === 'string') text.push(entry.revised_prompt)
    }
  }
  if (images.length === 0) throw new Error('Image API returned no images; generation may have been refused')
  return { images, ...text.length === 0 ? {} : { text: text.join('\n\n') } }
}
