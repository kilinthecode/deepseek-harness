/** Delegation-tree root resolution from durable session-header lineage. */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, delegationTreeRoot } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

function header(id: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 0,
    isSeeded: false,
    ...overrides,
  }
}

describe('delegationTreeRoot', () => {
  it('is its own root for a top-level session, without consulting the lookup', () => {
    const top = header('top')
    const lookup = (): SessionHeader => { throw new Error('must not look up an ancestor for a top-level session') }
    expect(delegationTreeRoot(top, lookup)).toBe(SessionId('top'))
  })

  it('resolves a fresh depth-1 child to its loadable top-level parent', () => {
    const parent = header('parent')
    const child = header('child', { parentSession: SessionId('parent'), origin: 'subagent', delegationDepth: 1 })
    const lookup = (id: SessionId): SessionHeader | undefined => id === SessionId('parent') ? parent : undefined
    expect(delegationTreeRoot(child, lookup)).toBe(SessionId('parent'))
  })

  it('resolves a fork child the same way as a fresh child', () => {
    const parent = header('parent')
    const fork = header('fork-child', { parentSession: SessionId('parent'), isSeeded: true })
    const lookup = (id: SessionId): SessionHeader | undefined => id === SessionId('parent') ? parent : undefined
    expect(delegationTreeRoot(fork, lookup)).toBe(SessionId('parent'))
  })

  it('walks past a loadable intermediate parent to the depth-2 root', () => {
    const grandparent = header('grandparent')
    const parent = header('parent', { parentSession: SessionId('grandparent'), origin: 'subagent', delegationDepth: 1 })
    const child = header('child', { parentSession: SessionId('parent'), origin: 'subagent', delegationDepth: 2 })
    const lookup = (id: SessionId): SessionHeader | undefined =>
      id === SessionId('parent') ? parent : id === SessionId('grandparent') ? grandparent : undefined
    expect(delegationTreeRoot(child, lookup)).toBe(SessionId('grandparent'))
  })

  it('stops at the nearest known ancestor when a depth-2 chain\'s direct parent is not loadable', () => {
    const child = header('child', { parentSession: SessionId('parent'), origin: 'subagent', delegationDepth: 2 })
    const lookup = (): SessionHeader | undefined => undefined
    expect(delegationTreeRoot(child, lookup)).toBe(SessionId('parent'))
  })

  it('stops instead of looping forever on a cyclic lineage', () => {
    const a = header('a', { parentSession: SessionId('b') })
    const b = header('b', { parentSession: SessionId('a') })
    const lookup = (id: SessionId): SessionHeader | undefined => id === SessionId('a') ? a : id === SessionId('b') ? b : undefined
    expect(delegationTreeRoot(a, lookup)).toBe(SessionId('a'))
  })
})
