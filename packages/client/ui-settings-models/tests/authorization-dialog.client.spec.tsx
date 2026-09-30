// @vitest-environment jsdom
/** Sign-in dialog: method choice, notice link and code, prompts, and phase outcomes. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  AuthorizationAttemptView,
  AuthorizationFlowView,
  AuthorizationPromptId,
  AuthorizationPromptView,
  AuthorizationView,
} from '@deepseek-ai/dsh-api-authorization-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import { AuthorizationDialog, type AuthorizationDialogProps } from '../src/client/AuthorizationDialog.tsx'
import { createModelsOperations } from '../src/client/operations.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
})

const t = (key: keyof typeof en): string => en[key]
/** The record the ChatGPT subscription's flow writes, and a record that is not it. */
const KEY = 'llm-pi-ai/openai-codex' as CredentialKey
const OTHER_KEY = 'llm-pi-ai/other' as CredentialKey
const PROMPT_ID = 'prompt-1' as AuthorizationPromptId
const URL = 'https://example.test/approve'
const CODE = '421-337'
const TITLE = en.signInTitle.replace('{provider}', 'ChatGPT')

/** The flow the page's view lists for {@link KEY}. */
function flowOf(methods: AuthorizationFlowView['methods'] = [{ id: 'oauth', label: 'ChatGPT' }]): AuthorizationFlowView {
  return { key: KEY, label: 'ChatGPT', methods, inFlight: false, configured: false, writable: true }
}

/** One attempt of that flow, running unless the case says otherwise. */
function attemptOf(overrides: Partial<AuthorizationAttemptView> = {}): AuthorizationAttemptView {
  return { key: KEY, method: 'oauth', phase: 'running', ...overrides }
}

/** A view holding the flow and one attempt, as the page's snapshot reports it. */
function viewOf(
  attempt: AuthorizationAttemptView | null,
  methods?: AuthorizationFlowView['methods'],
): AuthorizationView {
  return { flows: [flowOf(methods)], attempt }
}

/** The one view every mount starts from: the flow listed, nothing running. */
const UNSIGNED: AuthorizationView = viewOf(null)

/** One command's answer over the Remote carrier, which has no envelope. */
type Answer =
  | { readonly ok: true; readonly value: AuthorizationView }
  | { readonly ok: false; readonly error: RemoteError }

/**
 * The dialog's props over one scripted sign-in Remote, with every callback
 * recorded: the dialog is driven entirely by the view it is handed, as the page
 * hands it a fresh one after each merge.
 * @param options - the view the page holds and what every command answers with.
 * @returns the props, the recorded namespace, and the recorded callbacks.
 */
function dialogProps(options: { view?: AuthorizationView | null; answer?: Answer } = {}) {
  const answer = options.answer ?? { ok: true as const, value: UNSIGNED }
  const authorization = {
    start: vi.fn((_key: CredentialKey, _method?: string) => Promise.resolve(answer)),
    answer: vi.fn((_promptId: AuthorizationPromptId, _value: string) => Promise.resolve(answer)),
    decline: vi.fn((_promptId: AuthorizationPromptId) => Promise.resolve(answer)),
    cancel: vi.fn(() => Promise.resolve(answer)),
    signOut: vi.fn((_key: CredentialKey) => Promise.resolve(answer)),
  }
  const onClose = vi.fn()
  const onView = vi.fn()
  // A fixed stub: cases exercising the revision guard itself wire a real
  // store instead (see realStoreProps below).
  const authorizationRevision = vi.fn(() => 0)
  const props: AuthorizationDialogProps = {
    displayName: 'ChatGPT',
    authorizationKey: KEY,
    view: options.view === undefined ? UNSIGNED : options.view,
    operations: createModelsOperations({ remote: { authorization } } as never),
    t,
    onClose,
    authorizationRevision,
    onView,
  }
  return { props, authorization, onClose, authorizationRevision, onView }
}

