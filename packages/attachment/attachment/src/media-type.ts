/**
 * Media-type identification shared by every image-admitting caller: a path's
 * declared extension, and a file-signature sniff for extension-less paths.
 * Both stay advisory — {@link AttachmentStore.saveImage} decodes and verifies
 * the bytes authoritatively before committing a durable reference.
 * @module @deepseek-ai/dsh-attachment/media-type
 */

import { extname } from 'node:path'
import type { ImageMediaType } from './types.ts'

/** Extensions this package recognizes as images; magic-byte validation at admission stays authoritative. */
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const

function matchesBytes(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (data.byteLength < offset + expected.length) return false
  return expected.every((byte, index) => data[offset + index] === byte)
}

function matchesAscii(data: Uint8Array, offset: number, value: string): boolean {
  if (data.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

/**
 * Map a caller-supplied path to its declared image media type by extension.
 * @param filePath - the raw, not-yet-resolved path.
 * @returns the declared media type, or undefined when the path does not claim a supported image extension.
 */
export function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

/**
 * Identify the media type declared by a supported image file signature.
 * @param data - file bytes read through the caller's filesystem backend.
 * @returns the detected supported media type, or undefined for other bytes.
 */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesBytes(data, 0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif'
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}
