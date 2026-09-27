// @vitest-environment jsdom
/** Sign-in dialog: method choice, notice link and code, prompts, and phase outcomes. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  const props: AuthorizationDialogProps = {
    displayName: 'ChatGPT',
    authorizationKey: KEY,
    view: options.view === undefined ? UNSIGNED : options.view,
    operations: createModelsOperations({ remote: { authorization } } as never),
    t,
    onClose,
    onView,
  }
  return { props, authorization, onClose, onView }
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
  expect(onView).toHaveBeenCalledExactlyOnceWith(UNSIGNED)
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

it('closes without cancelling while no attempt is running', async () => {
  const { props, authorization, onClose } = dialogProps()

  render(<AuthorizationDialog {...props} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.cancel })) })

  expect(onClose).toHaveBeenCalledOnce()
  expect(authorization.cancel).not.toHaveBeenCalled()
})

it('closes once the attempt is authorized', () => {
  const { props, onClose } = dialogProps({ view: viewOf(attemptOf({ phase: 'authorized' })) })

  render(<AuthorizationDialog {...props} />)

  expect(onClose).toHaveBeenCalledOnce()
})

it('says a withdrawn sign-in was cancelled', () => {
  const { props } = dialogProps({ view: viewOf(attemptOf({ phase: 'cancelled' })) })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByText(en.signInCancelled)).toBeTruthy()
})

it('shows the localized failure line instead of the flow code', () => {
  const { props } = dialogProps({
    view: viewOf(attemptOf({ phase: 'failed', failure: 'authorization/not-committed' })),
  })

  render(<AuthorizationDialog {...props} />)

  expect(screen.getByText(en.signInFailed)).toBeTruthy()
  expect(screen.queryByText('authorization/not-committed')).toBeNull()
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
