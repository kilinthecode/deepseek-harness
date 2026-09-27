/** Authorization Remote behavior over the real authorization and credential seams. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService, { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationPromptId, AuthorizationPromptView, AuthorizationView } from '../src/types.ts'
import AuthorizationController from '../src/index.ts'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const OTHER = credentialKey('llm-pi-ai', 'anthropic')
const STORED = { kind: 'grant', payload: { token: 'stored' } }
const COMMITTED = { kind: 'grant', payload: { token: 'granted' } }
const NOTICE = { message: 'Continue in your browser', url: 'https://auth.example/start' }
const METHODS = [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'device', label: 'Use a device code' }]

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

/** A store that reads records but reports none of them writable. */
class ReadOnlyCredentials extends MemoryCredentials {
  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    return { ...await super.describeRecord(key), writable: false }
  }
}

/**
 * A store whose first `describeRecord` parks until a case releases it, which
 * holds the view a stream is reading open long enough for a change to land
 * inside that read instead of after it.
 * @returns the provider to boot, and the handshake that observes and releases its parked read.
 */
function parkingStore(): { store: typeof MemoryCredentials; entered: Promise<void>; release: () => void } {
  const entered = Promise.withResolvers<undefined>()
  const held = Promise.withResolvers<undefined>()
  let parked = false
  class ParkingCredentials extends MemoryCredentials {
    override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
      if (!parked) {
        parked = true
        entered.resolve(undefined)
        await held.promise
      }
      return await super.describeRecord(key)
    }
  }
  return { store: ParkingCredentials, entered: entered.promise, release: () => { held.resolve(undefined) } }
}

/** A context carrying the real authorization seam, the controller, and an in-memory record store. */
async function boot(provider: typeof MemoryCredentials = MemoryCredentials): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(provider)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(AuthorizationController)
  return ctx
}

/** What one scripted flow allows a case to gate or withhold. */
interface ScriptOptions {
  /** The flow arms the text question with this signal, as one racing a local callback would. */
  withdraw?: AbortSignal
  /** Held between the text question and the commit, so a case can observe the running attempt. */
  hold?: Promise<void>
  /** Skipped commit, which the seam reports as `NOT_COMMITTED`. */
  commit?: boolean
}

/** A scripted sign-in flow and the observations its case asserts on. */
interface Script {
  /** The flow to register. */
  readonly flow: AuthorizationFlow
  /** What `session.prompt` returned, one entry per answered question. */
  readonly answers: string[]
  /** Set when the text question ended by its own withdrawal instead of an answer. */
  readonly withdrawals: string[]
  /** Rejections the flow body saw on its way out, recorded and rethrown unchanged. */
  readonly failures: unknown[]
}

/**
 * The flow every case drives: a `select` question, a notice carrying a URL, a
 * `text` question it may withdraw, and the record commit that authorizes the key.
 * @param ctx - context owning the credential store the commit writes through.
 * @param key - the credential record this flow authorizes.
 * @param options - the gates and withholdings one case needs.
 * @returns the flow and the observations it recorded.
 */
function scripted(ctx: Context, key: CredentialKey, options: ScriptOptions = {}): Script {
  const answers: string[] = []
  const withdrawals: string[] = []
  const failures: unknown[] = []
  return {
    answers,
    withdrawals,
    failures,
    flow: {
      key,
      label: 'ChatGPT (Codex)',
      methods: METHODS,
      async run(session) {
        try {
          answers.push(await session.prompt({
            kind: 'select',
            message: 'How do you want to sign in?',
            options: [
              { id: 'browser', label: 'Browser', description: 'Opens a page in this browser' },
              { id: 'device', label: 'Device code' },
            ],
          }))
          session.notify(NOTICE)
          try {
            answers.push(await session.prompt({
              kind: 'text',
              message: 'Paste the authorization code',
              placeholder: 'code',
              ...options.withdraw === undefined ? {} : { signal: options.withdraw },
            }))
          } catch (error: unknown) {
            // Only the withdrawal this flow armed is the race it expected to lose.
            if (options.withdraw?.aborted !== true) throw error
            withdrawals.push('callback')
          }
          await options.hold
          if (options.commit === false) return
          await ctx.credentials.modifyRecord(key, () => Promise.resolve(COMMITTED))
        } catch (error: unknown) {
          failures.push(error)
          throw error
        }
      },
    },
  }
}

