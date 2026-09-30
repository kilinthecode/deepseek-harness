/** Page-store join: directory × namespaces × credentials, with last-good rows on failure. */
import { describe, expect, it } from 'vitest'
import type { AuthorizationFlowView, AuthorizationView } from '@deepseek-ai/dsh-api-authorization-controller/types'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { settingsSchema } from './settings-schema.client.ts'
import { joinProviderDirectory, ModelsSettingsStore, providerUsable } from '../src/client/store.ts'

it.each([false, true])('retains configuration diagnostics when the route is active: %s', (active) => {
  expect(joinProviderDirectory(active ? [{ id: 'openai', name: 'openai' }] : [], [{
    provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
    error: 'catalog unavailable',
  }])).toEqual([{
    provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
    active, error: 'catalog unavailable',
  }])
})

it('places account and official before third-party providers', () => {
  const providers = ['custom', 'deepseek-official', 'deepseek-account', 'openai']
  const directory = providers.map(provider => ({
    provider, displayName: provider, settingsNs: 'fixture', settingsPath: [],
  }))
  expect(joinProviderDirectory([], directory).map(row => row.provider))
    .toEqual(['deepseek-account', 'deepseek-official', 'custom', 'openai'])
  expect(directory.map(row => row.provider)).toEqual(providers)
})

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'gateway/internal', message, details: {} } } }
}

/** Answers over the Remote carrier, which has no envelope. */
type RemoteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteError }
function remoteOk<T>(value: T): RemoteAnswer<T> {
  return { ok: true, value }
}
function remoteFail<T>(message: string): RemoteAnswer<T> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
  { provider: 'ghost', displayName: 'Ghost', settingsNs: '', settingsPath: [], active: true },
]

const NAMESPACES = [
  {
    ns: 'llm-deepseek',
    schema: {},
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    autoGenerate: true, applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-deepseek-account',
    schema: {},
    value: { baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    autoGenerate: true, applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    autoGenerate: true, applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
]

/** An authorization view with no flow registered and no attempt running. */
const NO_FLOWS: AuthorizationView = { flows: [], attempt: null }

function api(overrides: {
  accountAvailable?: boolean
  providers?: () => Promise<RpcResponse<{ providers: typeof DIRECTORY }>>
  describeSettings?: () => Promise<RemoteAnswer<{ writable: boolean; hasDocument: boolean; namespaces: typeof NAMESPACES }>>
  describeCredentials?: (refs: readonly string[]) => Promise<RemoteAnswer<Record<string, unknown>>>
  authorization?: () => Promise<RemoteAnswer<AuthorizationView>>
} = {}) {
  const seenRefs: string[][] = []
  const providers = overrides.providers ?? (() => Promise.resolve(ok({ providers: DIRECTORY })))
  let providerBatch: Promise<RpcResponse<{ providers: typeof DIRECTORY }>> | undefined
  let providerBatchReads = 0
  const readProviderBatch = (): Promise<RpcResponse<{ providers: typeof DIRECTORY }>> => {
    providerBatch ??= providers()
    const current = providerBatch
    providerBatchReads += 1
    if (providerBatchReads % 2 === 0) providerBatch = undefined
    return current
  }
  const mapProviderBatch = async <T>(
    project: (rows: typeof DIRECTORY) => T,
  ): Promise<RemoteAnswer<T>> => {
    const response = await readProviderBatch()
    return response.result.ok
      ? remoteOk(project(response.result.value.providers))
      : remoteFail(response.result.error.message)
  }
  const face = {
    session: { modelCatalog: async () => remoteOk({ groups: overrides.accountAvailable
      ? [{ id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] }] : [] }) },
    authorization: {
      getState: overrides.authorization ?? (async () => remoteOk(NO_FLOWS)),
    },
    llm: {
      listProviders: () => mapProviderBatch(rows => rows
        .filter(row => row.active)
        .map(row => ({ id: row.provider, name: row.displayName }))),
      listConfigurableProviders: () => mapProviderBatch(rows => rows
        .filter(row => row.settingsNs !== '')
        .map(({ active: _active, ...row }) => row)),
      discoverModels: () => Promise.resolve(remoteOk([])),
    },
    settings: {
      describe: overrides.describeSettings
        ?? (() => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: NAMESPACES }))),
      mutate: () => Promise.resolve(remoteFail('the store spec issues no writes')),
    },
    credentials: {
      describe: (refs: readonly string[]) => {
        seenRefs.push([...refs])
        return (overrides.describeCredentials ?? (asked => Promise.resolve(remoteOk(
          Object.fromEntries(asked.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
        ))))(refs)
      },
      set: () => Promise.resolve(remoteOk(undefined)),
      unset: () => Promise.resolve(remoteOk(undefined)),
    },
  }
  // The page plugin's context, scripted down to the namespaces it reaches.
  const ctx = { remote: face } as never
  return { ctx, face, mirror: new SettingsDescribeMirror(ctx), seenRefs }
}

