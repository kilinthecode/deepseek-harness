/** Route parsing, label derivation, check-command splitting, and reused-worktree directory resolution. */

import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  deriveLabel,
  MAX_LABEL_LENGTH,
  parseRouteFlag,
  required,
  resolveReviewerOverride,
  resolveWorkDir,
  resolveWorkerRoute,
  splitTestCommand,
  toModelSelection,
} from '../src/route.ts'

describe('parseRouteFlag', () => {
  it('splits provider and model on the first slash', () => {
    expect(parseRouteFlag('--model', 'openai/gpt-5')).toEqual({ provider: 'openai', model: 'gpt-5' })
    expect(parseRouteFlag('--model', 'openai/gpt-5/preview')).toEqual({ provider: 'openai', model: 'gpt-5/preview' })
  })

  it.each(['', 'noslash', '/model', 'provider/', '/'])('rejects a malformed route %j', (value) => {
    expect(() => parseRouteFlag('--model', value)).toThrow('--model must be <provider>/<model>')
  })
})

describe('resolveWorkerRoute', () => {
  const fallback = { provider: 'fallback-provider', model: 'fallback-model' }

  it('uses the fallback when --model is omitted', () => {
    expect(resolveWorkerRoute(undefined, undefined, fallback)).toBe(fallback)
    expect(resolveWorkerRoute(undefined, 'high', fallback)).toBe(fallback)
  })

  it('parses --model and carries --effort when given', () => {
    expect(resolveWorkerRoute('openai/gpt-5', undefined, fallback)).toEqual({ provider: 'openai', model: 'gpt-5' })
    expect(resolveWorkerRoute('openai/gpt-5', 'high', fallback)).toEqual({ provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' })
  })

  it('propagates a malformed --model', () => {
    expect(() => resolveWorkerRoute('bogus', undefined, fallback)).toThrow('--model must be <provider>/<model>')
  })
})

describe('resolveReviewerOverride', () => {
  it('is undefined when --reviewer is omitted', () => {
    expect(resolveReviewerOverride(undefined, undefined)).toBeUndefined()
    expect(resolveReviewerOverride(undefined, 'high')).toBeUndefined()
  })

  it('parses --reviewer and carries --reviewer-effort when given', () => {
    expect(resolveReviewerOverride('anthropic/opus', undefined)).toEqual({ provider: 'anthropic', model: 'opus' })
    expect(resolveReviewerOverride('anthropic/opus', 'high'))
      .toEqual({ provider: 'anthropic', model: 'opus', reasoningEffort: 'high' })
  })

  it('propagates a malformed --reviewer', () => {
    expect(() => resolveReviewerOverride('bogus', undefined)).toThrow('--reviewer must be <provider>/<model>')
  })
})

describe('splitTestCommand', () => {
  it('splits on whitespace and drops empty tokens', () => {
    expect(splitTestCommand('pnpm run test')).toEqual(['pnpm', 'run', 'test'])
    expect(splitTestCommand('  pnpm   run    test  ')).toEqual(['pnpm', 'run', 'test'])
  })

  it('keeps a single-token command intact', () => {
    expect(splitTestCommand('make')).toEqual(['make'])
  })
})

describe('deriveLabel', () => {
  it('uses the first line, collapsing internal whitespace', () => {
    expect(deriveLabel('add   the   parser\nand its tests')).toBe('add the parser')
  })

  it('falls back to the whole task when the first line is blank', () => {
    expect(deriveLabel('\n\nadd the parser')).toBe('add the parser')
  })

  it(`truncates a label longer than ${String(MAX_LABEL_LENGTH)} characters with an ellipsis`, () => {
    const long = 'x'.repeat(MAX_LABEL_LENGTH + 10)
    const label = deriveLabel(long)
    expect(label.length).toBe(MAX_LABEL_LENGTH)
    expect(label.endsWith('…')).toBe(true)
  })

  it('keeps a label exactly at the bound unchanged', () => {
    const exact = 'x'.repeat(MAX_LABEL_LENGTH)
    expect(deriveLabel(exact)).toBe(exact)
  })
})

describe('toModelSelection', () => {
  it('carries provider and model without reasoningEffort', () => {
    expect(toModelSelection({ provider: 'p', model: 'm' })).toEqual({ provider: 'p', model: 'm' })
  })

  it('carries a present reasoningEffort through unchanged', () => {
    expect(toModelSelection({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') }))
      .toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })
})

describe('resolveWorkDir', () => {
  it('joins the worktree path with baseDir relative to the repository root', () => {
    expect(resolveWorkDir({ path: '/wt/wt-1', repoRoot: '/repo' }, '/repo/packages/foo'))
      .toBe('/wt/wt-1/packages/foo')
  })

  it('resolves to the worktree root itself when baseDir is the repository root', () => {
    expect(resolveWorkDir({ path: '/wt/wt-1', repoRoot: '/repo' }, '/repo')).toBe('/wt/wt-1')
  })
})

describe('required', () => {
  it('returns a defined value unchanged', () => {
    expect(required('x', 'unused')).toBe('x')
    expect(required(0, 'unused')).toBe(0)
  })

  it('throws the supplied message for undefined', () => {
    expect(() => { required(undefined, 'agents-runner: missing field') }).toThrow('agents-runner: missing field')
  })
})