/** The failure one Remote call reports, whether it threw before or after returning its promise. */
async function failureOf(call: () => Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await call()
  } catch (error: unknown) {
    const failure = remoteErrorOf(error)
    // A non-Remote throw is a defect in the service, not an expected outcome.
    if (failure === undefined) throw error
    return { code: failure.code, details: failure.details }
  }
  throw new Error('expected the call to fail')
}

/** The view's parked question, failing loudly when the attempt is not asking one. */
function promptOf(view: AuthorizationView): AuthorizationPromptView {
  const prompt = view.attempt?.prompt
  if (prompt === undefined) throw new Error('the attempt is not parked on a prompt')
  return prompt
}

/** The controller's current state. */
function state(ctx: Context): Promise<AuthorizationView> {
  return ctx.authorizationController.getState()
}

/** Wait until the attempt reports `phase`, so a case never races the flow's own microtasks. */
async function awaitPhase(ctx: Context, phase: string): Promise<AuthorizationView> {
  await vi.waitFor(async () => { expect((await state(ctx)).attempt?.phase).toBe(phase) })
  return await state(ctx)
}

describe('the authorization Remote namespace a sign-in surface calls', () => {
  it('carries a flow from its select question through the notice to authorized state', async () => {
    const ctx = await boot()
    const script = scripted(ctx, KEY)
    ctx.authorization.registerFlow(script.flow)

    const started = await ctx.authorizationController.start(KEY)

    expect(started.flows).toEqual([{
      key: KEY, label: 'ChatGPT (Codex)', methods: METHODS, inFlight: true, configured: false, writable: true,
    }])
    expect(started.attempt).toMatchObject({ key: KEY, method: 'oauth', phase: 'prompting' })
    const select = promptOf(started)
    expect(select).toMatchObject({
      kind: 'select',
      message: 'How do you want to sign in?',
      options: [{ id: 'browser', label: 'Browser' }, { id: 'device', label: 'Device code' }],
    })

    // A select answers with an offered option id and nothing else.
    expect(await failureOf(() => ctx.authorizationController.answer(select.id, 'sms'))).toEqual({
      code: 'authorization/stale-prompt',
      details: { promptId: select.id },
    })

    await ctx.authorizationController.answer(select.id, 'browser')
    expect(script.answers).toEqual(['browser'])

    const asking = await awaitPhase(ctx, 'prompting')
    expect(asking.attempt?.notice).toEqual(NOTICE)
    const text = promptOf(asking)
    expect(text).toMatchObject({ kind: 'text', message: 'Paste the authorization code', placeholder: 'code' })

    await ctx.authorizationController.answer(text.id, 'code-123')
    const settled = await awaitPhase(ctx, 'authorized')

    expect(script.answers).toEqual(['browser', 'code-123'])
    expect(settled.attempt).toEqual({ key: KEY, method: 'oauth', phase: 'authorized', notice: NOTICE })
    expect(settled.flows[0]).toMatchObject({ configured: true, inFlight: false })
    expect(await ctx.credentials.readRecord(KEY)).toEqual(COMMITTED)
  })

  it('withdraws only the question whose own signal aborted, leaving the attempt running', async () => {
    const ctx = await boot()
    const withdraw = new AbortController()
    const hold = Promise.withResolvers<undefined>()
    const script = scripted(ctx, KEY, { withdraw: withdraw.signal, hold: hold.promise })
    ctx.authorization.registerFlow(script.flow)

    const started = await ctx.authorizationController.start(KEY)
    await ctx.authorizationController.answer(promptOf(started).id, 'browser')
    const text = promptOf(await awaitPhase(ctx, 'prompting'))

    withdraw.abort()

    // The withdrawn question leaves the view; the attempt itself keeps running.
    const withdrawing = await state(ctx)
    expect(withdrawing.attempt).toMatchObject({ key: KEY, phase: 'running', notice: NOTICE })
    expect(withdrawing.attempt?.prompt).toBeUndefined()
    expect(script.withdrawals).toEqual(['callback'])
    expect(await failureOf(() => ctx.authorizationController.answer(text.id, 'code-123')))
      .toEqual({ code: 'authorization/stale-prompt', details: { promptId: text.id } })

    hold.resolve(undefined)
    const settled = await awaitPhase(ctx, 'authorized')

    expect(settled.flows[0]).toMatchObject({ configured: true, inFlight: false })
  })

  it('settles a declined question as cancelled without storing anything', async () => {
    const ctx = await boot()
    const script = scripted(ctx, KEY)
    ctx.authorization.registerFlow(script.flow)
    const select = promptOf(await ctx.authorizationController.start(KEY))

    const declined = await ctx.authorizationController.decline(select.id)

    // The answer is the view as the refusal left it; the terminal phase arrives
    // through the stream rather than through this call.
    expect(declined.attempt?.key).toBe(KEY)
    expect(declined.attempt?.prompt).toBeUndefined()
    const settled = await awaitPhase(ctx, 'cancelled')

    expect(settled.attempt).toMatchObject({ key: KEY, phase: 'cancelled' })
    expect(settled.flows[0]).toMatchObject({ configured: false, inFlight: false })
    expect(script.answers).toEqual([])
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(await failureOf(() => ctx.authorizationController.decline(select.id)))
      .toEqual({ code: 'authorization/stale-prompt', details: { promptId: select.id } })
  })

  it('answers a decline without waiting for a flow that keeps asking', async () => {
    const ctx = await boot()
    const declined: unknown[] = []
    const answers: string[] = []
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Stubborn',
      methods: METHODS,
      async run(session) {
        try {
          await session.prompt({ kind: 'select', message: 'Sign in?', options: [{ id: 'yes', label: 'Yes' }] })
        } catch (error: unknown) {
          // Swallows the human's refusal and asks again instead of unwinding.
          declined.push(error)
          answers.push(await session.prompt({ kind: 'text', message: 'Ask again anyway' }))
          await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(COMMITTED))
        }
      },
    })
    const select = promptOf(await ctx.authorizationController.start(KEY))

    await ctx.authorizationController.decline(select.id)

    expect(declined).toEqual([expect.any(AuthorizationDeclinedError)])
    // The question the flow asked instead is the surface's to answer; the
    // decline call itself neither waits for it nor hides it.
    const again = promptOf(await awaitPhase(ctx, 'prompting'))
    expect(again).toMatchObject({ kind: 'text', message: 'Ask again anyway' })

    await ctx.authorizationController.answer(again.id, 'code')

    expect((await awaitPhase(ctx, 'authorized')).flows[0]).toMatchObject({ configured: true, inFlight: false })
    expect(answers).toEqual(['code'])
  })

  it('withdraws a mid-question attempt through the seam, refusing its parked question', async () => {
    const ctx = await boot()
    const script = scripted(ctx, KEY)
    ctx.authorization.registerFlow(script.flow)
    const cancel = vi.spyOn(ctx.authorization, 'cancel')
    const lifetime = new AbortController()
    const frames: AuthorizationView[] = []
    const reader = (async () => {
      for await (const view of ctx.authorizationController.watch(lifetime.signal)) frames.push(view)
    })()
    await vi.waitFor(() => { expect(frames).toHaveLength(1) })
    await ctx.authorizationController.start(KEY)
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true)

    const cancelled = await ctx.authorizationController.cancel()

    // The answer is the view as the withdrawal left it: the attempt is off its
    // question, and the terminal phase arrives through the stream.
    expect(cancel).toHaveBeenCalledExactlyOnceWith(KEY)
    expect(cancelled.attempt).toMatchObject({ key: KEY })
    expect(cancelled.attempt?.prompt).toBeUndefined()

    // The seam stops waiting for the flow the moment the signal aborts, so the
    // refusal is the only thing that can release the parked flow.
    await vi.waitFor(() => {
      expect(script.failures).toEqual([
        expect.objectContaining({ message: 'authorization: the attempt was cancelled' }),
      ])
    })
    expect(script.failures[0]).not.toBeInstanceOf(AuthorizationDeclinedError)
    await vi.waitFor(() => { expect(frames.at(-1)?.attempt?.phase).toBe('cancelled') })
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()

    // Nothing holds the slot any more, so a stale Cancel click reads state instead of failing.
    expect((await ctx.authorizationController.cancel()).attempt).toMatchObject({ phase: 'cancelled' })
    expect(cancel).toHaveBeenCalledOnce()

    lifetime.abort()
    await expect(reader).resolves.toBeUndefined()
  })

  it('refuses the parked question when the seam withdraws the attempt instead', async () => {
    const ctx = await boot()
    const script = scripted(ctx, KEY)
    ctx.authorization.registerFlow(script.flow)
    await ctx.authorizationController.start(KEY)

    // Another surface withdrew the attempt at the seam, so the controller only
    // learns about it from the settlement, with the flow still parked.
    ctx.authorization.cancel(KEY)

    await vi.waitFor(() => {
      expect(script.failures).toEqual([
        expect.objectContaining({ message: 'authorization: the attempt ended before its question was answered' }),
      ])
    })
    const settled = await awaitPhase(ctx, 'cancelled')
    expect(settled.attempt?.prompt).toBeUndefined()
    expect(settled.flows[0]).toMatchObject({ inFlight: false })
  })

  it('refuses a question and ignores a notice from a flow whose attempt already settled', async () => {
    const ctx = await boot()
    const hold = Promise.withResolvers<undefined>()
    const swallowed: unknown[] = []
    const refused: unknown[] = []
    const notified: string[] = []
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Orphan',
      methods: METHODS,
      async run(session) {
        try {
          await session.prompt({ kind: 'text', message: 'Paste the authorization code' })
        } catch (error: unknown) {
          swallowed.push(error)
        }
        await hold.promise
        try {
          await session.prompt({ kind: 'text', message: 'Still there?' })
        } catch (error: unknown) {
          refused.push(error)
        }
        session.notify({ message: 'Attempting a fallback' })
        notified.push('notice')
      },
    })
    await ctx.authorizationController.start(KEY)

    await ctx.authorizationController.cancel()
    await awaitPhase(ctx, 'cancelled')
    hold.resolve(undefined)

    await vi.waitFor(() => {
      expect(refused).toEqual([
        expect.objectContaining({ message: 'authorization: the attempt has already settled' }),
      ])
    })
    expect(swallowed).toEqual([
      expect.objectContaining({ message: 'authorization: the attempt was cancelled' }),
    ])
    expect(notified).toEqual(['notice'])
    // Neither callback returns the settled attempt to the view.
    const after = await state(ctx)
    expect(after.attempt).toMatchObject({ key: KEY, phase: 'cancelled' })
    expect(after.attempt?.prompt).toBeUndefined()
    expect(after.attempt?.notice).toBeUndefined()
  })

  it('streams the state after every change and coalesces to the latest view per subscriber', async () => {
    const ctx = await boot()
    const script = scripted(ctx, KEY)
    ctx.authorization.registerFlow(script.flow)
    const lifetime = new AbortController()
    const frames: AuthorizationView[] = []
    const reader = (async () => {
      for await (const view of ctx.authorizationController.watch(lifetime.signal)) frames.push(view)
    })()

    await vi.waitFor(() => { expect(frames).toHaveLength(1) })
    expect(frames[0]).toEqual({
      flows: [{ key: KEY, label: 'ChatGPT (Codex)', methods: METHODS, inFlight: false, configured: false, writable: true }],
      attempt: null,
    })

    const started = await ctx.authorizationController.start(KEY)
    await vi.waitFor(() => { expect(frames.at(-1)?.attempt?.prompt?.kind).toBe('select') })

    await ctx.authorizationController.answer(promptOf(started).id, 'browser')
    const text = promptOf(await awaitPhase(ctx, 'prompting'))
    await vi.waitFor(() => { expect(frames.at(-1)?.attempt?.prompt?.kind).toBe('text') })

    await ctx.authorizationController.answer(text.id, 'code-123')
    await vi.waitFor(() => { expect(frames.at(-1)?.attempt?.phase).toBe('authorized') })
    expect(frames.at(-1)?.flows[0]).toMatchObject({ configured: true, inFlight: false })

    // The record half of the view follows the store, with no command from this subscriber.
    await ctx.authorizationController.signOut(KEY)
    await vi.waitFor(() => { expect(frames.at(-1)?.flows[0]?.configured).toBe(false) })

    // A record outside the flow registry is not part of this view.
    await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'unrelated'), () => Promise.resolve(STORED))
    expect(frames.at(-1)?.flows).toHaveLength(1)

    const phases = frames.map(view => view.attempt?.phase ?? null)
    expect(phases[0]).toBeNull()
    expect(phases).toContain('prompting')
    expect(phases.indexOf('authorized')).toBeGreaterThan(phases.indexOf('prompting'))
    expect(frames.some(view => view.attempt?.notice !== undefined)).toBe(true)

    lifetime.abort()
    await expect(reader).resolves.toBeUndefined()
  })

  it('keeps a change that lands while the stream is still reading its first view', async () => {
    const parking = parkingStore()
    const ctx = await boot(parking.store)
    ctx.authorization.registerFlow(scripted(ctx, KEY).flow)
    const lifetime = new AbortController()
    const frames: AuthorizationView[] = []
    const reader = (async () => {
      for await (const view of ctx.authorizationController.watch(lifetime.signal)) frames.push(view)
    })()

    // The stream is inside its opening view read, so it has nothing parked to
    // wake: the change has to survive as a pending re-read.
    await parking.entered
    ctx.emit('credentials/record-updated', KEY)
    parking.release()

    await vi.waitFor(() => { expect(frames).toHaveLength(2) })
    expect(frames[0]?.flows[0]).toMatchObject({ key: KEY, inFlight: false, configured: false, writable: true })
    expect(frames[1]).toEqual(frames[0])

    lifetime.abort()
    await expect(reader).resolves.toBeUndefined()
  })

  it('yields the current view once to a stream whose signal already aborted', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(scripted(ctx, KEY).flow)
    const lifetime = new AbortController()
    lifetime.abort()

    const frames: AuthorizationView[] = []
    for await (const view of ctx.authorizationController.watch(lifetime.signal)) frames.push(view)

    expect(frames).toEqual([{
      flows: [{ key: KEY, label: 'ChatGPT (Codex)', methods: METHODS, inFlight: false, configured: false, writable: true }],
      attempt: null,
    }])
  })

  it('keeps one attempt at a time: the same key reads it, another key is refused, a settled one is replaced', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(scripted(ctx, KEY).flow)
    ctx.authorization.registerFlow(scripted(ctx, OTHER).flow)

    const started = await ctx.authorizationController.start(KEY)

    expect(await failureOf(() => ctx.authorizationController.start(OTHER))).toEqual({
      code: 'authorization/already-in-flight',
      details: { key: OTHER },
    })
    expect(promptOf(await ctx.authorizationController.start(KEY)).id).toBe(promptOf(started).id)

    await ctx.authorizationController.cancel()
    await awaitPhase(ctx, 'cancelled')
    const restarted = await ctx.authorizationController.start(KEY)

    expect(restarted.attempt).toMatchObject({ phase: 'prompting' })
    expect(promptOf(restarted).id).not.toBe(promptOf(started).id)
  })

  it('withdraws only its own question when a flow asks twice without awaiting the first', async () => {
    const ctx = await boot()
    const stopped = new AbortController()
    const withdrawals: unknown[] = []
    const answers: string[] = []
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Racing',
      methods: METHODS,
      async run(session) {
        const abandoned = session.prompt({
          kind: 'text',
          message: 'Wait for the browser callback',
          signal: stopped.signal,
        })
        void abandoned.catch((error: unknown) => { withdrawals.push(error) })
        answers.push(await session.prompt({
          kind: 'select',
          message: 'Or paste a code',
          options: [{ id: 'code', label: 'Code' }],
        }))
        await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(COMMITTED))
      },
    })
    const parked = promptOf(await ctx.authorizationController.start(KEY))
    expect(parked).toMatchObject({ kind: 'select', message: 'Or paste a code' })

    // The flow gave up on its first question; the attempt is parked on the second.
    stopped.abort()

    await vi.waitFor(() => { expect(withdrawals).toHaveLength(1) })
    expect(withdrawals[0]).toBeInstanceOf(Error)
    expect(promptOf(await state(ctx)).id).toBe(parked.id)

    await ctx.authorizationController.answer(parked.id, 'code')

    expect((await awaitPhase(ctx, 'authorized')).flows[0]).toMatchObject({ configured: true, inFlight: false })
    expect(answers).toEqual(['code'])
  })

  it('signs out only a key a flow claims and a store can write, cancelling any attempt for it', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(scripted(ctx, KEY).flow)
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(STORED))

    expect(await failureOf(() => ctx.authorizationController.signOut(OTHER)))
      .toEqual({ code: 'authorization/no-flow', details: { key: OTHER } })
    expect(await ctx.credentials.readRecord(KEY)).toEqual(STORED)

    await ctx.authorizationController.start(KEY)
    const signedOut = await ctx.authorizationController.signOut(KEY)

    expect(signedOut.attempt?.key).toBe(KEY)
    expect(signedOut.flows[0]).toMatchObject({ configured: false })
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    // Withdrawing the attempt does not wait for the flow to unwind.
    expect((await awaitPhase(ctx, 'cancelled')).flows[0]).toMatchObject({ configured: false, inFlight: false })

    const locked = await boot(ReadOnlyCredentials)
    locked.authorization.registerFlow(scripted(locked, KEY).flow)
    await locked.credentials.modifyRecord(KEY, () => Promise.resolve(STORED))

    expect(await failureOf(() => locked.authorizationController.signOut(KEY)))
      .toEqual({ code: 'authorization/read-only', details: { key: KEY } })
    expect(await locked.credentials.readRecord(KEY)).toEqual(STORED)
  })

  it('refuses a key outside the credential-key grammar as a bad request', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(scripted(ctx, KEY).flow)

    expect(await failureOf(() => ctx.authorizationController.start('openai codex' as CredentialKey)))
      .toEqual({ code: 'gateway/bad-request', details: {} })
    expect(await failureOf(() => ctx.authorizationController.signOut('llm-pi-ai' as CredentialKey)))
      .toEqual({ code: 'gateway/bad-request', details: {} })
  })

  it('runs the method a caller names and refuses one the flow does not offer', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(scripted(ctx, KEY).flow)

    expect(await failureOf(() => ctx.authorizationController.start(KEY, 'sms'))).toEqual({
      code: 'authorization/unknown-method',
      details: { key: KEY, method: 'sms' },
    })
    expect(promptOf(await ctx.authorizationController.start(KEY, 'device')).id).toBeDefined()
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true)
  })

  it('refuses a key no flow claims before it claims the attempt slot', async () => {
    const ctx = await boot()

    expect(await failureOf(() => ctx.authorizationController.start(OTHER)))
      .toEqual({ code: 'authorization/no-flow', details: { key: OTHER } })
    expect((await state(ctx)).attempt).toBeNull()
  })

  it('reports a flow that resolved without committing as a failed attempt', async () => {
    const ctx = await boot()
    const script = scripted(ctx, KEY, { commit: false })
    ctx.authorization.registerFlow(script.flow)

    const started = await ctx.authorizationController.start(KEY)
    await ctx.authorizationController.answer(promptOf(started).id, 'browser')
    const text = promptOf(await awaitPhase(ctx, 'prompting'))
    await ctx.authorizationController.answer(text.id, 'code-123')

    const failed = await awaitPhase(ctx, 'failed')

    expect(failed.attempt).toEqual({
      key: KEY, method: 'oauth', phase: 'failed', notice: NOTICE, failure: 'authorization/not-committed',
    })
    expect(failed.flows[0]).toMatchObject({ configured: false, inFlight: false })
  })

  it('reports a flow failure as a short code and never as provider text', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Broken',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: () => Promise.reject(Object.assign(new Error('the token endpoint said no'), { code: 'token_endpoint_refused' })),
    })

    await ctx.authorizationController.start(KEY)
    const failed = await awaitPhase(ctx, 'failed')

    expect(failed.attempt?.failure).toBe('token_endpoint_refused')
    expect(JSON.stringify(failed)).not.toContain('the token endpoint said no')
  })

  it('reports a failure that carries no code as unknown', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Broken',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: () => Promise.reject(new Error('the browser was closed')),
    })

    await ctx.authorizationController.start(KEY)

    expect((await awaitPhase(ctx, 'failed')).attempt?.failure).toBe('unknown')
  })

  it('reports a key another surface is already authorizing as failed, never as a second run', async () => {
    const ctx = await boot()
    const script = scripted(ctx, KEY)
    ctx.authorization.registerFlow(script.flow)
    // Another Host surface (the account provider, a second tab) holds the key.
    const foreign = ctx.authorization.begin({
      key: KEY,
      interaction: { notify: () => undefined, prompt: () => new Promise(() => undefined) },
    })
    await vi.waitFor(() => { expect(ctx.authorization.describe(KEY)?.inFlight).toBe(true) })

    await ctx.authorizationController.start(KEY)
    const failed = await awaitPhase(ctx, 'failed')

    expect(failed.attempt?.failure).toBe('authorization/already-in-flight')
    expect(script.answers).toEqual([])
    ctx.authorization.cancel(KEY)
    await expect(foreign).resolves.toEqual({ status: 'cancelled' })
  })

  it('withdraws the active attempt and ends its watchers when the plugin is disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    const controller = ctx.plugin(AuthorizationController)
    await controller
    const script = scripted(ctx, KEY)
    ctx.authorization.registerFlow(script.flow)
    const settled = vi.fn()
    ctx.on('authorization/settled', settled)
    const frames: AuthorizationView[] = []
    const reader = (async () => {
      for await (const view of ctx.authorizationController.watch(new AbortController().signal)) frames.push(view)
    })()
    await vi.waitFor(() => { expect(frames).toHaveLength(1) })
    await ctx.authorizationController.start(KEY)

    await controller.dispose()

    expect(script.failures).toEqual([
      expect.objectContaining({ message: 'authorization: the authorization controller was disposed' }),
    ])
    expect(settled).toHaveBeenCalledWith(KEY, 'cancelled')
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
    await expect(reader).resolves.toBeUndefined()
  })

  it('disposes a controller holding a flow that keeps asking after the refusal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    const controller = ctx.plugin(AuthorizationController)
    await controller
    const refusals: unknown[] = []
    const answers: string[] = []
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Uncooperative',
      methods: METHODS,
      async run(session) {
        try {
          await session.prompt({ kind: 'text', message: 'Paste the authorization code' })
        } catch (error: unknown) {
          refusals.push(error)
          // Keeps its own loop alive instead of unwinding with the attempt.
          try {
            answers.push(await session.prompt({ kind: 'text', message: 'Ask me again' }))
          } catch (error: unknown) {
            refusals.push(error)
          }
        }
      },
    })
    await ctx.authorizationController.start(KEY)

    await expect(controller.dispose()).resolves.toBeUndefined()

    // Both the parked question and the one asked afterwards are refused, so no
    // fresh deferred waits for a surface that can no longer answer.
    await vi.waitFor(() => { expect(refusals).toHaveLength(2) })
    for (const refusal of refusals) {
      expect(refusal).toEqual(expect.objectContaining({
        message: 'authorization: the authorization controller was disposed',
      }))
    }
    expect(answers).toEqual([])
  })

  it('disposes a controller that never started an attempt', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    const controller = ctx.plugin(AuthorizationController)
    await controller

    await controller.dispose()

    expect(ctx.authorization.list()).toEqual([])
  })

  it('refuses commands that address no attempt or no current question', async () => {
    const ctx = await boot()
    const script = scripted(ctx, KEY)
    ctx.authorization.registerFlow(script.flow)
    const absent = 'prompt-from-an-earlier-attempt' as AuthorizationPromptId

    expect(await failureOf(() => ctx.authorizationController.answer(absent, 'code')))
      .toEqual({ code: 'authorization/stale-prompt', details: { promptId: absent } })
    expect(await failureOf(() => ctx.authorizationController.decline(absent)))
      .toEqual({ code: 'authorization/stale-prompt', details: { promptId: absent } })
    expect((await ctx.authorizationController.cancel()).attempt).toBeNull()

    await ctx.authorizationController.start(KEY)

    expect(await failureOf(() => ctx.authorizationController.answer(absent, 'code')))
      .toEqual({ code: 'authorization/stale-prompt', details: { promptId: absent } })
    expect(await failureOf(() => ctx.authorizationController.decline(absent)))
      .toEqual({ code: 'authorization/stale-prompt', details: { promptId: absent } })
    expect(promptOf(await state(ctx)).id).not.toBe(absent)
  })

  it('signs out a flow key with no attempt and leaves another attempt alone', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(scripted(ctx, KEY).flow)
    ctx.authorization.registerFlow(scripted(ctx, OTHER).flow)
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(STORED))

    const signedOut = await ctx.authorizationController.signOut(KEY)

    expect(signedOut.flows.find(flow => flow.key === KEY)).toMatchObject({ configured: false, inFlight: false })

    await ctx.authorizationController.start(KEY)
    await ctx.credentials.modifyRecord(OTHER, () => Promise.resolve(STORED))
    const whileRunning = await ctx.authorizationController.signOut(OTHER)

    expect(await ctx.credentials.readRecord(OTHER)).toBeUndefined()
    expect(whileRunning.flows.find(flow => flow.key === KEY)).toMatchObject({ inFlight: true, configured: false })
    expect((await state(ctx)).attempt).toMatchObject({ key: KEY, phase: 'prompting' })
  })

  it('keeps an attempt prompting while its flow reports progress, copying only declared prompt fields', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Chatty',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        const typed = session.prompt({ kind: 'secret', message: 'Paste the token' })
        session.notify({ message: 'Still waiting for the token' })
        await typed
        await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(COMMITTED))
      },
    })

    const started = await ctx.authorizationController.start(KEY)
    const prompt = promptOf(started)

    expect(prompt).toEqual({ id: prompt.id, kind: 'secret', message: 'Paste the token' })
    expect(started.attempt).toMatchObject({ phase: 'prompting', notice: { message: 'Still waiting for the token' } })

    await ctx.authorizationController.answer(prompt.id, 'sk-secret')

    expect((await awaitPhase(ctx, 'authorized')).flows[0]).toMatchObject({ configured: true, inFlight: false })
  })
})
