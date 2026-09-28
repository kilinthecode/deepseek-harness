import { describe, expect, it } from 'vitest'
import { assertWorktreeId } from '../src/index.ts'

describe('assertWorktreeId', () => {
  it.each(['wt-00000000', 'wt-deadbeef', 'wt-0123abcd'])('accepts %s', (id) => {
    expect(() => { assertWorktreeId(id) }).not.toThrow()
  })

  it.each([
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
  ])('rejects %s', (_label, id) => {
    expect(() => { assertWorktreeId(id) }).toThrow(
      `subagent-worktree: "${id}" is not a worktree id (expected "wt-" followed by eight lowercase hexadecimal digits)`,
    )
  })
})
