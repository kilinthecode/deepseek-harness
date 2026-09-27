/** Models section registration: slot declaration injection, the locale-following label thunk, and HMR recovery. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'
import { ok, RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import type { AuthorizationView } from '@deepseek-ai/dsh-api-authorization-controller/types'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, refreshIfLoaded } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import { DeepSeekOnboardingDialog } from '../src/client/DeepSeekOnboardingDialog.tsx'
import { WelcomeNotice } from '../src/client/WelcomeNotice.tsx'
import { providerUsable } from '../src/client/store.ts'
import { en, zh, type ModelsKey } from '../src/client/locales.ts'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as hostPlugin from '../src/index.ts'
import { ONBOARDING_CONFIG_GLOBAL } from '../src/onboarding-config.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** A view listing no sign-in flow, as the page holds it before the first frame. */
const NO_FLOWS: AuthorizationView = { flows: [], attempt: null }

/**
 * The `remote.authorization` namespace and the Gateway stream supervisor that
 * carries it, scripted together: the plugin's own opener subscribes to `watch`,
 * `push` delivers one Host view the way a frame arrives, and `end` closes the
 * generation the way a terminal carrier end does.
 * @returns the scripted namespace, the supervisor, and the frame driver.
 */
function authorizationWire() {
  const queued: AuthorizationView[] = []
  /** Every option set the plugin subscribed with. */
  const opened: Array<{
    name: string
    open: (signal: AbortSignal) => AsyncIterable<AuthorizationView>
    ended: (accepted: boolean) => Error
  }> = []
  const accepted = vi.fn()
  let deliver: (() => void) | undefined
  let ended = false
  const wake = (): void => { deliver?.(); deliver = undefined }

  /** The Host's watch generation: one queued view per push, until the spec ends it. */
  async function* watch(signal: AbortSignal): AsyncGenerator<AuthorizationView> {
    while (!ended && !signal.aborted) {
      const view = queued.shift()
      if (view !== undefined) {
        yield view
        continue
      }
      await new Promise<void>((resolve) => { deliver = resolve })
    }
  }

  const authorization = {
    getState: vi.fn(() => Promise.resolve({ ok: true as const, value: NO_FLOWS })),
    watch: vi.fn((signal: AbortSignal) => watch(signal)),
  }

  const supervise = (options: (typeof opened)[number]) => {
    opened.push(options)
    const lifetime = new AbortController()
    return {
      signal: lifetime.signal,
      async *[Symbol.asyncIterator]() {
        for await (const value of options.open(lifetime.signal)) {
          yield { generation: 1, value, signal: lifetime.signal, accept: accepted }
        }
        // The supervisor returns quietly when its own lifetime aborts; any other
        // generation end is the plugin's `ended` to classify, and throwing it is
        // how its consumer sees that.
        if (lifetime.signal.aborted) return
        throw options.ended(true)
      },
      dispose: async () => { lifetime.abort(); wake() },
    }
  }

  return {
    authorization,
    supervise,
    /** Deliver one Host view to the subscribed consumer. */
    push(view: AuthorizationView): void { queued.push(view); wake() },
    /** End the Host generation as a terminal carrier end does. */
    end(): void { ended = true; wake() },
    opened,
    accepted,
  }
}

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

async function bench(isLoopback = true, mock = RemoteMock.create().load(remoteDefaultResponses), services: object = {}) {
  onTestFinished(() => { mock.assertNoUnmatched() })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const wire = authorizationWire()
  const remote = new TestRemote(ctx, {
    credentials: {
      describe: vi.fn(() => Promise.resolve({ ok: true, value: {} })),
      set: vi.fn(),
      unset: vi.fn(),
    },
    llm: {
      listProviders: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      listConfigurableProviders: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      discoverModels: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      ...services,
    },
    authorization: wire.authorization,
    settings: mock.remote.settings,
    session: { initializeDefaultModel: vi.fn(async () => ({ ok: true, value: undefined })) },
  })
  // The Gateway's stream supervisor, which this double does not carry: the
  // plugin subscribes through it and the script above stands in for the wire.
  Object.assign(remote, { $stream: wire.supervise })
  // The fixed Host facts the settings provider reads its persistence from.
  remote.$host = { home: undefined, isLoopback }
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, remote, wire }
}

/** The sign-in copy the Models rows and the authorization dialog render. */
const SIGN_IN_KEYS = [
  'signIn', 'signOut', 'signedIn', 'notSignedIn', 'signInTitle', 'signInMethod', 'signInWaiting',
  'openPage', 'copyLink', 'copied', 'copyFailed', 'copyCode', 'submit', 'decline',
  'signInRunning', 'signInFailed', 'signInCancelled', 'signOutFailed',
] as const satisfies readonly ModelsKey[]

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.onboarding': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

