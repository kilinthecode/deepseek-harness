/** Authenticated Remote operations over the authorization (`ctx.authorization`) and credential (`ctx.credentials`) seams. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationMethod, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteErrorCode, RemoteErrorDetailsMap } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AuthorizationAttemptPhase, AuthorizationAttemptView, AuthorizationFlowView, AuthorizationPromptId, AuthorizationPromptView,
  AuthorizationView,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host authorization business API and Remote namespace owner. */
    authorizationController: AuthorizationController
  }
}

/** Phases in which the owned attempt still holds the single attempt slot. */
const ACTIVE_PHASES: readonly AuthorizationAttemptPhase[] = ['starting', 'running', 'prompting']

/**
 * Seam failure codes this namespace reports under its own declared codes. A
 * code outside the table reaches the view as the seam reported it, so the
 * mapping never invents a code the seam did not produce.
 */
const DECLARED_FAILURES: Readonly<Record<string, string>> = {
  NO_FLOW: 'authorization/no-flow',
  UNKNOWN_METHOD: 'authorization/unknown-method',
  ALREADY_IN_FLIGHT: 'authorization/already-in-flight',
  NOT_COMMITTED: 'authorization/not-committed',
}

/** One outstanding question the running attempt is parked on. */
interface PendingPrompt {
  /** What a surface renders, and the identity `answer` and `decline` must name. */
  readonly view: AuthorizationPromptView
  /** Option ids a `select` accepts; undefined for a free-text question. */
  readonly options: readonly string[] | undefined
  /** Settle the flow's `prompt()` with the answer it will receive. */
  accept(value: string): void
  /** Reject the flow's `prompt()`: a decline, or the attempt going away. */
  refuse(error: unknown): void
  /** Stop listening to the question's own withdrawal signal. */
  unwatch(): void
}

/** The one attempt this controller owns, from `start()` until its flow settles. */
interface Attempt {
  readonly key: CredentialKey
  readonly method: string
  /** Withdraws the whole attempt, both at the seam and for the flow. */
  readonly controller: AbortController
  phase: AuthorizationAttemptPhase
  notice: AuthorizationNotice | undefined
  prompt: PendingPrompt | undefined
  failure: string | undefined
  /** Settlement of the background `begin()`, which never rejects. */
  done: Promise<void>
}

/**
 * Authorization commands and a reconnect-safe state stream. The controller
 * owns exactly one running attempt at a time: `start` claims the slot for a
 * key, `answer` and `decline` resolve the attempt's current prompt, `cancel`
 * withdraws it, and every mutating method returns the complete view as it
 * stands after the command, so a caller never has to separately re-fetch
 * state. `decline` and `cancel` return without waiting for the flow to settle;
 * the terminal phase reaches surfaces through `watch`.
 */
export class AuthorizationController extends TypertRemoteService {
  static inject = ['authorization', 'credentials']

  private attempt: Attempt | undefined
  private readonly listeners = new Set<() => void>()
  private disposed = false

