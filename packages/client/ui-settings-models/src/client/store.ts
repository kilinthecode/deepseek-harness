/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm/listProviders` joined with `llm/listConfigurableProviders`),
 * the settings namespaces (shared settings mirror),
 * the referenced credentials (`credentials/describe`), and the sign-in flows
 * the routes declare (`authorization/getState`, kept live by `authorization/watch`).
 * The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { AuthorizationFlowView, AuthorizationView } from '@deepseek-ai/dsh-api-authorization-controller/types'
import type {
  CredentialInfo, LlmConfigurableProvider, LlmProviderInfo, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSchemaOperations } from './schema-operations.ts'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row after joining the configurable directory with live routes. */
export interface ProviderDirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly active: boolean
  readonly declared?: boolean
  readonly error?: string
  /**
   * The sign-in flow this route declares, when its adapter registers one:
   * {@link ProviderAuthorization.key} names the credential record the flow
   * writes, and {@link ProviderAuthorization.required} marks a route whose only
   * way to authenticate is that stored sign-in.
   */
  readonly authorization?: ProviderAuthorization
}

/** One route's sign-in declaration, as the directory carries it. */
export type ProviderAuthorization = NonNullable<LlmConfigurableProvider['authorization']>

/**
 * Join declared configurable providers with the currently registered routes.
 * @param registered - live provider routes in registration order.
 * @param directory - declared configurable providers in declaration order.
 * @returns account and official routes first, then other routes in their original order.
 */
export function joinProviderDirectory(
  registered: readonly LlmProviderInfo[],
  directory: readonly LlmConfigurableProvider[],
): ProviderDirectoryEntry[] {
  const active = new Set(registered.map(provider => provider.id))
  const declared = new Set(directory.map(entry => entry.provider))
  const rows: ProviderDirectoryEntry[] = directory.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...entry.declared === undefined ? {} : { declared: entry.declared },
    ...entry.error === undefined ? {} : { error: entry.error },
    ...entry.authorization === undefined ? {} : { authorization: entry.authorization },
  }))
  for (const provider of registered) {
    if (declared.has(provider.id)) continue
    rows.push({
      provider: provider.id,
      displayName: provider.name,
      settingsNs: '',
      settingsPath: [],
      active: true,
    })
  }
  return rows.toSorted((left, right) =>
    (left.provider === 'deepseek-account' ? 0 : left.provider === 'deepseek-official' ? 1 : 2)
      - (right.provider === 'deepseek-account' ? 0 : right.provider === 'deepseek-official' ? 1 : 2))
}

/** One provider row the page renders. */
export interface ProviderRow {
  /** Account route has usable credentials for the configured inference origin. */
  accountAvailable?: boolean
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ProviderDirectoryEntry
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialInfo | undefined
  /**
   * Credential state for the page's derived `<ROUTE>_API_KEY`, described only
   * while the profile names no reference — the provider-card seat's
   * `keyConfigured` fact for dormant and keyless rows, matching the editor's
   * own derivation rule.
   */
  derivedCredential?: CredentialInfo
  /**
   * The registered sign-in flow {@link ProviderDirectoryEntry.authorization}
   * names, once the authorization view lists it: whether a sign-in is stored
   * ({@link AuthorizationFlowView.configured}) and whether this deployment's
   * credential provider can write that record. A declaration no view lists —
   * the adapter ships no such flow, or the read failed — leaves it undefined.
   */
  flow: AuthorizationFlowView | undefined
}

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Sign-in enrichment failure; provider/settings rows remain usable. */
  authorizationError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** Latest authorization view: one entry per sign-in flow, plus the in-flight attempt. */
  authorization: AuthorizationView | null
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @param schema - settings schema operations.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): string[] {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
  schema: SettingsSchemaOperations,
): string | undefined {
  if (namespace === undefined) return undefined
  const profile = schema.getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle',
    error: null,
    credentialError: null,
    authorizationError: null,
    writable: false,
    rows: [],
    namespaces: new Map(),
    authorization: null,
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * Every sign-in publication the live stream has made: merged frames and
   * stream ends. A load's authorization read starts before its other reads
   * finish — and a pushed invalidation fires exactly this reload around a
   * sign-in completing — so a publication that lands while the load is in
   * flight is newer than that read, which must not then publish over it.
   */
  private liveRevision = 0

  /**
   * @param ctx - the page plugin's context, whose `remote.llm`,
   * `remote.credentials`, and `remote.authorization` namespaces carry the
   * directory, credential, and sign-in reads.
   * @param schema - settings-owned schema and immutable path operations.
   * @param describeFace - the shared mirror's describe face (namespace views and writability).
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly schema: SettingsSchemaOperations,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * Refresh the whole page snapshot: the provider directory and the mirror's
   * settings answer in parallel, then one batched credential describe over
   * every referenced ref. Provider failure or absence of an initial settings
   * answer keeps the last good rows and surfaces an error; a failed settings
   * refresh reuses the mirror's held view; a failed authorization read degrades
   * the sign-in half of the rows alone.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    const live = this.liveRevision
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    const [registered, declared, authorization] = await Promise.all([
      this.ctx.remote.llm.listProviders(),
      this.ctx.remote.llm.listConfigurableProviders(),
      readAuthorization(this.ctx),
      this.describeFace.ensure(),
    ])
    if (!registered.ok) { this.failLoad(generation, registered.error.message); return }
    if (!declared.ok) { this.failLoad(generation, declared.error.message); return }
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.view === undefined) {
      this.failLoad(generation, mirrored.error ?? 'settings are unavailable in this browser')
      return
    }
    const providers = joinProviderDirectory(registered.value, declared.value)
    const writable = mirrored.view.writable
    const views: readonly SettingsNamespaceView[] = mirrored.view.namespaces
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: Omit<ProviderRow, 'flow'>[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && this.schema.hasPath(namespace.user, entry.settingsPath)
        && !this.schema.hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: entry.provider === 'deepseek-account' ? undefined : apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
        credential: undefined,
      }
    })
    if (rows.some(row => row.entry.provider === 'deepseek-account')) {
      const catalog = await this.ctx.remote.session.modelCatalog()
      for (const row of rows) {
        if (row.entry.provider === 'deepseek-account') row.accountAvailable = catalog.ok
          && catalog.value.groups.some(group => group.id === 'deepseek-account' && group.models.length > 0)
      }
    }
    const refs = [...new Set(rows.filter(row => row.entry.provider !== 'deepseek-account').map(row => row.apiKeyEnv ?? deriveKeyRef(row.entry.provider)))]
    let credentials: Record<string, CredentialInfo> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      const response = await this.ctx.remote.credentials.describe(refs)
      // Credential state is an enrichment for the Models page: a failure
      // degrades the badge instead of failing the load. The onboarding
      // projection below retains the failure distinction.
      if (response.ok) credentials = response.value
      else credentialError = response.error.message
    }
    if (generation !== this.generation) return
    // The rows join the credentials before the snapshot write; each row's flow
    // joins inside it, from whichever sign-in half the snapshot ends up with.
    const rendered = rows
      .filter(row => row.entry.provider !== 'deepseek-account' || row.accountAvailable === true)
      .map((row) => {
        if (row.entry.provider === 'deepseek-account') return row
        const named = row.apiKeyEnv === undefined ? undefined : credentials[row.apiKeyEnv]
        const derived = row.apiKeyEnv !== undefined ? undefined : credentials[deriveKeyRef(row.entry.provider)]
        return {
          ...row,
          ...named === undefined ? {} : { credential: named },
          ...derived === undefined ? {} : { derivedCredential: derived },
        }
      })
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      // A stream publication that landed while this load was reading is newer
      // than the read, so the load leaves the sign-in half as the stream left
      // it: the pushed view, and the failure text a stream end reported.
      if (live === this.liveRevision) {
        s.authorization = authorization.view
        s.authorizationError = authorization.error
      }
      s.rows = joinFlows(rendered, s.authorization)
      s.namespaces = namespaces
    })
  }

  /**
   * Merge one pushed authorization view: the watch stream hands over the whole
   * view, so the snapshot takes it whole and re-joins each row's flow.
   * @param view - the view the Host pushed.
   * @returns nothing; the rows follow.
   */
  mergeAuthorization(view: AuthorizationView): void {
    this.liveRevision += 1
    this.store.update((s) => {
      s.authorization = view
      s.authorizationError = null
      s.rows = joinFlows(s.rows, view)
    })
  }

  /**
   * The live-publication revision as of now. A caller about to issue an
   * authorization command reads this first, then passes it back to
   * {@link mergeCommandView} so a late answer can tell whether a live frame
   * beat it there.
   * @returns the current live-publication revision.
   */
  authorizationRevision(): number {
    return this.liveRevision
  }

  /**
   * Merge one command's answered view, unless a live frame already landed
   * since the command was issued: a stream push can carry a phase newer than
   * the one the command's own HTTP answer captured (pi-ai's `select` prompt
   * right after `start`, for example), and a late answer must never overwrite
   * state a live frame already advanced past.
   * @param view - the view the command's answer carried.
   * @param issuedAt - the revision {@link authorizationRevision} returned right before the command was issued.
   * @returns nothing; a stale answer is dropped without changing the snapshot.
   */
  mergeCommandView(view: AuthorizationView, issuedAt: number): void {
    if (issuedAt !== this.liveRevision) return
    this.mergeAuthorization(view)
  }

  /**
   * Publish one authorization failure, keeping the rows' last known sign-in
   * state.
   * @param error - the thrown failure whose message the snapshot reports.
   */
  failAuthorization(error: unknown): void {
    this.liveRevision += 1
    this.store.update((s) => { s.authorizationError = failureText(error) })
  }

  /** Publish one load's failure text, unless a newer load already took over. */
  private failLoad(generation: number, message: string): void {
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'error'
      s.error = message
    })
  }
}

/** One authorization read: the view, or the failure text that degrades sign-in alone. */
interface AuthorizationRead {
  view: AuthorizationView | null
  error: string | null
}

/**
 * Read the authorization view. The provider rows never owe this read — a route
 * without a sign-in flow needs nothing from it — so a refusal or a dropped call
 * is reported as enrichment text instead of failing the page.
 * @param ctx - the page plugin's context, whose `remote.authorization` namespace carries the read.
 * @returns the view, or null with the failure text.
 */
async function readAuthorization(ctx: ClientContext): Promise<AuthorizationRead> {
  try {
    const response = await ctx.remote.authorization.getState()
    return response.ok ? { view: response.value, error: null } : { view: null, error: response.error.message }
  } catch (error) {
    return { view: null, error: failureText(error) }
  }
}

/**
 * One failure's display text: an Error's message, or the thrown value verbatim.
 * @param error - the thrown value.
 * @returns the text the snapshot reports.
 */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Re-join every row's sign-in state to one authorization view. A load and a
 * pushed frame each publish a whole view, and every row derives its flow from
 * the declaration its own directory entry carries.
 * @param rows - the rows whose flows to re-join.
 * @param view - the view the snapshot now holds.
 * @returns the rows carrying that view's flows.
 */
function joinFlows(rows: readonly Omit<ProviderRow, 'flow'>[], view: AuthorizationView | null): ProviderRow[] {
  return rows.map(row => ({ ...row, flow: flowOf(row.entry, view) }))
}

/**
 * The registered sign-in flow one joined row's declaration names.
 * @param entry - one joined directory row.
 * @param view - the latest authorization view, or null before the first read.
 * @returns the flow view the sign-in dialog drives, or undefined while no view lists the key.
 */
function flowOf(entry: ProviderDirectoryEntry, view: AuthorizationView | null): AuthorizationFlowView | undefined {
  const key = entry.authorization?.key
  if (key === undefined) return undefined
  return view?.flows.find(flow => flow.key === key)
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing, an ambient environment variable), as does a live route with no
 * settings address at all, so neither owes this page a key — except the route
 * whose adapter declares a stored sign-in as its only way in, which is usable
 * only once the authorization view reports that sign-in configured.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.entry.provider === 'deepseek-account') return row.accountAvailable === true
  if (row.apiKeyEnv !== undefined) return row.credential?.configured === true
  if (row.entry.authorization?.required === true) return row.flow?.configured === true
  return true
}

/** First-run onboarding readiness derived only from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'provider-ready' }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'provider-inactive'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
  }

/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }
  // Past the usable gate an active route names a reference it has no stored
  // credential for, so the remaining questions are all about that credential.
  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