/** Install one clipboard over the jsdom navigator, as the account dialog's spec does. */
function clipboardWith(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

/** A view whose attempt reports a notice. */
function noticeView(notice: { message: string; url?: string; code?: string }): AuthorizationView {
  return viewOf(attemptOf({ notice }))
}

/** A view whose attempt is waiting on one prompt. */
function promptView(prompt: AuthorizationPromptView): AuthorizationView {
  return viewOf(attemptOf({ phase: 'prompting', prompt }))
}

it('starts a single-method flow as it opens and answers the page with the view', async () => {
  const { props, authorization, onView } = dialogProps()

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByRole('dialog', { name: TITLE })).toBeTruthy()
  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
  await act(async () => {})
  // The second argument is the revision `settle` read before issuing the
  // command (see the store's `mergeCommandView` guard).
  expect(onView).toHaveBeenCalledExactlyOnceWith(UNSIGNED, 0)
})

it('offers the methods of a multi-method flow and starts the chosen one', async () => {
  const { props, authorization } = dialogProps({
    view: viewOf(null, [{ id: 'oauth', label: 'ChatGPT subscription' }, { id: 'api-key', label: 'API key' }]),
  })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByText(en.signInMethod)).toBeTruthy()
  expect(authorization.start).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'API key' })) })

  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, 'api-key')
  expect(screen.queryByText(en.signInMethod)).toBeNull()
})

it('renders a running attempt of a multi-method flow instead of the method list', async () => {
  // An attempt the page already holds owns the dialog: the choice it was
  // started from is settled, so the method list has nothing left to ask.
  const { props, authorization } = dialogProps({
    view: viewOf(attemptOf(), [{ id: 'oauth', label: 'ChatGPT subscription' }, { id: 'api-key', label: 'API key' }]),
  })

  render(<AuthorizationDialog {...props} />)

  expect(screen.queryByText(en.signInMethod)).toBeNull()
  expect(screen.getByText(en.signInWaiting)).toBeTruthy()
  await act(async () => {})
  expect(authorization.start).not.toHaveBeenCalled()
})

it('starts one attempt per dialog, even as the page hands back fresh views', async () => {
  const { props, authorization } = dialogProps({ view: viewOf(null) })

  const { rerender } = render(<AuthorizationDialog {...props} />)

  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)

  // A reload or a merged frame hands the dialog an equivalent view of its own
  // flow: the effect re-runs on that new object, and the attempt slot holds.
  rerender(<AuthorizationDialog {...props} view={viewOf(null)} />)
  await act(async () => {})

  expect(authorization.start).toHaveBeenCalledOnce()
})

it('waits for the page view before starting, then starts the flow it names', async () => {
  const { props, authorization } = dialogProps({ view: null })

  const { rerender } = render(<AuthorizationDialog {...props} />)

  // The read may still be arriving, so the dialog cannot know the flow yet:
  // starting now would ask the Host for a key the page never confirmed.
  expect(screen.getByText(en.signInWaiting)).toBeTruthy()
  await act(async () => {})
  expect(authorization.start).not.toHaveBeenCalled()

  rerender(<AuthorizationDialog {...props} view={UNSIGNED} />)

  await act(async () => {})
  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
})

it('offers the choice when a multi-method flow arrives after the dialog opened', async () => {
  const { props, authorization } = dialogProps({ view: null })
  const multi = viewOf(null, [{ id: 'oauth', label: 'ChatGPT subscription' }, { id: 'api-key', label: 'API key' }])

  const { rerender } = render(<AuthorizationDialog {...props} />)

  expect(screen.getByText(en.signInWaiting)).toBeTruthy()
  rerender(<AuthorizationDialog {...props} view={multi} />)

  await act(async () => {})
  expect(screen.getByText(en.signInMethod)).toBeTruthy()
  expect(authorization.start).not.toHaveBeenCalled()

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'API key' })) })

  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, 'api-key')
})

it('ignores the flow and the attempt of another record', async () => {
  const other: AuthorizationView = {
    flows: [{ ...flowOf(), key: OTHER_KEY }],
    attempt: attemptOf({
      key: OTHER_KEY,
      phase: 'prompting',
      prompt: { id: PROMPT_ID, kind: 'text', message: 'The other record needs a code' },
    }),
  }
  const { props, authorization } = dialogProps({ view: other })

  const { rerender } = render(<AuthorizationDialog {...props} />)

  expect(screen.queryByText('The other record needs a code')).toBeNull()
  expect(screen.getByText(en.signInWaiting)).toBeTruthy()
  await act(async () => {})
  expect(authorization.start).not.toHaveBeenCalled()

  rerender(<AuthorizationDialog {...props} view={{ ...other, flows: [...other.flows, flowOf()] }} />)

  await act(async () => {})
  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
})