describe('ui-settings-models apply', () => {
  it('keeps manual credential onboarding available when the native shell owns automatic onboarding', async () => {
    const { ctx, slots } = await bench()
    declare(slots)
    try {
      const host = ctx.plugin(hostPlugin, { credentialOnboarding: false })
      await host.await()
      const rows: IndexInjection[] = []
      ctx.emit('webserver/index-inject', rows)
      expect(rows).toEqual([{ kind: 'global', name: ONBOARDING_CONFIG_GLOBAL, value: { credentialOnboarding: false } }])
      for (const row of rows) if (row.kind === 'global') vi.stubGlobal(row.name, row.value)
      const plugin = ctx.plugin({ inject: [...inject], apply })
      await plugin.await()
      expect(slots.entries('settings.onboarding').map(entry => entry.options.id)).toEqual(['welcome-notice', 'deepseek-official'])
      const onboarding = slots.entries('settings.onboarding').find(entry => entry.options.id === 'deepseek-official')!
      expect((onboarding.inject as () => { automatic: boolean })().automatic).toBe(false)
      expect(slots.entries('settings.section').map(entry => entry.options.id)).toEqual(['models'])
      await plugin.dispose()
      expect(slots.entries('settings.onboarding')).toEqual([])
      await host.dispose()
      const after: IndexInjection[] = []
      ctx.emit('webserver/index-inject', after)
      expect(after).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('defaults to browser onboarding and rejects malformed bootstrap options', async () => {
    expect(hostPlugin.Config({})).toEqual({ credentialOnboarding: true })
    expect(hostPlugin.Config['~standard'].validate({ credentialOnboarding: 'false' })).toHaveProperty('issues')
    const { ctx } = await bench()
    try {
      vi.stubGlobal(ONBOARDING_CONFIG_GLOBAL, { credentialOnboarding: 'false' })
      expect(() => { apply(ctx) }).toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.authorization', 'remote.credentials', 'remote.llm', 'remote.settings',
      'remote.session', 'configForms', 'settingsSchema',
    ])
  })

  it('registers the models nav entry for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = before.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ModelsSection)
    expect(entry.options).toMatchObject({ id: 'models', order: 10 })
    // The section claims its two extension seats in the same registration.
    expect(before.slots.spec('settings.models.provider-card')).toMatchObject({ kind: 'keyed', scope: 'root' })
    expect(before.slots.spec('settings.models.footer')).toMatchObject({ kind: 'list', scope: 'root' })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(resolveSlotLabel(entry.options.label)).toBe('模型')
    const injected = (entry.inject as unknown as () => import('../src/client/ModelsSection.tsx').ModelsSectionInjected)()
    expect(injected.t('nav')).toBe('模型')
    expect(injected.t('deleteTitle')).toBe('删除 {provider}？')
    expect(typeof injected.controller.load).toBe('function')
    expect(injected.hooks.snapshot).toBe(injected.controller.store)
    expect(typeof injected.operations.writeSettings).toBe('function')
    const onboarding = before.slots.entries('settings.onboarding')
    expect(onboarding).toHaveLength(2)
    expect(onboarding.find(entry => entry.options.id === 'welcome-notice')).toMatchObject({
      component: WelcomeNotice,
      options: { id: 'welcome-notice', order: -100 },
    })
    const deepSeek = onboarding.find(entry => entry.options.id === 'deepseek-official')!
    expect(deepSeek.component).toBe(DeepSeekOnboardingDialog)
    expect(deepSeek.options).toMatchObject({ id: 'deepseek-official', order: 0 })
    const deepSeekInjected = (
      deepSeek.inject as unknown as () => import('../src/client/DeepSeekOnboardingDialog.tsx').DeepSeekOnboardingInjected
    )()
    expect(deepSeekInjected.hooks.models).toBe(injected.controller.store)
    expect(typeof deepSeekInjected.operations.storeCredential).toBe('function')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    expect(after.slots.entries('settings.onboarding')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('settings.section')[0]!.component).toBe(ModelsSection)
    expect(after.slots.entries('settings.onboarding')).toHaveLength(2)
    // The self-inflicted ledger notifications hit the duplicate guard.
    expect(after.slots.entries('settings.section')).toHaveLength(1)
  })

  it('the label thunk follows the active locale without re-registration', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Models')
    const injected = b.slots.entries('settings.section')[0]!.inject as unknown as () => import('../src/client/ModelsSection.tsx').ModelsSectionInjected
    expect(injected().t('deleteTitle')).toBe('Delete {provider}?')
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('模型')
    expect(injected().t('deleteTitle')).toBe('删除 {provider}？')
  })

  it('locale change while the slot is undeclared stays a no-op', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.locale.setLocale('en')
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    b.locale.setLocale('zh')
  })

  it('re-registers after an HMR collapse re-declares the slot (stale disposer must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('settings.section')).toHaveLength(1)
    // Declarer unload: the cascade removes our entry while our local
    // disposer variable goes stale.
    redeclare()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(0)
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('settings.section')[0]!.component).toBe(ModelsSection)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(2)
    // The locale path also recovers through the same ledger re-check.
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('Models')
    b.locale.setLocale('zh')
  })

  it('accepts extension entries under the declared seats and cascades them with the declarer', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // A keyed card extension and a footer entry register through the ordinary
    // ledger once the section's registration declared the seats.
    const disposeCard = b.slots.register(
      { name: 'settings.models.provider-card', key: 'llm-pi-ai' } as never,
      () => null,
    )
    b.slots.register({ name: 'settings.models.footer', id: 'extra', order: 0 } as never, () => null)
    expect(b.slots.entries('settings.models.provider-card')).toHaveLength(1)
    expect(b.slots.entries('settings.models.footer')).toHaveLength(1)
    // Extension-side HMR safety: its own disposer removes the entry.
    disposeCard()
    expect(b.slots.entries('settings.models.provider-card')).toHaveLength(0)
    // Declarer unload cascades whatever extension entries remain.
    await fiber.dispose()
    expect(b.slots.entries('settings.models.footer')).toHaveLength(0)
  })

  it('registers the zh/en nav dictionaries and disposes everything with the fiber', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings.models')('nav')).toBe('模型')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    expect(b.slots.entries('settings.onboarding')).toHaveLength(0)
    // The (ns, locale) seats are free again — the dictionary disposers ran.
    expect(() => b.locale.register('settings.models', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings.models', 'en', {})).not.toThrow()
  })

  it('declares the Models sign-in copy in both dictionaries', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const translate = b.locale.bind('settings.models')
    // The sign-in surface's lines live in both dictionaries, and each one
    // resolves through the Models dictionary the plugin registered.
    for (const key of SIGN_IN_KEYS) {
      expect(zh[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
      expect(translate(key)).toBe(zh[key])
    }
  })

  it('keeps remote-browser acknowledgement in process memory', async () => {
    const b = await bench(false)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'welcome-notice')!
    const injected = (
      entry.inject as unknown as () => import('../src/client/WelcomeNotice.tsx').WelcomeNoticeInjected
    )()

    await injected.controller.load()
    expect(injected.controller.store.getSnapshot()).toEqual({
      status: 'ready', acknowledged: false, error: null,
    })
  })
})

