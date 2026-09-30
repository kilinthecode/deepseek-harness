// ComposerRouteImageRegistry: the per-session route-image advisory store the
// composer reads through ctx.conversation.routeImage. Mirrors blocks.ts'
// registry contract (initial value, dedup, and forget).
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ComposerRouteImageRegistry } from '../src/client/input/route-image.ts'

const SID = 's1' as SessionId

describe('ComposerRouteImageRegistry', () => {
  it('starts every session at null and returns the same store on repeated lookups', () => {
    const registry = new ComposerRouteImageRegistry()
    const store = registry.storeFor(SID)
    expect(store.getSnapshot()).toBeNull()
    expect(registry.storeFor(SID)).toBe(store)
  })

  it('publishes a set value to subscribers and skips a redundant notify of the same value', () => {
    const registry = new ComposerRouteImageRegistry()
    const store = registry.storeFor(SID)
    const listener = vi.fn()
    store.subscribe(listener)

    registry.set(SID, false)
    expect(store.getSnapshot()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)

    registry.set(SID, false)
    expect(listener).toHaveBeenCalledTimes(1)

    registry.set(SID, true)
    expect(store.getSnapshot()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)

    registry.set(SID, null)
    expect(store.getSnapshot()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('drops a forgotten session store, so the next lookup starts fresh at null', () => {
    const registry = new ComposerRouteImageRegistry()
    const first = registry.storeFor(SID)
    registry.set(SID, false)
    registry.forget(SID)
    const second = registry.storeFor(SID)
    expect(second).not.toBe(first)
    expect(second.getSnapshot()).toBeNull()
  })
})