it('renders the flow notice verbatim', () => {
  const { props } = dialogProps({ view: noticeView({ message: 'Approve the request in your browser' }) })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByText('Approve the request in your browser')).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.openPage })).toBeNull()
  expect(screen.queryByRole('button', { name: en.copyLink })).toBeNull()
})

it('opens the notice page the way both surfaces expect', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const { props } = dialogProps({ view: noticeView({ message: 'Open this page', url: URL }) })

  render(<AuthorizationDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.openPage }))

  expect(open).toHaveBeenCalledExactlyOnceWith(URL, '_blank', 'noopener,noreferrer')
})

it('copies the notice link and reports the copy on the button that offered it', async () => {
  const writeText = vi.fn(() => Promise.resolve())
  clipboardWith(writeText)
  const { props } = dialogProps({ view: noticeView({ message: 'Open this page', url: URL, code: CODE }) })

  render(<AuthorizationDialog {...props} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.copyLink })) })

  expect(writeText).toHaveBeenCalledExactlyOnceWith(URL)
  expect(screen.getByRole('button', { name: en.copied })).toBeTruthy()
  // The code's own action keeps its label: one feedback slot per copy button.
  expect(screen.getByRole('button', { name: en.copyCode })).toBeTruthy()
})

it('shows the notice code and copies it, keeping it selectable whole', async () => {
  const writeText = vi.fn(() => Promise.resolve())
  clipboardWith(writeText)
  const { props } = dialogProps({ view: noticeView({ message: 'Enter this code', code: CODE }) })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByText(CODE)).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.copyCode })) })

  expect(writeText).toHaveBeenCalledExactlyOnceWith(CODE)
  expect(screen.getByRole('button', { name: en.copied })).toBeTruthy()
})

it('reports a refused clipboard write', async () => {
  clipboardWith(() => Promise.reject(new Error('the clipboard is blocked')))
  const { props } = dialogProps({ view: noticeView({ message: 'Open this page', url: URL }) })

  render(<AuthorizationDialog {...props} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.copyLink })) })

  expect(screen.getByRole('button', { name: en.copyFailed })).toBeTruthy()
})

it('returns a copy button to its action label once the feedback lapses', async () => {
  vi.useFakeTimers()
  try {
    clipboardWith(() => Promise.resolve())
    const { props } = dialogProps({ view: noticeView({ message: 'Open this page', url: URL }) })
    render(<AuthorizationDialog {...props} />)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.copyLink })) })
    expect(screen.getByRole('button', { name: en.copied })).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByRole('button', { name: en.copyLink })).toBeTruthy()
  } finally {
    vi.useRealTimers()
  }
})

it('shows the waiting line and withdraws the attempt on cancel', async () => {
  const { props, authorization, onClose } = dialogProps({ view: viewOf(attemptOf({ phase: 'running' })) })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByText(en.signInWaiting)).toBeTruthy()
  // The page already holds an attempt for this record: the dialog renders it.
  expect(authorization.start).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.cancel })) })

  expect(authorization.cancel).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})

it('withdraws the attempt when the dialog is closed mid-prompt', async () => {
  const { props, authorization, onClose } = dialogProps({
    view: promptView({ id: PROMPT_ID, kind: 'text', message: 'Paste the code' }),
  })

  render(<AuthorizationDialog {...props} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.close })) })

  expect(authorization.cancel).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})

it('closes without cancelling while nothing has been started', async () => {
  // A multi-method flow with no choice made yet: the start effect has nothing
  // to do, so this is the one case where the dialog has genuinely issued
  // nothing for the Host to withdraw.
  const { props, authorization, onClose } = dialogProps({
    view: viewOf(null, [{ id: 'oauth', label: 'ChatGPT subscription' }, { id: 'api-key', label: 'API key' }]),
  })

  render(<AuthorizationDialog {...props} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.cancel })) })

  expect(onClose).toHaveBeenCalledOnce()
  expect(authorization.cancel).not.toHaveBeenCalled()
})

