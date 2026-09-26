/** Browser-safe request and view vocabulary for the Authorization Remote service. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationMethod, AuthorizationNotice } from '@deepseek-ai/dsh-authorization'

/** Client-minted identity for one outstanding prompt, addressed by `answer` and `decline`. */
export type AuthorizationPromptId = Branded<'AuthorizationPromptId'>

/** One choice offered by a `select` prompt. */
export interface AuthorizationPromptOption {
  /** Value returned when this option is chosen. */
  readonly id: string
  /** User-facing label. */
  readonly label: string
  /** Optional extra context rendered by capable surfaces. */
  readonly description?: string
}

/** One registered flow as a surface lists it: what it authorizes, its methods, and whether it is busy. */
export interface AuthorizationFlowView {
  /** The credential record this flow writes. */
  readonly key: CredentialKey
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** The methods this flow offers, most preferred first. */
  readonly methods: readonly AuthorizationMethod[]
  /** Whether an attempt for this key is running right now, including one started by another surface. */
  readonly inFlight: boolean
  /** Whether the credential store currently reports a record for this key. */
  readonly configured: boolean
  /** Whether the active credential provider can currently write this key's record. */
  readonly writable: boolean
}

/** A question the running attempt must have answered before it can continue. */
export interface AuthorizationPromptView {
  /** Identity `answer` and `decline` echo back; stale once the attempt moves past it. */
  readonly id: AuthorizationPromptId
  /** `secret` differs from `text` only in presentation; `select` answers with the chosen option's id. */
  readonly kind: 'text' | 'secret' | 'select'
  readonly message: string
  readonly placeholder?: string
  readonly options?: readonly AuthorizationPromptOption[]
}

/** Lifecycle position of the controller-owned attempt, one at a time. */
export type AuthorizationAttemptPhase = 'starting' | 'running' | 'prompting' | 'authorized' | 'cancelled' | 'failed'

/** Complete state of the one attempt this controller currently owns, if any. */
export interface AuthorizationAttemptView {
  /** The credential record the attempt is authorizing. */
  readonly key: CredentialKey
  /** The method the attempt is running. */
  readonly method: string
  readonly phase: AuthorizationAttemptPhase
  /** Latest progress report from the running flow, when it reported one. */
  readonly notice?: AuthorizationNotice
  /** The question currently blocking the attempt, present only during `prompting`. */
  readonly prompt?: AuthorizationPromptView
  /** User-safe failure message, present only when `phase` is `failed`. */
  readonly failure?: string
}

/** Complete Authorization Remote view: every registered flow and the one active attempt, if any. */
export interface AuthorizationView {
  readonly flows: readonly AuthorizationFlowView[]
  /** The controller-owned attempt in flight, or null while none is running. */
  readonly attempt: AuthorizationAttemptView | null
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No authorization flow is registered for the requested key. */
    'authorization/no-flow': { readonly key: CredentialKey }
    /** The requested key's flow offers no method by that name. */
    'authorization/unknown-method': { readonly key: CredentialKey; readonly method: string }
    /** An attempt for the requested key is already running. */
    'authorization/already-in-flight': { readonly key: CredentialKey }
    /** The flow resolved without committing a credential record during the attempt. */
    'authorization/not-committed': { readonly key: CredentialKey }
    /** `answer` or `decline` named a prompt the current attempt is no longer waiting on. */
    'authorization/stale-prompt': { readonly promptId: AuthorizationPromptId }
    /** The active provider cannot write the record a flow claims for this key. */
    'authorization/read-only': { readonly key: CredentialKey }
  }
}
