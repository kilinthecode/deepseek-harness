// @vitest-environment jsdom
/**
 * Subscription-identity account for the scoped-slots uSES pairs.
 *
 * Re-rendering the parent of a Slot outlet or of a Factory outlet must not
 * churn the host version subscription, and a ScopeAreaProvider re-render must
 * not resubscribe its binding source: uSES re-runs its subscribe effect
 * whenever the subscribe reference changes, so fresh closures per render cost
 * one unsubscribe/subscribe pair per render for inputs that never vary.
 *
 * Every case spies on the very object the renderer is handed, with call
 * through — a swapped-in counting proxy would dodge the identity the caches
 * key on and hide exactly the churn under test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, type RenderResult } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { SessionBinding as ControllerBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  type SessionProviderComponent, type SlotEntryDef, type SlotRendererHost, type SlotScopeAdapter,
  type SlotSpec, type StandardSourceBinding, type StoredEntry, type StoredFactory,
} from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from '../src/client/scoped-slots.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type RenderSlotFn = (key: string, owner: object) => ReactNode
type RenderFactorySlotFn = (name: string, inputProps: object) => ReactNode

/** Bare observable source: the uSES currency every subscription pair binds to. */
interface Observable<T> {
  getSnapshot: () => T
  subscribe: (fn: () => void) => () => void
  set: (next: T) => void
}

function observable<T>(initial: T): Observable<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set: (next) => { value = next; for (const fn of [...listeners]) fn() },
  }
}

const SINGLE_ROOT: SlotSpec<SlotEntryDef> = { kind: 'single', scope: 'root' }
const SINGLE_SESSION: SlotSpec<SlotEntryDef> = { kind: 'single', scope: 'session' }

const EMPTY_BINDING: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }

interface Harness {
  host: SlotRendererHost
  declare(key: string, spec: SlotSpec<SlotEntryDef>): void
  addEntry(key: string, entry: Omit<StoredEntry, 'options'> & { options?: StoredEntry['options'] }): void
  registerFactory(definition: StoredFactory): void
  addSession(id: string): { reference: SessionReference; source: Observable<StandardSourceBinding> }
}

/**
 * Minimal behavioral host. The version axes are inert (always 0) because the
 * count under test is subscription churn, not notification: live-version
 * semantics belong to the fake/real core suites.
 */
function makeHarness(): Harness {
  const specs = new Map<string, SlotSpec<SlotEntryDef>>()
  const entries = new Map<string, StoredEntry[]>()
  const factories = new Map<string, StoredFactory>()
  const absent = observable<StandardSourceBinding>(EMPTY_BINDING)
  const sources = new Map<SessionReference, Observable<StandardSourceBinding>>()
  const sessionAdapter: SlotScopeAdapter = {
    current: absent,
    bindingSource: target => target === undefined ? absent : sources.get(target) ?? absent,
    renderArea: (binding, { empty, children }) => binding.key === undefined
      ? <>{empty?.() ?? null}</>
      : <>{children}</>,
  }
  const host: SlotRendererHost = {
    subscribe: () => () => {},
    getVersion: () => 0,
    entriesOf: key => entries.get(key) ?? [],
    entriesOfSlot: key => entries.get(key) ?? [],
    reportEntryError: () => {},
    reportFactoryError: () => {},
    specOf: key => specs.get(key),
    isLive: () => true,
    storeOf: () => undefined,
    factoryStoreOf: () => undefined,
    retainFactoryOccurrence: () => () => {},
    subscribeFactory: () => () => {},
    getFactoryVersion: () => 0,
    factoryOf: name => factories.get(name),
    isFactoryLive: () => true,
    root: observable<StandardSourceBinding>(EMPTY_BINDING),
    scopeRevision: observable(0),
    scope: () => sessionAdapter,
  }
  return {
    host,
    declare: (key, spec) => { specs.set(key, spec) },
    addEntry: (key, entry) => {
      const stored: StoredEntry = { ...entry, options: entry.options ?? {} }
      entries.set(key, [...(entries.get(key) ?? []), stored])
    },
    registerFactory: (definition) => { factories.set(definition.name, definition) },
    addSession: (id) => {
      const binding: StandardSourceBinding = { key: id, hooks: {}, keyedHooks: {}, props: { sessionId: id } }
      const source = observable<StandardSourceBinding>(binding)
      const release = (): void => {}
      const reference: SessionReference = {
        sessionId: id as SessionId,
        binding: { sessionId: id } as ControllerBinding,
        ready: Promise.resolve({ sessionId: id } as ControllerBinding),
        release,
        [Symbol.dispose]: release,
      }
      sources.set(reference, source)
      return { reference, source }
    },
  }
}

const renderer = createSlotRenderer()

/**
 * Mount the renderer's single root entry, then walk the same element tree
 * again `times` times: exactly the parent re-render the subscription-identity
 * caches exist to absorb.
 */
function mountAndRerender(host: SlotRendererHost, times: number): RenderResult {
  const tree = () => <>{renderer.renderRoot(host, {})}</>
  const view = render(tree())
  for (let index = 0; index < times; index += 1) view.rerender(tree())
  return view
}

describe('scoped-slot subscription identity', () => {
  it('subscribes a Slot outlet and a Factory outlet exactly once each across 20 parent re-renders', () => {
    const h = makeHarness()
    h.declare('k.single', SINGLE_ROOT)
    h.addEntry('k.single', { component: () => <b>row</b> })
    h.registerFactory({ name: 'renderer.factory', scope: 'root', component: () => <i>factory</i> })
    h.addEntry('root', {
      component: ({ renderSlot, renderFactorySlot }: {
        renderSlot: RenderSlotFn
        renderFactorySlot: RenderFactorySlotFn
      }) => (
        <>
          {renderSlot('k.single', {})}
          {renderFactorySlot('renderer.factory', {})}
        </>
      ),
      children: { 'k.single': SINGLE_ROOT },
    })
    // Spies on the very host handed to the renderer, calling through: the
    // subscription caches key on this object's identity, so the spy must BE
    // that object, not a wrapper around it.
    const subscribe = vi.spyOn(h.host, 'subscribe')
    const subscribeFactory = vi.spyOn(h.host, 'subscribeFactory')

    const view = mountAndRerender(h.host, 20)

    expect(view.container.textContent).toBe('rowfactory')
    expect(subscribe.mock.calls.filter(([key]) => key === 'k.single')).toHaveLength(1)
    expect(subscribeFactory.mock.calls.filter(([name]) => name === 'renderer.factory')).toHaveLength(1)
  })

  it('does not resubscribe a ScopeAreaProvider binding source across 20 parent re-renders', () => {
    const h = makeHarness()
    const { reference, source } = h.addSession('s1')
    h.declare('k.session', SINGLE_SESSION)
    h.addEntry('root', {
      component: ({ renderSlot, SessionProvider }: {
        renderSlot: RenderSlotFn
        SessionProvider: SessionProviderComponent
      }) => (
        <SessionProvider session={reference} empty={() => <i>empty</i>}>
          {renderSlot('k.session', {})}
        </SessionProvider>
      ),
      children: { 'k.session': SINGLE_SESSION },
    })
    const subscribe = vi.spyOn(source, 'subscribe')

    mountAndRerender(h.host, 20)

    expect(subscribe).toHaveBeenCalledTimes(1)
  })
})