// Bug: a fresh dialog restarting over a stale terminal attempt (or any other
// start) has issued `start` before the view shows anything active — the
// dialog's own `attempt` reads undefined until the first accepted frame or
// answer. Cancelling in that window used to skip `cancelAuthorization`
// entirely (only `active` gated it), leaving the Host's attempt parked with
// nothing to ever withdraw it (pi-ai's select prompt has no timeout), so
// every later sign-in was refused `already-in-flight`.
it('withdraws a just-issued start on cancel, before any frame or answer arrives', async () => {
  const { props, authorization, onClose } = dialogProps({ view: viewOf(attemptOf({ phase: 'cancelled' })) })

  render(<AuthorizationDialog {...props} />)
  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)

  // Cancel fires immediately: the start answer has not landed, so `attempt`
  // (and therefore `active`) still reads as if nothing were running.
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))

  expect(authorization.cancel).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
  await act(async () => {})
})

it('closes once an attempt this dialog started reaches authorized', async () => {
  const { props, authorization, onClose } = dialogProps({ view: viewOf(null) })
  const { rerender } = render(<AuthorizationDialog {...props} />)
  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
  await act(async () => {})

  // The Host's answer develops through an active phase before authorized, the
  // way a real attempt this dialog started always does.
  rerender(<AuthorizationDialog {...props} view={viewOf(attemptOf({ phase: 'running' }))} />)
  rerender(<AuthorizationDialog {...props} view={viewOf(attemptOf({ phase: 'authorized' }))} />)

  expect(onClose).toHaveBeenCalledOnce()
})

// The Host keeps a finished attempt in its view until a new start, so a fresh
// dialog instance opening onto one it never started (never seen active) is a
// previous instance's leftover, not a cue of its own: it starts over instead
// of adopting it.
it('leaves a stale authorized attempt from another dialog alone instead of auto-closing', async () => {
  const { props, authorization, onClose } = dialogProps({ view: viewOf(attemptOf({ phase: 'authorized' })) })

  render(<AuthorizationDialog {...props} />)

  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => {})
})

// The command that starts a fresh attempt does not itself change `view` — the
// Host's leftover terminal attempt stays there until a new view arrives — so
// this guards against adopting it just because this dialog has since issued
// its own start (a re-render for any other reason before the fresh view
// lands must not flash the leftover outcome back in).
it('does not adopt a stale authorized attempt just because this dialog has since issued its own start', async () => {
  const { props, authorization, onClose } = dialogProps({ view: viewOf(attemptOf({ phase: 'authorized' })) })
  const { rerender } = render(<AuthorizationDialog {...props} />)
  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
  expect(onClose).not.toHaveBeenCalled()

  rerender(<AuthorizationDialog {...props} view={viewOf(attemptOf({ phase: 'authorized' }))} />)

  expect(onClose).not.toHaveBeenCalled()
  expect(authorization.start).toHaveBeenCalledOnce()
  await act(async () => {})
})

it('keeps showing "cancelled" for an attempt this dialog itself ran, without restarting', async () => {
  const { props, authorization } = dialogProps({ view: viewOf(null) })
  const { rerender } = render(<AuthorizationDialog {...props} />)
  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
  await act(async () => {})

  rerender(<AuthorizationDialog {...props} view={viewOf(attemptOf({ phase: 'running' }))} />)
  rerender(<AuthorizationDialog {...props} view={viewOf(attemptOf({ phase: 'cancelled' }))} />)

  expect(screen.getByText(en.signInCancelled)).toBeTruthy()
  expect(authorization.start).toHaveBeenCalledOnce()
})

it('discards a stale cancelled attempt from another dialog and starts fresh', async () => {
  const { props, authorization } = dialogProps({ view: viewOf(attemptOf({ phase: 'cancelled' })) })

  render(<AuthorizationDialog {...props} />)

  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
  expect(screen.queryByText(en.signInCancelled)).toBeNull()
  await act(async () => {})
})

it('does not flash a stale cancelled line back in once this dialog has issued its own start', async () => {
  const { props, authorization } = dialogProps({ view: viewOf(attemptOf({ phase: 'cancelled' })) })
  const { rerender } = render(<AuthorizationDialog {...props} />)
  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
  expect(screen.queryByText(en.signInCancelled)).toBeNull()

  rerender(<AuthorizationDialog {...props} view={viewOf(attemptOf({ phase: 'cancelled' }))} />)

  expect(screen.queryByText(en.signInCancelled)).toBeNull()
  expect(authorization.start).toHaveBeenCalledOnce()
  await act(async () => {})
})