describe('ModelsSettingsStore', () => {
  it('joins rows with configured, removable, and credential state', async () => {
    const { ctx, mirror, seenRefs } = api()
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.credentialError).toBeNull()
    // Named references first (rows order), then the derived <ROUTE>_API_KEY
    // of every row whose profile names none — one batched describe.
    expect(seenRefs).toEqual([['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GHOST_API_KEY']])
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('deepseek-official')).toMatchObject({
      configured: true,
      removable: false,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { configured: false, writable: true },
    })
    expect(byProvider.get('openai')).toMatchObject({
      configured: true,
      removable: true,
      apiKeyEnv: 'OPENAI_API_KEY',
      credential: { configured: true },
    })
    expect(byProvider.get('anthropic')).toMatchObject({ configured: false, removable: false })
    expect(byProvider.get('anthropic')?.apiKeyEnv).toBeUndefined()
    expect(byProvider.get('ghost')).toMatchObject({ configured: false, removable: false })
    expect(state.namespaces.get('llm-pi-ai')?.ns).toBe('llm-pi-ai')
  })

  it('degrades the credential badge, not the page, when the credential domain fails', async () => {
    const { ctx, mirror } = api({ describeCredentials: () => Promise.resolve(remoteFail('no provider')) })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.credentialError).toBe('no provider')
    expect(state.rows.every(row => row.credential === undefined)).toBe(true)
  })

  it('surfaces a directory failure and keeps the last good rows', async () => {
    const { ctx, mirror } = api()
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot().rows).toHaveLength(4)
    const broken = api({ providers: () => Promise.resolve(fail('directory down')) })
    const failing = new ModelsSettingsStore(broken.ctx, settingsSchema, broken.mirror)
    await failing.load()
    expect(failing.store.getSnapshot()).toMatchObject({ status: 'error', error: 'directory down' })
    // The first store's snapshot is untouched by the second's failure.
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('surfaces a configurable-provider directory failure', async () => {
    const { ctx, face, mirror } = api()
    const llm = (face as unknown as {
      llm: { listConfigurableProviders: () => Promise<RemoteAnswer<never>> }
    }).llm
    llm.listConfigurableProviders = () => Promise.resolve(remoteFail<never>('configuration directory down'))
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)

    await store.load()

    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error', error: 'configuration directory down',
    })
  })

  it('lets the newest load win over a stale slow response', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { ctx, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return fail('stale slow failure')
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    release?.()
    await Promise.all([first, second])
    expect(store.store.getSnapshot().status).toBe('ready')
  })
})