describe('pushed invalidations', () => {
  it('ignores invalidations before the page ever loaded', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // The fake wire face has no methods: a fetch attempt would throw.
    b.remote.emit('settings/document-updated', ['llm-pi-ai', 1])
    b.remote.emit('credentials/reference-updated', ['OPENAI_API_KEY'])
    b.remote.emit('llm/adapters-updated', [])
    b.ctx.emit('connection/reset')
  })

  it('refreshes a loaded page and skips an idle one', () => {
    const loads: number[] = []
    const controller = {
      store: { getSnapshot: () => ({ status: 'ready' }) },
      load: () => { loads.push(1); return Promise.resolve() },
    }
    refreshIfLoaded(controller as import('../src/client/store.ts').ModelsSettingsStore)
    expect(loads).toHaveLength(1)
    const idle = {
      store: { getSnapshot: () => ({ status: 'idle' }) },
      load: () => { loads.push(2); return Promise.resolve() },
    }
    refreshIfLoaded(idle as import('../src/client/store.ts').ModelsSettingsStore)
    expect(loads).toHaveLength(1)
  })

  it('routes pushed credential invalidation into the shared onboarding join', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'deepseek-official')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/DeepSeekOnboardingDialog.tsx').DeepSeekOnboardingInjected
    )()
    injected.controller.store.update((state) => { state.status = 'ready' })
    const load = vi.spyOn(injected.controller, 'load').mockResolvedValue()
    b.remote.emit('credentials/reference-updated', ['DEEPSEEK_API_KEY'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('welcome state follows the shared mirror across document commits', async () => {
    // The welcome notice derives from its settings scope: a document commit
    // reaches it through the mirror's one refresh, with no routing here.
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const namespace = {
      ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
      schema: JSON.parse(JSON.stringify(Schema.object({ [WELCOME_NOTICE_ACK_FIELD]: Schema.string() }).toJSON())) as JsonValue,
      value: {},
      autoGenerate: true, applies: 'live' as const,
      secrets: [],
      revision: 0,
    }
    const document = { writable: true, hasDocument: false, namespaces: [namespace] }
    mock.remote.settings.describe.mockResolvedValue(ok(document))
    const b = await bench(true, mock)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.onboarding')
      .find(candidate => candidate.options.id === 'welcome-notice')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/WelcomeNotice.tsx').WelcomeNoticeInjected
    )()
    await injected.controller.load()
    await vi.waitFor(() => {
      expect(injected.hooks.welcome.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: false })
    })
    mock.remote.settings.describe.mockResolvedValue(ok({
      ...document,
      namespaces: [{ ...namespace, value: { [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION }, revision: 1 }],
    }))
    b.remote.emit('settings/document-updated', ['ui-settings-general', 1])
    await vi.waitFor(() => {
      expect(injected.hooks.welcome.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true })
    })
  })

  it('joins the refreshed mirror view on a settings invalidation', async () => {
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const namespace = { ns: 'llm-test', schema: {}, value: {}, autoGenerate: true, applies: 'live' as const, secrets: [], revision: 1 }
    const document = { writable: true, hasDocument: false, namespaces: [namespace] }
    const describe = mock.remote.settings.describe
    describe.mockResolvedValue(ok(document))
    const listProviders = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
    const b = await bench(true, mock, { listProviders })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section')
      .find(candidate => candidate.options.id === 'models')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/ModelsSection.tsx').ModelsSectionInjected
    )()
    await injected.controller.load()
    expect(injected.hooks.snapshot.getSnapshot().namespaces.get('llm-test')?.revision).toBe(1)

    describe.mockResolvedValue(ok({ ...document, namespaces: [{ ...namespace, revision: 2 }] }))
    b.remote.emit('settings/document-updated', ['llm-test', 2])

    await vi.waitFor(() => {
      expect(injected.hooks.snapshot.getSnapshot().namespaces.get('llm-test')?.revision).toBe(2)
    })
    expect(describe).toHaveBeenCalledTimes(2)
  })
})