it('keeps showing the localized failure line for an attempt this dialog itself ran', async () => {
  const { props, authorization } = dialogProps({ view: viewOf(null) })
  const { rerender } = render(<AuthorizationDialog {...props} />)
  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
  await act(async () => {})

  rerender(<AuthorizationDialog {...props} view={viewOf(attemptOf({ phase: 'running' }))} />)
  rerender(<AuthorizationDialog {...props} view={viewOf(attemptOf({ phase: 'failed', failure: 'authorization/not-committed' }))} />)

  expect(screen.getByText(en.signInFailed)).toBeTruthy()
  expect(screen.queryByText('authorization/not-committed')).toBeNull()
  expect(authorization.start).toHaveBeenCalledOnce()
})

it('discards a stale failed attempt from another dialog and starts fresh', async () => {
  const { props, authorization } = dialogProps({
    view: viewOf(attemptOf({ phase: 'failed', failure: 'authorization/not-committed' })),
  })

  render(<AuthorizationDialog {...props} />)

  expect(authorization.start).toHaveBeenCalledExactlyOnceWith(KEY, undefined)
  expect(screen.queryByText(en.signInFailed)).toBeNull()
  await act(async () => {})
})

it('renders an active prompting attempt from another dialog instead of restarting', async () => {
  const { props, authorization } = dialogProps({
    view: promptView({
      id: PROMPT_ID,
      kind: 'select',
      message: 'Which account?',
      options: [{ id: 'work', label: 'Work' }],
    }),
  })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByText('Which account?')).toBeTruthy()
  await act(async () => {})
  expect(authorization.start).not.toHaveBeenCalled()
})

// This dialog never started the attempt (mounted onto it already running), so
// its terminal outcome is only trustworthy because this dialog saw it active
// first — the other latch (an accepted answer to this dialog's own command)
// never fires here.
it('keeps showing the outcome of an attempt only ever observed active, without restarting', async () => {
  const { props, authorization } = dialogProps({ view: viewOf(attemptOf({ phase: 'running' })) })
  const { rerender } = render(<AuthorizationDialog {...props} />)
  expect(authorization.start).not.toHaveBeenCalled()

  rerender(<AuthorizationDialog {...props} view={viewOf(attemptOf({ phase: 'cancelled' }))} />)

  expect(screen.getByText(en.signInCancelled)).toBeTruthy()
  expect(authorization.start).not.toHaveBeenCalled()
})

/**
 * The dialog's props wired to a real {@link ModelsSettingsStore}:
 * `authorizationRevision` and `onView` route through its `mergeCommandView`
 * guard, exactly as `ModelsSection` wires the shipped dialog — so a bug in
 * that wiring (e.g. dropping the `authorizationRevision` read) shows up here
 * the same way it would for the row's real dialog.
 * @param view - the store's initial authorization view.
 * @param authorization - the scripted `remote.authorization` commands.
 * @returns the store the props are wired to, and the props themselves.
 */
function realStoreProps(
  view: AuthorizationView,
  authorization: {
    start: ReturnType<typeof vi.fn>
    answer: ReturnType<typeof vi.fn>
    decline: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    signOut: ReturnType<typeof vi.fn>
  },
) {
  const store = new ModelsSettingsStore({} as never, {} as never, {} as never)
  store.mergeAuthorization(view)
  const props: AuthorizationDialogProps = {
    displayName: 'ChatGPT',
    authorizationKey: KEY,
    view: store.store.getSnapshot().authorization,
    operations: createModelsOperations({ remote: { authorization } } as never),
    t,
    onClose: vi.fn(),
    authorizationRevision: () => store.authorizationRevision(),
    onView: (nextView, issuedAt) => { store.mergeCommandView(nextView, issuedAt) },
  }
  return { store, props }
}

