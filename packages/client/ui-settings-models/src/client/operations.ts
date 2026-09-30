/**
 * The Host reads and writes the Models cards perform, as callbacks built in the
 * plugin body. Cards receive these instead of a context: the outcomes name what
 * a card renders — a stored view, a stale revision, a refusal message, the
 * already-running sign-in — so the failure codes and Remote namespaces stay in
 * the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { AuthorizationPromptId, AuthorizationView } from '@deepseek-ai/dsh-api-authorization-controller/types'
import type {
  CredentialInfo, LlmDiscoveredModel, LlmModelDiscoveryRequest, RemoteErrorCode, RemoteResult,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ProviderAuthorization } from './store.ts'

/** What one namespace write answered. */
export type SettingsWriteOutcome =
  /** Committed; the view carries the stored user subtree and the new revision. */
  | { readonly kind: 'written'; readonly view: SettingsNamespaceView }
  /**
   * The stored revision moved after the card read it, so the draft is stale.
   * The message stays for callers that report the Host diagnostic as it is.
   */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Any other refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one endpoint interrogation answered. */
export type ModelDiscoveryOutcome =
  /** The candidates the provider disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one authorization command answered. */
export type AuthorizationOutcome =
  /** The Host answered with the whole view, attempt included. */
  | { readonly kind: 'answered'; readonly view: AuthorizationView }
  /**
   * The command was refused. The code stays because one dialog line depends on
   * which refusal it was — a start that lost the controller's single slot to an
   * attempt already running says so instead of reporting a failure.
   */
  | { readonly kind: 'refused'; readonly code: RemoteErrorCode; readonly message: string }

/** The Host operations the Models page and its cards invoke. */
export interface ModelsOperations {
  /**
   * Read one credential reference's state.
   * @param ref - credential reference name.
   * @returns the state, or undefined when the reference is unknown or the read was refused.
   */
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
  /**
   * Store one credential literal under its reference.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   * @returns the refusal message, or undefined once stored.
   */
  storeCredential(ref: string, value: string): Promise<string | undefined>
  /**
   * Remove one credential reference (idempotent).
   * @param ref - credential reference name.
   * @returns the refusal message, or undefined once removed.
   */
  removeCredential(ref: string): Promise<string | undefined>
  /**
   * Apply path operations to one settings namespace.
   * @param ns - settings namespace identity.
   * @param ops - ordered path operations against the stored section, as the
   * wire takes them (the Remote signature owns the array).
   * @param expectedRevision - revision the draft was opened at, or undefined to write unfenced.
   * @returns the write outcome the card renders from.
   */
  writeSettings(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsWriteOutcome>
  /**
   * Ask a provider endpoint what models it serves.
   * @param settingsNs - namespace whose adapter family answers.
   * @param request - endpoint facts as the form currently shows them.
   * @returns the candidates, or the refusal.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<ModelDiscoveryOutcome>
  /**
   * Begin one route's sign-in flow.
   * @param key - the credential record the route's flow writes.
   * @param method - the chosen method id, or undefined for the flow's own default.
   * @returns the resulting view, or the refusal.
   */
  startAuthorization(key: ProviderAuthorization['key'], method?: string): Promise<AuthorizationOutcome>
  /**
   * Answer the in-flight attempt's current prompt.
   * @param promptId - identity of the prompt this answer addresses.
   * @param value - typed text, or the chosen option id for a `select` prompt.
   * @returns the resulting view, or the refusal.
   */
  answerAuthorization(promptId: AuthorizationPromptId, value: string): Promise<AuthorizationOutcome>
  /**
   * Decline the in-flight attempt's current prompt, settling the attempt cancelled.
   * @param promptId - identity of the prompt being declined.
   * @returns the resulting view, or the refusal.
   */
  declineAuthorization(promptId: AuthorizationPromptId): Promise<AuthorizationOutcome>
  /**
   * Withdraw the in-flight attempt (a no-op on the Host when none is running).
   * @returns the resulting view, or the refusal.
   */
  cancelAuthorization(): Promise<AuthorizationOutcome>
  /**
   * Remove the credential record one route's sign-in stored.
   * @param key - the credential record the route's flow writes.
   * @returns the resulting view, or the refusal.
   */
  signOutAuthorization(key: ProviderAuthorization['key']): Promise<AuthorizationOutcome>
}

/**
 * Bind the page's Host operations to the plugin's own Remote namespaces.
 * @param ctx - the page plugin's context, which declares `remote.credentials`,
 * `remote.llm`, and `remote.settings` in its own `inject`.
 * @returns the callbacks the section and its cards are injected with.
 */
export function createModelsOperations(ctx: ClientContext): ModelsOperations {
  return {
    describeCredential: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      return response.ok ? response.value[ref] : undefined
    },
    storeCredential: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    removeCredential: async (ref) => {
      const response = await ctx.remote.credentials.unset(ref)
      return response.ok ? undefined : response.error.message
    },
    writeSettings: async (ns, ops, expectedRevision) => {
      const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision)
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
    startAuthorization: async (key, method) => authorizationOutcome(await ctx.remote.authorization.start(key, method)),
    answerAuthorization: async (promptId, value) => authorizationOutcome(await ctx.remote.authorization.answer(promptId, value)),
    declineAuthorization: async promptId => authorizationOutcome(await ctx.remote.authorization.decline(promptId)),
    cancelAuthorization: async () => authorizationOutcome(await ctx.remote.authorization.cancel()),
    signOutAuthorization: async key => authorizationOutcome(await ctx.remote.authorization.signOut(key)),
  }
}

/**
 * Fold one authorization command's answer into the outcome its surface renders.
 * @param response - the Remote call's answer.
 * @returns the whole view, or the refusal code and the Host's own diagnostic.
 */
function authorizationOutcome(response: RemoteResult<AuthorizationView>): AuthorizationOutcome {
  return response.ok
    ? { kind: 'answered', view: response.value }
    : { kind: 'refused', code: response.error.code, message: response.error.message }
}
