/**
 * Sign-in dialog for one subscription route's authorization flow. It offers the
 * methods the flow registers, renders the attempt the page's latest view
 * reports — the flow's own notice text, the page or code the human carries to
 * the browser, and the prompt blocking the attempt — and hands every command's
 * answer back to the page snapshot, which is what flips the row behind it.
 * Everything the flow supplies (notice message, method and option labels,
 * prompt message and placeholder) is wire data and renders verbatim; only the
 * dialog's own chrome is localized.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AuthorizationAttemptView,
  AuthorizationFlowView,
  AuthorizationPromptId,
  AuthorizationView,
} from '@deepseek-ai/dsh-api-authorization-controller/types'
import type { AuthorizationOutcome, ModelsOperations } from './operations.ts'
import type { ProviderAuthorization } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** How long a copy button reports its outcome before returning to its action label. */
const COPY_FEEDBACK_MS = 2000

/** The line each attempt phase shows while no prompt is blocking it. */
const PHASE_LINES: Partial<Record<AuthorizationAttemptView['phase'], keyof typeof en>> = {
  starting: 'signInWaiting',
  running: 'signInWaiting',
  cancelled: 'signInCancelled',
  failed: 'signInFailed',
}

/** The phases in which an attempt is still going, so leaving the dialog withdraws it. */
const ACTIVE_PHASES: readonly AuthorizationAttemptView['phase'][] = ['starting', 'running', 'prompting']

/** The copy action a feedback label belongs to. */
type CopyTarget = 'link' | 'code'

/**
 * The flow one record's dialog drives, as the page's latest view lists it.
 * @param view - the page's sign-in view, or null while that read fails.
 * @param key - the credential record the row declares.
 * @returns the flow view, or undefined while no view lists the key.
 */
function flowOf(view: AuthorizationView | null, key: ProviderAuthorization['key']): AuthorizationFlowView | undefined {
  if (view === null) return undefined
  return view.flows.find(flow => flow.key === key)
}

/**
 * The attempt this dialog renders. The controller owns one attempt at a time,
 * so a dialog shows it only while it belongs to the record that dialog drives:
 * another row's running sign-in is that row's business.
 * @param view - the page's sign-in view, or null while that read fails.
 * @param key - the credential record the row declares.
 * @returns the attempt to render, or undefined when it belongs to another record.
 */
function attemptOf(view: AuthorizationView | null, key: ProviderAuthorization['key']): AuthorizationAttemptView | undefined {
  if (view === null) return undefined
  const attempt = view.attempt
  if (attempt === null) return undefined
  return attempt.key === key ? attempt : undefined
}

/** Props of {@link AuthorizationDialog}. */
export interface AuthorizationDialogProps {
  /** The provider as its row names it: the title reads `Sign in to <displayName>`. */
  displayName: string
  /** The credential record the row's declaration names. */
  authorizationKey: ProviderAuthorization['key']
  /** The page's latest authorization view, or null while that read fails. */
  view: AuthorizationView | null
  /** The Host commands this dialog invokes. */
  operations: ModelsOperations
  /** Dialog copy. */
  t: (key: keyof typeof en) => string
  /** Dismiss the dialog; the caller owns whether it is rendered. */
  onClose: () => void
  /**
   * The page's live-publication revision as of now. `settle` reads this right
   * before issuing a command, so a late answer can be told apart from one a
   * live frame has already overtaken.
   */
  authorizationRevision: () => number
  /**
   * Take one command's answered view into the page snapshot, alongside the
   * revision `authorizationRevision` returned when that command was issued.
   */
  onView: (view: AuthorizationView, issuedAt: number) => void
}

/**
 * Render the sign-in dialog for one row's authorization flow.
 * @param props - the row's declaration, the page's view, and the dialog callbacks.
 * @returns the modal dialog.
 */