it('drops a stale answer to a prompt once a newer live frame has landed', async () => {
  const pending = Promise.withResolvers<Answer>()
  const authorization = {
    start: vi.fn(), decline: vi.fn(), cancel: vi.fn(), signOut: vi.fn(),
    answer: vi.fn(() => pending.promise),
  }
  const options = [{ id: 'browser', label: 'Browser login' }]
  const { store, props } = realStoreProps(
    promptView({ id: PROMPT_ID, kind: 'select', message: 'Which login?', options }),
    authorization,
  )

  render(<AuthorizationDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: /^Browser login/ }))
  expect(authorization.answer).toHaveBeenCalledExactlyOnceWith(PROMPT_ID, 'browser')

  // A live frame lands while the answer is still in flight.
  const runningView = viewOf(attemptOf({ phase: 'running' }))
  await act(async () => { store.mergeAuthorization(runningView) })

  // The late answer (an older, unrelated outcome) must not overwrite it.
  await act(async () => {
    pending.resolve({ ok: true, value: viewOf(attemptOf({ phase: 'cancelled' })) })
    await pending.promise
  })

  expect(store.store.getSnapshot().authorization).toEqual(runningView)
})

it('drops a stale decline answer once a newer live frame has landed', async () => {
  const pending = Promise.withResolvers<Answer>()
  const authorization = {
    start: vi.fn(), answer: vi.fn(), cancel: vi.fn(), signOut: vi.fn(),
    decline: vi.fn(() => pending.promise),
  }
  const { store, props } = realStoreProps(
    promptView({ id: PROMPT_ID, kind: 'text', message: 'Paste the code' }),
    authorization,
  )

  render(<AuthorizationDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.decline }))
  expect(authorization.decline).toHaveBeenCalledExactlyOnceWith(PROMPT_ID)

  const runningView = viewOf(attemptOf({ phase: 'running' }))
  await act(async () => { store.mergeAuthorization(runningView) })

  await act(async () => {
    pending.resolve({ ok: true, value: viewOf(attemptOf({ phase: 'cancelled' })) })
    await pending.promise
  })

  expect(store.store.getSnapshot().authorization).toEqual(runningView)
})

it('drops a stale cancel answer once a newer live frame has landed', async () => {
  const pending = Promise.withResolvers<Answer>()
  const authorization = {
    start: vi.fn(), answer: vi.fn(), decline: vi.fn(), signOut: vi.fn(),
    cancel: vi.fn(() => pending.promise),
  }
  const { store, props } = realStoreProps(viewOf(attemptOf({ phase: 'running' })), authorization)

  render(<AuthorizationDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(authorization.cancel).toHaveBeenCalledOnce()

  const promptingView = promptView({ id: PROMPT_ID, kind: 'text', message: 'Paste the code' })
  await act(async () => { store.mergeAuthorization(promptingView) })

  // The late cancel answer (reporting unsigned) must not overwrite it.
  await act(async () => {
    pending.resolve({ ok: true, value: viewOf(null) })
    await pending.promise
  })

  expect(store.store.getSnapshot().authorization).toEqual(promptingView)
})

// The three "drops a stale ... answer" cases above only prove a late answer
// gets dropped once something else moved the revision; on their own they
// would not catch `authorizationRevision` being replaced by an arbitrary
// constant that happens to differ from the post-interference revision too.
// These pair with them: absent any interference, the command's own answer
// must still apply — which only holds if the revision `settle` reads back
// really is the one the store held at the moment the command was issued.

it('applies its own answer to a prompt when no live frame intervened', async () => {
  const expected = viewOf(attemptOf({ phase: 'cancelled' }))
  const authorization = {
    start: vi.fn(), decline: vi.fn(), cancel: vi.fn(), signOut: vi.fn(),
    answer: vi.fn(() => Promise.resolve<Answer>({ ok: true, value: expected })),
  }
  const { store, props } = realStoreProps(
    promptView({ id: PROMPT_ID, kind: 'select', message: 'Which login?', options: [{ id: 'browser', label: 'Browser login' }] }),
    authorization,
  )

  render(<AuthorizationDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: /^Browser login/ }))

  await waitFor(() => { expect(store.store.getSnapshot().authorization).toEqual(expected) })
})

it('applies its own decline answer when no live frame intervened', async () => {
  const expected = viewOf(attemptOf({ phase: 'cancelled' }))
  const authorization = {
    start: vi.fn(), answer: vi.fn(), cancel: vi.fn(), signOut: vi.fn(),
    decline: vi.fn(() => Promise.resolve<Answer>({ ok: true, value: expected })),
  }
  const { store, props } = realStoreProps(promptView({ id: PROMPT_ID, kind: 'text', message: 'Paste the code' }), authorization)

  render(<AuthorizationDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.decline }))

  await waitFor(() => { expect(store.store.getSnapshot().authorization).toEqual(expected) })
})

