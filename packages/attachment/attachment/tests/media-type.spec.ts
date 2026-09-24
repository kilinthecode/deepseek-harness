/** Extension mapping and file-signature sniffing shared by every image-admitting caller. */

import { describe, expect, it } from 'vitest'
import { imageMediaTypeForPath, sniffImageMediaType } from '../src/index.ts'

describe('imageMediaTypeForPath', () => {
  it('maps the four extensions case-insensitively and rejects everything else', () => {
    expect(imageMediaTypeForPath('a.png')).toBe('image/png')
    expect(imageMediaTypeForPath('a.JPG')).toBe('image/jpeg')
    expect(imageMediaTypeForPath('b.jpeg')).toBe('image/jpeg')
    expect(imageMediaTypeForPath('c.webp')).toBe('image/webp')
    expect(imageMediaTypeForPath('d.Gif')).toBe('image/gif')
    expect(imageMediaTypeForPath('note.txt')).toBeUndefined()
    expect(imageMediaTypeForPath('png')).toBeUndefined()
  })
})

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

describe('sniffImageMediaType', () => {
  it('identifies each supported container from its complete signature', () => {
    expect(sniffImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png')
    expect(sniffImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMediaType(ascii('GIF87a...'))).toBe('image/gif')
    expect(sniffImageMediaType(ascii('GIF89a...'))).toBe('image/gif')
    expect(sniffImageMediaType(ascii('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  })

  it('returns undefined for other bytes, incomplete signatures, and non-WebP RIFF containers', () => {
    expect(sniffImageMediaType(new Uint8Array())).toBeUndefined()
    expect(sniffImageMediaType(ascii('plain text'))).toBeUndefined()
    expect(sniffImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e]))).toBeUndefined()
    expect(sniffImageMediaType(Uint8Array.from([0xff, 0xd8]))).toBeUndefined()
    expect(sniffImageMediaType(ascii('GIF90a'))).toBeUndefined()
    expect(sniffImageMediaType(ascii('RIFF\0\0\0\0WAVE'))).toBeUndefined()
    expect(sniffImageMediaType(ascii('RIFF\0\0\0'))).toBeUndefined()
  })
})