export function AuthorizationDialog(props: AuthorizationDialogProps): ReactNode {
  const { displayName, authorizationKey, view, operations, t, onClose, authorizationRevision, onView } = props
  const flow = flowOf(view, authorizationKey)
  const methods = flow === undefined ? [] : flow.methods
  const rawAttempt = attemptOf(view, authorizationKey)
  /**
   * Whether this dialog instance has ever seen this key's attempt in an
   * active phase (see {@link ACTIVE_PHASES}), latched as committed state, not
   * during render. `settle` also latches it on an accepted answer to one of
   * this dialog's own commands, so an attempt that reaches a terminal phase in
   * a single answer (no separate active-phase view ever arrives) is still
   * this dialog's own. Once latched, every later phase of the same attempt
   * (including its terminal outcome) keeps rendering, whether this dialog
   * issued the command that started it or only observed it while active.
   */
  const [sawActive, setSawActive] = useState(false)
  useEffect(() => {
    if (rawAttempt !== undefined && ACTIVE_PHASES.includes(rawAttempt.phase)) setSawActive(true)
  }, [rawAttempt])
  /**
   * An attempt neither active nor ever seen active by this dialog is stale:
   * a previous dialog instance's leftover outcome, not this one's business.
   */
  const stale = rawAttempt !== undefined && !sawActive && !ACTIVE_PHASES.includes(rawAttempt.phase)
  const attempt = stale ? undefined : rawAttempt
  const phase = attempt?.phase
  /** The method the user picked, or undefined for the flow's own default. */
  const [method, setMethod] = useState<string | undefined>(undefined)
  /** Whether the flow's method list is still the choice to make. */
  const choosing = methods.length > 1 && method === undefined && attempt === undefined
  /** The one line this dialog adds over the attempt's own phase. */
  const [refusal, setRefusal] = useState<'signInRunning' | 'signInFailed' | undefined>(undefined)
  const [answer, setAnswer] = useState('')
  /** Copy feedback one button holds: the target it reports for, and the dictionary key it renders. */
  const [copyResult, setCopyResult] = useState<{ target: CopyTarget; messageKey: 'copied' | 'copyFailed' } | undefined>(undefined)
  const started = useRef(false)

  /**
   * Settle one command: an answer replaces the page's view — which is what
   * flips the row and re-renders this dialog — while a refusal and a dropped
   * call both read as one of the two lines this dialog owns. The revision is
   * read right before `issue` runs, before any `await`, so a live frame that
   * lands while the command is in flight is never mistaken for one this
   * command's own answer may still overwrite.
   */
  const settle = (issue: () => Promise<AuthorizationOutcome>): void => {
    const issuedAt = authorizationRevision()
    void issue().then(
      (outcome) => {
        if (outcome.kind === 'refused') {
          setRefusal(outcome.code === 'authorization/already-in-flight' ? 'signInRunning' : 'signInFailed')
          return
        }
        setRefusal(undefined)
        setSawActive(true)
        onView(outcome.view, issuedAt)
      },
      () => { setRefusal('signInFailed') },
    )
  }

  // A flow offering one method (or none) has nothing to choose, so it starts as
  // soon as the page's view names it; a flow offering more starts once the user
  // picks. A view that does not name this record's flow yet has nothing to
  // start at all: the page's read may still be arriving, so the dialog waits
  // for it rather than asking the Host to start a key it registers no flow for.
  // An attempt the page already holds is this dialog's to render, never a
  // second one to start; the ref keeps a later re-render from claiming the
  // controller's single attempt slot twice. A stale attempt reads as absent
  // here, so a fresh dialog instance restarts instead of adopting it.
  useEffect(() => {
    if (flow === undefined || choosing || attempt !== undefined || started.current) return
    started.current = true
    settle(() => operations.startAuthorization(authorizationKey, method))
  }, [attempt, choosing, flow, method])

  // The row's own state is the answer: a committed attempt leaves the dialog.
  // A stale `authorized` attempt reads as absent above, so this only fires
  // for one this dialog has seen active or itself received an answer for.
  useEffect(() => {
    if (phase === 'authorized') onClose()
  }, [phase, onClose])

  useEffect(() => {
    if (copyResult === undefined) return
    const timer = setTimeout(() => { setCopyResult(undefined) }, COPY_FEEDBACK_MS)
    return () => { clearTimeout(timer) }
  }, [copyResult])

  const active = phase !== undefined && ACTIVE_PHASES.includes(phase)

  /**
   * Leave the dialog, withdrawing the attempt it started: nothing may keep
   * running behind a closed dialog, and the row follows whatever answer
   * lands. This dialog's own start can still be in flight with the view not
   * yet showing it active (a fresh instance restarting over a stale attempt,
   * for instance) — cancelling on `started` as well as `active` reaches that
   * window too; a cancel with nothing running is a Host no-op.
   */
  const dismiss = (): void => {
    if (active || started.current) settle(() => operations.cancelAuthorization())
    onClose()
  }

  /**
   * Write one wire string to the clipboard and report the outcome on the button
   * that offered it.
   */
  const copy = async (text: string, target: CopyTarget): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyResult({ target, messageKey: 'copied' })
    } catch {
      setCopyResult({ target, messageKey: 'copyFailed' })
    }
  }

  /** The label one copy button shows: its own feedback while it holds it, else its action. */
  const copyLabel = (target: CopyTarget, action: keyof typeof en): string =>
    copyResult?.target === target ? t(copyResult.messageKey) : t(action)

  /** Answer the prompt blocking the attempt, clearing the field for the next one. */
  const submit = (promptId: AuthorizationPromptId, value: string): void => {
    setAnswer('')
    settle(() => operations.answerAuthorization(promptId, value))
  }

  const notice = attempt?.notice
  const noticeUrl = notice?.url
  const noticeCode = notice?.code
  const prompt = attempt?.prompt
  const phaseLine = phase === undefined ? undefined : PHASE_LINES[phase]
  // A view that names no flow for this record has no phase to report, so the
  // dialog says it is waiting for the sign-in to become known rather than
  // rendering an empty body beside a start it cannot make.
  const statusLine = refusal ?? phaseLine ?? (flow === undefined ? 'signInWaiting' : undefined)

  return (
    <Modal
      open
      onClose={dismiss}
      title={t('signInTitle').replace('{provider}', () => displayName)}
      closeLabel={t('close')}
      className={styles['signInDialog'] as string}
      footer={<Button variant="outline" onClick={dismiss}>{t('cancel')}</Button>}
    >
      <div className={styles['signInBody']}>
        {choosing
          ? (
            <div className={styles['signInMethods']}>
              <p className={styles['signInHint']}>{t('signInMethod')}</p>
              {methods.map(candidate => (
                <Button
                  key={candidate.id}
                  variant="outline"
                  onClick={() => {
                    setMethod(candidate.id)
                  }}
                >
                  {candidate.label}
                </Button>
              ))}
            </div>
          )
          : null}
        {notice === undefined ? null : <p className={styles['signInNotice']}>{notice.message}</p>}
        {noticeUrl === undefined
          ? null
          : (
            <div className={styles['signInActions']}>
              <Button
                variant="outline"
                onClick={() => { window.open(noticeUrl, '_blank', 'noopener,noreferrer') }}
              >
                {t('openPage')}
              </Button>
              <Button variant="outline" onClick={() => { void copy(noticeUrl, 'link') }}>
                {copyLabel('link', 'copyLink')}
              </Button>
            </div>
          )}
        {noticeCode === undefined
          ? null
          : (
            <div className={styles['signInActions']}>
              <code className={styles['signInCode']}>{noticeCode}</code>
              <Button variant="outline" onClick={() => { void copy(noticeCode, 'code') }}>
                {copyLabel('code', 'copyCode')}
              </Button>
            </div>
          )}
        {prompt === undefined
          ? null
          : (
            <div className={styles['signInPrompt']}>
              <p className={styles['signInHint']}>{prompt.message}</p>
              {prompt.kind === 'select'
                ? (prompt.options ?? []).map(option => (
                  <Button
                    key={option.id}
                    variant="outline"
                    onClick={() => { submit(prompt.id, option.id) }}
                  >
                    {option.label}
                    {option.description === undefined
                      ? null
                      : <span className={styles['signInOption']}>{option.description}</span>}
                  </Button>
                ))
                : (
                  <div className={styles['signInActions']}>
                    <input
                      className={styles['input']}
                      type={prompt.kind === 'secret' ? 'password' : 'text'}
                      aria-label={prompt.message}
                      placeholder={prompt.placeholder}
                      value={answer}
                      data-modal-autofocus
                      onChange={(event) => { setAnswer(event.target.value) }}
                    />
                    <Button variant="outline" onClick={() => { submit(prompt.id, answer) }}>
                      {t('submit')}
                    </Button>
                  </div>
                )}
              <Button variant="ghost" onClick={() => { settle(() => operations.declineAuthorization(prompt.id)) }}>
                {t('decline')}
              </Button>
            </div>
          )}
        {statusLine === undefined ? null : <p className={styles['signInNotice']}>{t(statusLine)}</p>}
      </div>
    </Modal>
  )
}
