import { describe, expect, it, vi } from 'vitest'
import { compileMatcher, matcherDiagnostic, matchesMatcher } from '@deepseek-ai/dsh-hook-protocol'

describe('compileMatcher', () => {
  it('reuses one compiled matcher across queries without changing dialect semantics', () => {
    const claude = compileMatcher('Edit|Write', 'claude-code')
    expect(claude('Edit')).toBe(true)
    expect(claude('EditFile')).toBe(false)

    const codex = compileMatcher('Edit|Write', 'codex')
    expect(codex('Edit')).toBe(true)
    expect(codex('Read')).toBe(false)
  })

  it.each(['claude-code', 'codex'] as const)('keeps match-all sentinels reusable in %s mode', (mode) => {
    for (const matcher of [undefined, '', '*']) {
      const matches = compileMatcher(matcher, mode)
      expect(matches('Read')).toBe(true)
      expect(matches('')).toBe(true)
    }
  })

  it('constructs the regular expression once across repeated queries', () => {
    const NativeRegExp = RegExp
    const constructors = vi.spyOn(globalThis, 'RegExp').mockImplementation(function (pattern, flags) {
      return new NativeRegExp(pattern, flags)
    })
    try {
      const matches = compileMatcher('^Edit', 'codex')
      for (let index = 0; index < 64; index++) {
        expect(matches(index % 2 === 0 ? 'EditFile' : 'Read')).toBe(index % 2 === 0)
      }
      expect(constructors.mock.calls.filter(([pattern]) => pattern === '^Edit')).toHaveLength(1)
    } finally {
      constructors.mockRestore()
    }
  })

  it('contains an invalid regex as a non-match', () => {
    expect(compileMatcher('[', 'codex')('value')).toBe(false)
  })
})

describe('matchesMatcher — match-all sentinels (both dialects)', () => {
  for (const mode of ['claude-code', 'codex'] as const) {
    it(`${mode}: absent / empty / '*' match everything`, () => {
      expect(matchesMatcher(undefined, 'Bash', mode)).toBe(true)
      expect(matchesMatcher('', 'anything', mode)).toBe(true)
      expect(matchesMatcher('*', 'whatever', mode)).toBe(true)
    })
  }
})

describe('matchesMatcher — claude dialect (literal-or-regex)', () => {
  it('a pure word-char pattern is a LITERAL exact match (not substring)', () => {
    expect(matchesMatcher('Bash', 'Bash', 'claude-code')).toBe(true)
    // literal exact: "Bash" must NOT match "BashOutput" (a regex would, substring)
    expect(matchesMatcher('Bash', 'BashOutput', 'claude-code')).toBe(false)
  })

  it('a pipe pattern is literal ALTERNATION (exact match any alternative)', () => {
    expect(matchesMatcher('Edit|Write', 'Edit', 'claude-code')).toBe(true)
    expect(matchesMatcher('Edit|Write', 'Write', 'claude-code')).toBe(true)
    expect(matchesMatcher('Edit|Write', 'Read', 'claude-code')).toBe(false)
    // still exact per-alternative, not substring
    expect(matchesMatcher('Edit|Write', 'EditFile', 'claude-code')).toBe(false)
  })

  it('a non-word pattern falls through to regex (unanchored)', () => {
    expect(matchesMatcher('^Bash$', 'Bash', 'claude-code')).toBe(true)
    expect(matchesMatcher('Bash.*', 'BashOutput', 'claude-code')).toBe(true)
    expect(matchesMatcher('.*\\.ts$', 'foo.ts', 'claude-code')).toBe(true)
    expect(matchesMatcher('.*\\.ts$', 'foo.js', 'claude-code')).toBe(false)
  })
})

describe('matchesMatcher — codex dialect (always regex)', () => {
  it('a word pattern is an unanchored regex (substring matches, unlike claude literal)', () => {
    expect(matchesMatcher('Bash', 'Bash', 'codex')).toBe(true)
    // codex has NO literal fast path: "Bash" is /Bash/, so it DOES match a substring
    expect(matchesMatcher('Bash', 'BashOutput', 'codex')).toBe(true)
  })

  it('regex alternation and anchors work', () => {
    expect(matchesMatcher('Edit|Write', 'Edit', 'codex')).toBe(true)
    expect(matchesMatcher('^Bash$', 'Bash', 'codex')).toBe(true)
    expect(matchesMatcher('^Bash$', 'BashOutput', 'codex')).toBe(false)
  })
})

describe('matchesMatcher — invalid regex is a non-match (never throws)', () => {
  it('an unbalanced pattern matches nothing rather than throwing', () => {
    // '(' is not the claude-literal charset, so it goes to the regex path and is invalid.
    expect(() => matchesMatcher('(', 'x', 'claude-code')).not.toThrow()
    expect(matchesMatcher('(', 'x', 'claude-code')).toBe(false)
    expect(matchesMatcher('[', 'x', 'codex')).toBe(false)
  })
})

describe('matcherDiagnostic — parse-time diagnostics', () => {
  it('accepts match-all sentinels, Claude literals, and valid regexes', () => {
    expect(matcherDiagnostic(undefined, 'claude-code')).toBeUndefined()
    expect(matcherDiagnostic('', 'codex')).toBeUndefined()
    expect(matcherDiagnostic('*', 'codex')).toBeUndefined()
    expect(matcherDiagnostic('Edit|Write', 'claude-code')).toBeUndefined()
    expect(matcherDiagnostic('^Bash$', 'claude-code')).toBeUndefined()
    expect(matcherDiagnostic('Edit|Write', 'codex')).toBeUndefined()
  })

  it('returns a stable diagnostic for invalid regexes in either dialect', () => {
    expect(matcherDiagnostic('(', 'claude-code')).toBe('invalid claude-code regex matcher "("')
    expect(matcherDiagnostic('[', 'codex')).toBe('invalid codex regex matcher "["')
  })
})
