import { describe, expect, it } from 'vitest'
import { assertWorktreeId } from '../src/index.ts'
import { isWorktreeId } from '../src/worktree-id.ts'

const VALID_IDS = ['wt-00000000', 'wt-deadbeef', 'wt-0123abcd']

const INVALID_IDS: Array<[label: string, id: string]> = [
  ['a path traversal', '../x'],
  ['a traversal after the prefix', 'wt-../../x'],
  ['uppercase hex', 'wt-DEADBEEF'],
  ['too few digits', 'wt-deadbee'],
  ['too many digits', 'wt-deadbeef0'],
  ['non-hex digits', 'wt-deadbeeg'],
  ['no prefix', 'deadbeef'],
  ['an empty string', ''],
  ['a trailing newline', 'wt-deadbeef\n'],
  ['a leading space', ' wt-deadbeef'],
  ['a trailing path segment', 'wt-deadbeef/..'],
]

describe('assertWorktreeId', () => {
  it.each(VALID_IDS)('accepts %s', (id) => {
    expect(() => { assertWorktreeId(id) }).not.toThrow()
  })

  it.each(INVALID_IDS)('rejects %s', (_label, id) => {
    expect(() => { assertWorktreeId(id) }).toThrow(
      `subagent-worktree: "${id}" is not a worktree id (expected "wt-" followed by eight lowercase hexadecimal digits)`,
    )
  })
})

describe('isWorktreeId', () => {
  it.each(VALID_IDS)('is true for %s', (id) => {
    expect(isWorktreeId(id)).toBe(true)
  })

  it.each(INVALID_IDS)('is false for %s', (_label, id) => {
    expect(isWorktreeId(id)).toBe(false)
  })
})