  /** @param ctx - Host with the authorization and credentials seams mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
    ctx.effect(() => async () => {
      this.disposed = true
      const attempt = this.attempt
      // Disposal is terminal: the settling attempt keeps its own view to
      // itself, and no surface can reach this controller again.
      this.attempt = undefined
      attempt?.controller.abort()
      // A flow parked on a question nobody can answer any more has to be let
      // go, or its own fiber would outlive the plugin that owns it.
      if (attempt !== undefined) {
        this.refusePrompt(attempt, new Error('authorization: the authorization controller was disposed'))
      }
      // Waking the watchers is what ends their iterators: each loop condition
      // then reads `disposed` instead of publishing one more frame.
      this.changed()
      await attempt?.done
    }, 'authorization-controller: active attempt lifetime')
  }

  /**
   * Read the current authorization view.
   * @returns every registered flow and the controller-owned attempt, if any.
   */
  @Remote
  async getState(): Promise<AuthorizationView> {
    const flows = await Promise.all(this.ctx.authorization.list().map(async (entry): Promise<AuthorizationFlowView> => {
      const record = await this.ctx.credentials.describeRecord(entry.key)
      return {
        key: entry.key,
        label: entry.label,
        methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
        inFlight: entry.inFlight,
        configured: record.configured,
        writable: record.writable,
      }
    }))
    return { flows, attempt: this.attemptView() }
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
  start(key: CredentialKey, method?: string): Promise<AuthorizationView> {
    const parsed = parsedKey(key)
    if (parsed === undefined) {
      return refuse('gateway/bad-request', `credential key "${key}" must be "<scope>/<id>"`, {})
    }
    const flow = this.ctx.authorization.describe(parsed)
    if (flow === undefined) {
      return refuse('authorization/no-flow', `no authorization flow is registered for "${parsed}"`, { key: parsed })
    }
    // The seam types a registered flow's methods non-empty, and `describe`
    // only ever projects a registered flow, so the default names a real method.
    const [preferred] = flow.methods as readonly [AuthorizationMethod, ...AuthorizationMethod[]]
    const selected = method ?? preferred.id
    if (!flow.methods.some(candidate => candidate.id === selected)) {
      return refuse(
        'authorization/unknown-method',
        `the authorization flow for "${parsed}" offers no method "${selected}"`,
        { key: parsed, method: selected },
      )
    }
    const active = this.attempt
    if (active !== undefined && ACTIVE_PHASES.includes(active.phase)) {
      if (active.key === parsed) return this.getState()
      return refuse(
        'authorization/already-in-flight',
        `an authorization attempt for "${active.key}" is already running`,
        { key: parsed },
      )
    }
    const attempt: Attempt = {
      key: parsed,
      method: selected,
      controller: new AbortController(),
      phase: 'starting',
      notice: undefined,
      prompt: undefined,
      failure: undefined,
      done: Promise.resolve(),
    }
    this.attempt = attempt
    // Deliberately not awaited: `start` answers with the attempt's first state
    // and every later change reaches surfaces through `watch`.
    attempt.done = this.ctx.authorization.begin({
      key: parsed,
      method: selected,
      signal: attempt.controller.signal,
      interaction: {
        notify: (notice) => { this.notify(attempt, notice) },
        prompt: prompt => this.prompt(attempt, prompt),
      },
    }).then(
      (outcome) => { this.settle(attempt, outcome.status) },
      (error: unknown) => { this.settle(attempt, 'failed', failureCodeOf(error)) },
    )
    return this.getState()
  }

  /**
   * Answer the active attempt's current prompt.
   * @param promptId - identity of the prompt this answer addresses.
   * @param value - typed text, or the chosen option's id for a `select` prompt.
   * @returns state after the answer is delivered to the running flow.
   * @throws {RemoteError} code `authorization/stale-prompt` when no attempt is
   *   waiting on `promptId`, or when a `select` prompt offers no such option,
   *   because the prompt's own options are the only answers it accepts.
   */
  @Remote
  answer(promptId: AuthorizationPromptId, value: string): Promise<AuthorizationView> {
    const attempt = this.attempt
    const prompt = attempt?.prompt
    if (attempt === undefined || prompt === undefined || prompt.view.id !== promptId) {
      return refuse('authorization/stale-prompt', `no prompt "${promptId}" is waiting for an answer`, { promptId })
    }
    if (prompt.options !== undefined && !prompt.options.includes(value)) {
      return refuse(
        'authorization/stale-prompt',
        `prompt "${promptId}" offers no option "${value}"`,
        { promptId },
      )
    }
    this.releasePrompt(attempt, prompt)
    prompt.accept(value)
    return this.getState()
  }

  /**
   * Decline the active attempt's current prompt. The attempt settles
   * `cancelled`, the same outcome as a withdrawn signal, because a human
   * saying no is a refusal, not a breakage.
   * @param promptId - identity of the prompt being declined.
   * @returns the complete view as it stands after the refusal, taken without
   *   waiting for the flow to unwind; the attempt's terminal phase follows
   *   through `watch`.
   * @throws {RemoteError} code `authorization/stale-prompt` when no attempt is
   *   waiting on `promptId`.
   */
  @Remote
  async decline(promptId: AuthorizationPromptId): Promise<AuthorizationView> {
    const attempt = this.attempt
    const prompt = attempt?.prompt
    if (attempt === undefined || prompt === undefined || prompt.view.id !== promptId) {
      throw new RemoteError('authorization/stale-prompt', `no prompt "${promptId}" is waiting to be declined`, { promptId })
    }
    this.releasePrompt(attempt, prompt)
    prompt.refuse(new AuthorizationDeclinedError(`prompt "${promptId}" was declined`))
    // Deliberately not awaited: a flow that catches its own decline and asks
    // another question would otherwise hold this Remote call open until a
    // surface answered a question the human already said no to.
    return this.getState()
  }

  /**
   * Withdraw the controller-owned attempt, if one is running. A no-op when
   * nothing is active, so a stale Cancel click never fails.
   * @returns the complete view as it stands after the withdrawal, taken
   *   without waiting for the flow to unwind; the terminal `cancelled` phase
   *   follows through `watch`.
   */
  @Remote
  async cancel(): Promise<AuthorizationView> {
    const attempt = this.attempt
    if (attempt === undefined || !ACTIVE_PHASES.includes(attempt.phase)) return this.getState()
    attempt.controller.abort()
    this.ctx.authorization.cancel(attempt.key)
    // The seam stops waiting for the flow, so refusing the parked question is
    // the only thing left that stops the flow itself. A plain Error, never an
    // `AuthorizationDeclinedError`: nobody declined this question.
    this.refusePrompt(attempt, new Error('authorization: the attempt was cancelled'))
    return this.getState()
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
    const parsed = parsedKey(key)
    if (parsed === undefined) {
      throw new RemoteError('gateway/bad-request', `credential key "${key}" must be "<scope>/<id>"`, {})
    }
    if (this.ctx.authorization.describe(parsed) === undefined) {
      throw new RemoteError('authorization/no-flow', `no authorization flow is registered for "${parsed}"`, { key: parsed })
    }
    const record = await this.ctx.credentials.describeRecord(parsed)
    if (!record.writable) {
      throw new RemoteError(
        'authorization/read-only',
        `the active credential provider cannot write the record for "${parsed}"`,
        { key: parsed },
      )
    }
    const active = this.attempt
    if (active?.key === parsed && ACTIVE_PHASES.includes(active.phase)) await this.cancel()
    await this.ctx.credentials.deleteRecord(parsed)
    return this.getState()
  }

  /**
   * Stream the complete authorization view.
   * @param signal - stream lifetime.
   * @returns initial snapshot and subsequent complete views.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<AuthorizationView> {
    let dirty = true
    // A parked subscriber drops its own resolver here; the initial no-op makes
    // a change that arrives while the loop is working a plain dirty mark.
    let wake: () => void = () => undefined
    // The latest view per subscriber, never a queue: a surface that missed
    // three changes renders the state after all three.
    const changed = (): void => { dirty = true; wake() }
    const stopRecord = this.ctx.on('credentials/record-updated', (key: CredentialKey) => {
      // Only a flow key's record can change what this view reports.
      if (this.ctx.authorization.describe(key) !== undefined) changed()
    })
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      // A signal that already aborted still receives the current view once: it
      // asked for the state, and honouring the withdrawal before that first
      // read would answer the request with nothing.
      let opening = true
      while (!this.disposed && (opening || !signal.aborted)) {
        opening = false
        if (dirty) { dirty = false; yield await this.getState(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      stopRecord()
      signal.removeEventListener('abort', changed)
    }
  }

  /** The current attempt as a surface reads it, without the controller's own handles. */
  private attemptView(): AuthorizationAttemptView | null {
    const attempt = this.attempt
    if (attempt === undefined) return null
    return {
      key: attempt.key,
      method: attempt.method,
      phase: attempt.phase,
      ...attempt.notice === undefined ? {} : { notice: attempt.notice },
      ...attempt.prompt === undefined ? {} : { prompt: attempt.prompt.view },
      ...attempt.failure === undefined ? {} : { failure: attempt.failure },
    }
  }

  /** Report progress from the running flow, which keeps the attempt running unless it is asking. */
  private notify(attempt: Attempt, notice: AuthorizationNotice): void {
    // A notice from an attempt no surface can reach would resurrect a settled
    // attempt in the view as `running`.
    if (this.ended(attempt) !== undefined) return
    attempt.notice = notice
    if (attempt.prompt === undefined) attempt.phase = 'running'
    this.changed()
  }

  /**
   * Park the attempt on one question until a surface answers or withdraws it.
   * A question the flow itself withdraws (the losing half of a race) leaves
   * the attempt running; only the answer settles which answer the flow gets.
   */
  private prompt(attempt: Attempt, prompt: AuthorizationPrompt): Promise<string> {
    // A question parked after the attempt is gone waits for an answer no
    // surface can deliver, and holds the asking flow's fiber with it.
    const ended = this.ended(attempt)
    if (ended !== undefined) return Promise.reject(ended)
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    const view = promptView(prompt)
    const pending: PendingPrompt = {
      view,
      options: view.options?.map(option => option.id),
      accept: (value) => { resolve(value) },
      refuse: (error) => { reject(error) },
      unwatch: () => { prompt.signal?.removeEventListener('abort', withdraw) },
    }
    const withdraw = (): void => {
      // `releasePrompt` drops only the question the attempt is parked on, so a
      // flow that asked twice without awaiting the first loses the question
      // this signal belongs to and keeps the one still on the view.
      this.releasePrompt(attempt, pending)
      reject(new Error(`authorization: the prompt "${view.id}" was withdrawn`))
    }
    prompt.signal?.addEventListener('abort', withdraw, { once: true })
    attempt.prompt = pending
    attempt.phase = 'prompting'
    this.changed()
    return promise
  }

  /**
   * Why a callback from this flow no longer reaches a surface, or undefined
   * while it still does. Disposal, a newer `start` taking the slot, and
   * settlement all end the conversation, and a question parked after any of
   * them could never be answered.
   */
  private ended(attempt: Attempt): Error | undefined {
    if (this.disposed) return new Error('authorization: the authorization controller was disposed')
    // A replaced attempt is a settled one — `start` claims the slot only after
    // the previous attempt reached a terminal phase — so the attempt holding
    // the slot is the only one that still answers a flow's callbacks.
    if (this.attempt !== attempt || !ACTIVE_PHASES.includes(attempt.phase)) {
      return new Error('authorization: the attempt has already settled')
    }
    return undefined
  }

  /** Drop one parked question, leaving the attempt free to ask the next. */
  private releasePrompt(attempt: Attempt, prompt: PendingPrompt): void {
    // Only the question this call was made for: a withdrawal must never take
    // the attempt off a question a surface is still being asked.
    if (attempt.prompt !== prompt) return
    prompt.unwatch()
    attempt.prompt = undefined
    attempt.phase = 'running'
    this.changed()
  }

  /**
   * Detach whatever question the attempt is parked on and reject it, so a flow
   * the seam no longer waits for stops instead of holding its fiber and
   * whatever it owns.
   */
  private refusePrompt(attempt: Attempt, error: Error): void {
    const prompt = attempt.prompt
    if (prompt === undefined) return
    this.releasePrompt(attempt, prompt)
    prompt.refuse(error)
  }

  /**
   * Write one attempt's terminal phase. A settlement that arrives after a
   * newer attempt took over the slot belongs to the replaced attempt alone.
   */
  private settle(attempt: Attempt, phase: AuthorizationAttemptPhase, failure?: string): void {
    // The flow is over, so a question still parked on it can never be answered.
    this.refusePrompt(attempt, new Error('authorization: the attempt ended before its question was answered'))
    if (this.attempt !== attempt) return
    attempt.phase = phase
    attempt.failure = failure
    this.changed()
  }

  /** Wake every watcher, which then reads the whole view again. */
  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

/**
 * One refusal as the rejected promise every Remote method signature promises,
 * so an in-process caller and the Gateway both see the same failure form.
 * @param code - the declared failure code.
 * @param message - the human diagnostic.
 * @param details - the structured payload that code declares.
 * @returns a rejected promise no method body ever resolves.
 */
function refuse<Code extends RemoteErrorCode>(
  code: Code,
  message: string,
  details: RemoteErrorDetailsMap[Code],
): Promise<never> {
  return Promise.reject(new RemoteError(code, message, details))
}

/**
 * Brand one key a Remote caller sent, or report nothing: a wire string outside
 * `<scope>/<id>` addresses no record, so the caller's grammar failure is the
 * carrier's bad request rather than a domain failure a seam could report.
 * @param key - the requested key.
 * @returns the branded key, or undefined when the wire string is outside the grammar.
 */
function parsedKey(key: CredentialKey): CredentialKey | undefined {
  try {
    return parseCredentialKey(key)
  } catch {
    // Nothing to report here: the caller turns an unparsable string into the
    // carrier's own bad request, which is what it was.
    return undefined
  }
}

/** The wire view of one question, copying exactly the fields the view declares. */
function promptView(prompt: AuthorizationPrompt): AuthorizationPromptView {
  const id = brandString<AuthorizationPromptId>(randomUUID())
  if (prompt.kind !== 'select') {
    return {
      id,
      kind: prompt.kind,
      message: prompt.message,
      ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
    }
  }
  return {
    id,
    kind: 'select',
    message: prompt.message,
    options: prompt.options.map(option => ({
      id: option.id,
      label: option.label,
      ...option.description === undefined ? {} : { description: option.description },
    })),
  }
}

/**
 * The short failure code one failed attempt reports: this namespace's declared
 * code when the seam named one, the failure's own code otherwise, so a surface
 * routes on a stable string and never receives provider text.
 * @param error - the rejection the seam settled the attempt with.
 * @returns the code to publish on the attempt view.
 */
function failureCodeOf(error: unknown): string {
  // `Object()` never throws: a rejection that is not an Error has no code.
  const code: unknown = Reflect.get(Object(error), 'code')
  return typeof code === 'string' ? DECLARED_FAILURES[code] ?? code : 'unknown'
}

export default AuthorizationController
