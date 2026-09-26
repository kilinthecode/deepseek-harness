/** Authenticated Remote operations over the authorization (`ctx.authorization`) and credential (`ctx.credentials`) seams. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationPromptId, AuthorizationView } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host authorization business API and Remote namespace owner. */
    authorizationController: AuthorizationController
  }
}

/**
 * Authorization commands and a reconnect-safe state stream. The controller
 * owns exactly one running attempt at a time: `start` claims the slot for a
 * key, `answer` and `decline` resolve the attempt's current prompt, `cancel`
 * withdraws it, and every mutating method returns the resulting complete
 * view so a caller never has to separately re-fetch state after a command.
 */
export class AuthorizationController extends TypertRemoteService {
  static inject = ['authorization', 'credentials']

  /** @param ctx - Host with the authorization and credentials seams mounted. */
  constructor(ctx: Context) { super(ctx, 'authorizationController', { namespace: 'authorization' }) }

  /**
   * Read the current authorization view.
   * @returns every registered flow and the controller-owned attempt, if any.
   */
  @Remote
  async getState(): Promise<AuthorizationView> {
    throw new Error('authorization-controller: not implemented')
  }

  /**
   * Begin an attempt for one registered flow. Refused while a different key's
   * attempt is already active; starting the same key's attempt again returns
   * its current state instead of starting a second one.
   * @param key - the credential record to authorize; a flow must be registered for it.
   * @param method - which of the flow's methods to run; defaults to the flow's first.
   * @returns state after the attempt starts, or its already-active state.
   * @throws {RemoteError} code `authorization/no-flow` when no flow claims
   *   `key`, `authorization/unknown-method` when the flow offers no such
   *   method, or `authorization/already-in-flight` when a different key's
   *   attempt is active.
   */
  @Remote
  async start(key: CredentialKey, method?: string): Promise<AuthorizationView> {
    // Scaffold: the parameters are part of the final signature but unused
    // until the next commit implements this body.
    void key; void method
    throw new Error('authorization-controller: not implemented')
  }

  /**
   * Answer the active attempt's current prompt.
   * @param promptId - identity of the prompt this answer addresses.
   * @param value - typed text, or the chosen option's id for a `select` prompt.
   * @returns state after the answer is delivered to the running flow.
   * @throws {RemoteError} code `authorization/stale-prompt` when no attempt is
   *   waiting on `promptId`.
   */
  @Remote
  async answer(promptId: AuthorizationPromptId, value: string): Promise<AuthorizationView> {
    void promptId; void value
    throw new Error('authorization-controller: not implemented')
  }

  /**
   * Decline the active attempt's current prompt. The attempt settles
   * `cancelled`, the same outcome as a withdrawn signal, because a human
   * saying no is a refusal, not a breakage.
   * @param promptId - identity of the prompt being declined.
   * @returns state after the attempt settles `cancelled`.
   * @throws {RemoteError} code `authorization/stale-prompt` when no attempt is
   *   waiting on `promptId`.
   */
  @Remote
  async decline(promptId: AuthorizationPromptId): Promise<AuthorizationView> {
    void promptId
    throw new Error('authorization-controller: not implemented')
  }

  /**
   * Withdraw the controller-owned attempt, if one is running. A no-op when
   * nothing is active, so a stale Cancel click never fails.
   * @returns state after the attempt settles `cancelled`, or unchanged state
   *   when nothing was running.
   */
  @Remote
  async cancel(): Promise<AuthorizationView> {
    throw new Error('authorization-controller: not implemented')
  }

  /**
   * Remove the stored credential record a registered flow claims for `key`.
   * @param key - the credential record to remove; a flow must be registered for it.
   * @returns state after the record is removed.
   * @throws {RemoteError} code `authorization/no-flow` when no flow claims
   *   `key`, or `authorization/read-only` when the active provider cannot
   *   write that key's record.
   */
  @Remote
  async signOut(key: CredentialKey): Promise<AuthorizationView> {
    void key
    throw new Error('authorization-controller: not implemented')
  }

  /**
   * Stream the complete authorization view.
   * @param signal - stream lifetime.
   * @returns initial snapshot and subsequent complete views.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<AuthorizationView> {
    void signal
    throw new Error('authorization-controller: not implemented')
  }
}
export default AuthorizationController