describe('live authorization stream', () => {
  /** The record the subscription's flow writes: pi-ai scopes it by route id. */
  const CODEX_KEY = 'llm-pi-ai/openai-codex' as CredentialKey

  /** The Host view a frame carries: the subscription's one flow, signed in or not. */
  function codexView(configured: boolean): AuthorizationView {
    return {
      flows: [{
        key: CODEX_KEY,
        label: 'ChatGPT',
        methods: [{ id: 'oauth', label: 'ChatGPT' }],
        inFlight: false,
        configured,
        writable: true,
      }],
      attempt: null,
    }
  }

  /** The page directory: one keyless route whose only way in is the stored sign-in. */
  const directory = {
    listProviders: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: [{ id: 'openai-codex', name: 'ChatGPT' }],
    })),
    listConfigurableProviders: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: [{
        provider: 'openai-codex',
        displayName: 'ChatGPT',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai-codex'],
        authorization: { key: CODEX_KEY, required: true },
      }],
    })),
  }

  /** Apply the plugin over that directory and load the section's own store. */
  async function mountStream() {
    const b = await bench(true, RemoteMock.create().load(remoteDefaultResponses), directory)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.section').find(candidate => candidate.options.id === 'models')!
    const injected = (
      entry.inject as unknown as
      () => import('../src/client/ModelsSection.tsx').ModelsSectionInjected
    )()
    await injected.controller.load()
    return { ...b, injected }
  }

  it('subscribes once and merges a pushed frame into the row the page renders', async () => {
    const b = await mountStream()
    // One subscription for the page, opened through the Gateway supervisor.
    expect(b.wire.authorization.watch).toHaveBeenCalledTimes(1)
    expect(b.wire.opened).toHaveLength(1)
    expect(b.wire.opened[0]?.name).toBe('authorization')

    b.wire.push(codexView(true))

    // A frame the page never had a command for: the row's sign-in state and its
    // whole usability come from the pushed view alone.
    await vi.waitFor(() => {
      expect(providerUsable(b.injected.hooks.snapshot.getSnapshot().rows[0]!)).toBe(true)
    })
    const state = b.injected.hooks.snapshot.getSnapshot()
    expect(state.authorization).toEqual(codexView(true))
    expect(state.rows[0]?.flow).toMatchObject({ key: CODEX_KEY, configured: true })
    expect(b.wire.accepted).toHaveBeenCalledTimes(1)
  })

  it('keeps the row state and reports a terminal stream end', async () => {
    const b = await mountStream()
    b.wire.push(codexView(true))
    await vi.waitFor(() => {
      expect(providerUsable(b.injected.hooks.snapshot.getSnapshot().rows[0]!)).toBe(true)
    })

    b.wire.end()

    await vi.waitFor(() => {
      expect(b.injected.hooks.snapshot.getSnapshot().authorizationError).toBe('authorization stream ended')
    })
    // The row is not dropped with the stream: it keeps the last known sign-in.
    expect(providerUsable(b.injected.hooks.snapshot.getSnapshot().rows[0]!)).toBe(true)
  })
})