describe('edge joins', () => {
  it('treats a non-object profile as having no credential reference', async () => {
    const { ctx, mirror } = api({
      describeSettings: () => Promise.resolve(remoteOk({
        writable: true,
        hasDocument: false,
        namespaces: [{
          ns: 'llm-pi-ai',
          schema: {},
          value: { providers: { weird: 'oops' } },
          autoGenerate: true, applies: 'live' as const,
          secrets: [],
          revision: 0,
        }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'weird', displayName: 'weird', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'weird'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.rows[0]).toMatchObject({ configured: true, removable: false })
    expect(state.rows[0]?.apiKeyEnv).toBeUndefined()
  })

  it('describes the derived reference for a row whose profile names none', async () => {
    const { ctx, mirror, seenRefs } = api({
      describeSettings: () => Promise.resolve(remoteOk({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, autoGenerate: true, applies: 'live' as const, secrets: [], revision: 0 }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
        ] as never,
      })),
      describeCredentials: refs => Promise.resolve(remoteOk(
        Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
      )),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    // The dormant row names no reference, so the join asks about the page's
    // own derived <ROUTE>_API_KEY — what the editor would display for it.
    expect(seenRefs).toEqual([['ANTHROPIC_API_KEY']])
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.rows[0]?.credential).toBeUndefined()
    expect(state.rows[0]?.derivedCredential).toMatchObject({ configured: true })
  })

  it('surfaces a settings describe failure', async () => {
    const { ctx, mirror } = api({ describeSettings: () => Promise.resolve(remoteFail('settings down')) })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings down' })
  })

  it('reports a terminally unavailable settings mirror precisely', async () => {
    const { ctx } = api()
    const store = new ModelsSettingsStore(
      ctx,
      settingsSchema,
      new SettingsDescribeMirror(ctx, 'memory'),
    )
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'settings are unavailable in this browser',
    })
  })

  it('reuses a held settings view after its refresh fails', async () => {
    let settingsCall = 0
    const { ctx, mirror } = api({
      describeSettings: () => {
        settingsCall += 1
        return Promise.resolve(settingsCall === 1
          ? remoteOk({ writable: true, hasDocument: false, namespaces: NAMESPACES })
          : remoteFail('settings refresh down'))
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    await mirror.load()
    expect(mirror.getSnapshot().error).toBe('settings refresh down')
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })

  it('drops a stale successful response after a newer load finished', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { ctx, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return ok({ providers: [] as never })
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    await second
    release?.()
    await first
    // The stale empty directory never overwrote the newer join.
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })
})


describe('sign-in joins', () => {
  /** The record the ChatGPT subscription's flow writes: pi-ai scopes it by provider id. */
  const CODEX_KEY = 'llm-pi-ai/openai-codex' as CredentialKey

  /** The subscription's one registered sign-in flow, as the authorization view lists it. */
  function codexFlow(configured: boolean): AuthorizationFlowView {
    return {
      key: CODEX_KEY,
      label: 'ChatGPT',
      methods: [{ id: 'oauth', label: 'ChatGPT' }],
      inFlight: false,
      configured,
      writable: true,
    }
  }

  /** The authorization view listing that flow alone. */
  function codexView(configured: boolean): AuthorizationView {
    return { flows: [codexFlow(configured)], attempt: null }
  }

  /**
   * The page API over a directory whose only route is the subscription, with the
   * authorization read scripted.
   * @param options - the row's declaration, the flow's stored state, and the read's own script.
   * @returns the context and the shared describe face.
   */
  function codexApi(options: {
    configured: boolean
    required?: boolean
    authorization?: () => Promise<RemoteAnswer<AuthorizationView>>
  }) {
    return api({
      providers: async () => ok({
        providers: [{
          provider: 'openai-codex', displayName: 'ChatGPT', settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'openai-codex'], active: true,
          authorization: { key: CODEX_KEY, required: options.required ?? true },
        }] as never,
      }),
      authorization: options.authorization ?? (async () => remoteOk(codexView(options.configured))),
    })
  }

  /**
   * Load the store over that page API.
   * @param options - the row's declaration, the flow's stored state, and the read's own script.
   * @returns the loaded controller.
   */
  async function loadCodex(options: {
    configured: boolean
    required?: boolean
    authorization?: () => Promise<RemoteAnswer<AuthorizationView>>
  }): Promise<ModelsSettingsStore> {
    const { ctx, mirror } = codexApi(options)
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    return store
  }

  it('joins the declared sign-in and the flow the view lists onto the row', async () => {
    const store = await loadCodex({ configured: false })
    const state = store.store.getSnapshot()
    expect(state.authorization).toEqual(codexView(false))
    expect(state.authorizationError).toBeNull()
    const row = state.rows[0]!
    expect(row.entry.authorization).toEqual({ key: CODEX_KEY, required: true })
    expect(row.apiKeyEnv).toBeUndefined()
    expect(row.flow).toEqual(codexFlow(false))
  })

  it('holds a route whose adapter requires the stored sign-in unusable until it is signed in', async () => {
    const unsigned = await loadCodex({ configured: false })
    expect(providerUsable(unsigned.store.getSnapshot().rows[0]!)).toBe(false)
    const signed = await loadCodex({ configured: true })
    expect(providerUsable(signed.store.getSnapshot().rows[0]!)).toBe(true)
  })

  it('leaves a keyless route usable while unsigned when its adapter requires no sign-in', async () => {
    const store = await loadCodex({ configured: false, required: false })
    const row = store.store.getSnapshot().rows[0]!
    expect(row.flow?.configured).toBe(false)
    expect(providerUsable(row)).toBe(true)
  })

  it.each([true, false])('keeps a row that names an API-key reference on its credential: %s', async (configured) => {
    const { ctx, mirror } = api({
      providers: async () => ok({
        providers: [{
          provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'openai'], active: true,
          authorization: { key: CODEX_KEY, required: true },
        }] as never,
      }),
      describeCredentials: refs => Promise.resolve(remoteOk(
        Object.fromEntries(refs.map(ref => [ref, { configured, writable: true }])),
      )),
      authorization: async () => remoteOk(codexView(true)),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const row = store.store.getSnapshot().rows[0]!
    // The stored reference is this route's own way in, so neither the flow's
    // state nor the declaration decides usability for it.
    expect(row.apiKeyEnv).toBe('OPENAI_API_KEY')
    expect(row.flow?.configured).toBe(true)
    expect(providerUsable(row)).toBe(configured)
  })

  it('degrades the sign-in enrichment, not the page, when the authorization read is refused', async () => {
    const store = await loadCodex({
      configured: false,
      authorization: async () => remoteFail('authorization unavailable'),
    })
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.error).toBeNull()
    expect(state.rows).toHaveLength(1)
    expect(state.authorization).toBeNull()
    expect(state.authorizationError).toBe('authorization unavailable')
  })

  it('reports a dropped authorization call as enrichment text', async () => {
    const store = await loadCodex({
      configured: false,
      authorization: () => Promise.reject(new Error('connection reset')),
    })
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.rows).toHaveLength(1)
    expect(state.authorization).toBeNull()
    expect(state.authorizationError).toBe('connection reset')
  })

  it('reports a thrown non-Error authorization fault as its own text', async () => {
    const carrierFault: unknown = 'the carrier closed the channel'
    const store = await loadCodex({
      configured: false,
      authorization: async () => { throw carrierFault },
    })
    expect(store.store.getSnapshot().authorizationError).toBe('the carrier closed the channel')
  })

  it('merges a pushed view onto the rows without reading the directory again', async () => {
    const store = await loadCodex({ configured: false })
    const loaded = store.store.getSnapshot().rows[0]!
    expect(providerUsable(loaded)).toBe(false)
    store.mergeAuthorization(codexView(true))
    const state = store.store.getSnapshot()
    expect(state.authorization).toEqual(codexView(true))
    expect(state.authorizationError).toBeNull()
    // The pushed frame re-joins the directory entry the load produced.
    expect(state.rows[0]?.entry).toBe(loaded.entry)
    expect(state.rows[0]?.flow).toEqual(codexFlow(true))
    expect(providerUsable(state.rows[0]!)).toBe(true)
    // A frame that stops listing the key withdraws the row's flow again.
    store.mergeAuthorization(NO_FLOWS)
    expect(store.store.getSnapshot().rows[0]?.flow).toBeUndefined()
  })

  it('drops a command answer that arrives after a newer live frame', async () => {
    const store = await loadCodex({ configured: false })
    const issuedAt = store.authorizationRevision()
    store.mergeAuthorization(codexView(true))
    store.mergeCommandView(codexView(false), issuedAt)
    // The live frame already advanced past the command's own revision, so its
    // late answer (still reporting unsigned) is dropped rather than reapplied.
    expect(store.store.getSnapshot().authorization).toEqual(codexView(true))
  })

  it('merges a command answer when no live frame arrived since it was issued', async () => {
    const store = await loadCodex({ configured: false })
    const issuedAt = store.authorizationRevision()
    store.mergeCommandView(codexView(true), issuedAt)
    expect(store.store.getSnapshot().authorization).toEqual(codexView(true))
    // A merged command answer is itself a publication: the revision moves on.
    expect(store.authorizationRevision()).toBe(issuedAt + 1)
  })

  it('drops a command answer that arrives after a stream failure bumped the revision', async () => {
    const store = await loadCodex({ configured: false })
    const issuedAt = store.authorizationRevision()
    store.failAuthorization('the sign-in stream ended')
    store.mergeCommandView(codexView(true), issuedAt)
    // The failure is itself a publication, so the command's now-late answer
    // (still reporting unsigned) is dropped rather than reapplied.
    expect(store.store.getSnapshot().authorization).toEqual(codexView(false))
    expect(store.store.getSnapshot().authorizationError).toBe('the sign-in stream ended')
  })

  it('clears a recorded read failure on the next pushed frame', async () => {
    const store = await loadCodex({
      configured: false,
      authorization: async () => remoteFail('authorization unavailable'),
    })
    expect(store.store.getSnapshot().authorizationError).toBe('authorization unavailable')
    store.mergeAuthorization(codexView(true))
    expect(store.store.getSnapshot().authorizationError).toBeNull()
    expect(store.store.getSnapshot().authorization).toEqual(codexView(true))
  })

  it('keeps the rows and their flows when the watch reports a failure', async () => {
    const store = await loadCodex({ configured: true })
    store.failAuthorization('the sign-in stream ended')
    const state = store.store.getSnapshot()
    expect(state.authorizationError).toBe('the sign-in stream ended')
    expect(state.authorization).toEqual(codexView(true))
    expect(state.rows[0]?.flow).toEqual(codexFlow(true))
    expect(providerUsable(state.rows[0]!)).toBe(true)
  })

  it('keeps the frame that landed while the load was still reading', async () => {
    const pending = Promise.withResolvers<RemoteAnswer<AuthorizationView>>()
    const { ctx, mirror } = codexApi({ configured: false, authorization: () => pending.promise })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)

    const loading = store.load()
    // The frame arrives while the load's own read is in flight — what a pushed
    // invalidation around a completed sign-in produces — so the frame, not the
    // read the load started from, is the newer sign-in state.
    store.mergeAuthorization(codexView(true))
    pending.resolve(remoteOk(codexView(false)))
    await loading

    const state = store.store.getSnapshot()
    expect(state.authorization).toEqual(codexView(true))
    expect(state.rows[0]?.flow).toEqual(codexFlow(true))
    expect(providerUsable(state.rows[0]!)).toBe(true)
  })

  it('keeps the stream failure that landed while the load was still reading', async () => {
    const pending = Promise.withResolvers<RemoteAnswer<AuthorizationView>>()
    const { ctx, mirror } = codexApi({ configured: false, authorization: () => pending.promise })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)

    const loading = store.load()
    store.failAuthorization(new Error('the sign-in stream ended'))
    pending.resolve(remoteOk(codexView(false)))
    await loading

    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.authorizationError).toBe('the sign-in stream ended')
  })
})