it('applies its own cancel answer when no live frame intervened', async () => {
  const expected = viewOf(null)
  const authorization = {
    start: vi.fn(), answer: vi.fn(), decline: vi.fn(), signOut: vi.fn(),
    cancel: vi.fn(() => Promise.resolve<Answer>({ ok: true, value: expected })),
  }
  const { store, props } = realStoreProps(viewOf(attemptOf({ phase: 'running' })), authorization)

  render(<AuthorizationDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))

  await waitFor(() => { expect(store.store.getSnapshot().authorization).toEqual(expected) })
})

it('says a sign-in is already running when the start is refused that way', async () => {
  const { props } = dialogProps({
    answer: { ok: false, error: new RemoteError('authorization/already-in-flight', 'one attempt at a time', { key: KEY }) },
  })

  render(<AuthorizationDialog {...props} />)
  await act(async () => {})

  expect(screen.getByText(en.signInRunning)).toBeTruthy()
})

it('reads every other refusal as a failed sign-in', async () => {
  const { props } = dialogProps({
    answer: { ok: false, error: new RemoteError('authorization/no-flow', 'no flow is registered', { key: KEY }) },
  })

  render(<AuthorizationDialog {...props} />)
  await act(async () => {})

  expect(screen.getByText(en.signInFailed)).toBeTruthy()
  expect(screen.queryByText('no flow is registered')).toBeNull()
})

it('reads a dropped call as a failed sign-in', async () => {
  const { props, authorization } = dialogProps()
  authorization.start.mockImplementation(() => Promise.reject(new Error('the bridge dropped the call')))

  render(<AuthorizationDialog {...props} />)
  await act(async () => {})

  expect(screen.getByText(en.signInFailed)).toBeTruthy()
})

it('submits the typed answer to the text prompt and clears the field', async () => {
  const { props, authorization } = dialogProps({
    view: promptView({ id: PROMPT_ID, kind: 'text', message: 'Paste the code', placeholder: '123-456' }),
  })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByText('Paste the code')).toBeTruthy()
  const input = screen.getByPlaceholderText<HTMLInputElement>('123-456')
  expect(input.type).toBe('text')
  fireEvent.change(input, { target: { value: CODE } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.submit })) })

  expect(authorization.answer).toHaveBeenCalledExactlyOnceWith(PROMPT_ID, CODE)
  expect(screen.getByPlaceholderText<HTMLInputElement>('123-456').value).toBe('')
})

it('masks a secret prompt', () => {
  const { props } = dialogProps({
    view: promptView({ id: PROMPT_ID, kind: 'secret', message: 'Paste the token' }),
  })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByLabelText<HTMLInputElement>('Paste the token').type).toBe('password')
})

it('answers a select prompt with the chosen option id', async () => {
  const { props, authorization } = dialogProps({
    view: promptView({
      id: PROMPT_ID,
      kind: 'select',
      message: 'Which account?',
      options: [
        { id: 'work', label: 'Work', description: 'the team plan' },
        { id: 'personal', label: 'Personal' },
      ],
    }),
  })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByText('the team plan')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Work/ })) })

  expect(authorization.answer).toHaveBeenCalledExactlyOnceWith(PROMPT_ID, 'work')
})

it('declines a select prompt whose flow offered no choices', async () => {
  const { props, authorization } = dialogProps({
    view: promptView({ id: PROMPT_ID, kind: 'select', message: 'Which account?' }),
  })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByText('Which account?')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.decline })) })

  expect(authorization.decline).toHaveBeenCalledExactlyOnceWith(PROMPT_ID)
})

it('stops rendering a prompt the flow withdrew', () => {
  const { props } = dialogProps({ view: promptView({ id: PROMPT_ID, kind: 'text', message: 'Paste the code' }) })

  const { rerender } = render(<AuthorizationDialog {...props} />)
  expect(screen.getByLabelText('Paste the code')).toBeTruthy()

  rerender(<AuthorizationDialog {...props} view={viewOf(attemptOf({ phase: 'running' }))} />)

  expect(screen.queryByLabelText('Paste the code')).toBeNull()
  expect(screen.getByText(en.signInWaiting)).toBeTruthy()
})
