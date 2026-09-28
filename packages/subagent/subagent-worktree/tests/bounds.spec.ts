import { describe, expect, it } from 'vitest'
import { BASE_DIRTY_MAX_ENTRIES, boundedLines, DIAGNOSTIC_TAIL_CHARS, tailChars, truncateUtf8Prefix } from '../src/bounds.ts'

describe('tailChars', () => {
  it('returns short text unchanged', () => {
    expect(tailChars('short', 4000)).toBe('short')
  })

  it('keeps exactly the trailing maxChars characters when longer', () => {
    const text = `${'a'.repeat(10)}TAIL`
    expect(tailChars(text, 4)).toBe('TAIL')
  })
})

describe('truncateUtf8Prefix', () => {
  it('keeps a tiny text unchanged and reports no truncation', () => {
    const result = truncateUtf8Prefix('hi', 1024)
    expect(result).toEqual({ text: 'hi', truncated: false })
  })

  it('keeps text exactly at the byte bound unchanged', () => {
    const text = 'a'.repeat(16)
    const result = truncateUtf8Prefix(text, Buffer.byteLength(text, 'utf8'))
    expect(result).toEqual({ text, truncated: false })
  })

  it('truncates an oversized single-byte-character text to exactly the byte bound', () => {
    const text = 'a'.repeat(100)
    const result = truncateUtf8Prefix(text, 10)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('a'.repeat(10))
    expect(Buffer.byteLength(result.text, 'utf8')).toBe(10)
  })

  it('cuts back to the last complete character instead of splitting a multibyte one', () => {
    // Each 'é' (é) is 2 UTF-8 bytes; a 5-byte budget lands mid-character on the third one.
    const text = 'ééé'
    const result = truncateUtf8Prefix(text, 5)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('éé')
    expect(Buffer.byteLength(result.text, 'utf8')).toBe(4)
  })

  it('cuts back across a 4-byte character (astral emoji) without producing replacement bytes', () => {
    const emoji = '\u{1F600}' // 4 UTF-8 bytes
    const text = `ab${emoji}cd`
    // Budget lands inside the 4-byte emoji (2 leading ASCII bytes + 2 of the emoji's 4 bytes).
    const result = truncateUtf8Prefix(text, 4)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('ab')
    expect(Buffer.byteLength(result.text, 'utf8')).toBe(2)
  })

  it('keeps a complete multibyte character when the budget lands exactly on its boundary', () => {
    const text = 'éé' // 4 bytes total
    const result = truncateUtf8Prefix(text, 4)
    expect(result).toEqual({ text, truncated: false })
  })
})

describe('boundedLines', () => {
  it('reports zero entries for empty input', () => {
    expect(boundedLines('', BASE_DIRTY_MAX_ENTRIES)).toEqual({ entries: [], total: 0 })
  })

  it('keeps every line and the exact total when the count equals the bound', () => {
    const lines = Array.from({ length: BASE_DIRTY_MAX_ENTRIES }, (_, i) => `?? file-${i}`)
    const result = boundedLines(lines.join('\n'), BASE_DIRTY_MAX_ENTRIES)
    expect(result.entries).toEqual(lines)
    expect(result.total).toBe(BASE_DIRTY_MAX_ENTRIES)
  })

  it('bounds the entries but reports the true total when the count exceeds the bound', () => {
    const lines = Array.from({ length: BASE_DIRTY_MAX_ENTRIES + 1 }, (_, i) => `?? file-${i}`)
    const result = boundedLines(lines.join('\n'), BASE_DIRTY_MAX_ENTRIES)
    expect(result.entries).toEqual(lines.slice(0, BASE_DIRTY_MAX_ENTRIES))
    expect(result.total).toBe(BASE_DIRTY_MAX_ENTRIES + 1)
  })

  it('drops the empty trailing artifact from a final newline', () => {
    const result = boundedLines('?? a\n?? b\n', BASE_DIRTY_MAX_ENTRIES)
    expect(result).toEqual({ entries: ['?? a', '?? b'], total: 2 })
  })
})

describe('DIAGNOSTIC_TAIL_CHARS', () => {
  it('is the bound tailChars is exercised with elsewhere in the service', () => {
    expect(DIAGNOSTIC_TAIL_CHARS).toBe(4000)
  })
})