it.each([false, true])('uses account availability without asking for an API key: %s', async (accountAvailable) => {
  const { ctx, mirror, seenRefs } = api({ accountAvailable, providers: async () => ok({ providers: [{
    provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [], active: true,
  }] }) })
  const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
  await store.load()
  const rows = store.store.getSnapshot().rows
  expect(rows).toHaveLength(accountAvailable ? 1 : 0)
  if (accountAvailable) {
    expect(rows[0]).toMatchObject({ accountAvailable: true, apiKeyEnv: undefined, credential: undefined })
    expect(providerUsable(rows[0]!)).toBe(true)
  }
  expect(store.store.getSnapshot().namespaces.get('llm-deepseek-account')?.ns).toBe('llm-deepseek-account')
  expect(seenRefs).toEqual([])
})

it('removes the account row after sign-out and restores it after sign-in', async () => {
  const overrides = { accountAvailable: true, providers: async () => ok({ providers: [{
    provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [], active: true,
  }, ...DIRECTORY] }) }
  const { ctx, mirror } = api(overrides)
  const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
  await store.load()
  expect(store.store.getSnapshot().rows[0]?.entry.provider).toBe('deepseek-account')
  overrides.accountAvailable = false
  await store.load()
  expect(store.store.getSnapshot().rows.map(row => row.entry.provider)).not.toContain('deepseek-account')
  expect(store.store.getSnapshot().rows).toHaveLength(DIRECTORY.length)
  overrides.accountAvailable = true
  await store.load()
  expect(store.store.getSnapshot().rows[0]?.entry.provider).toBe('deepseek-account')
})
