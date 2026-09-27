/**
 * Agent Team start strip docked above the composer of a blank Lead
 * conversation: one subject field whose submission starts the Team through the
 * Host `/team` command. It renders nothing once the conversation has begun.
 */

import { useRef, useState, type FormEvent } from 'react'
import { Button, IconUsersOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NS } from './locales.ts'
import css from './TeamSubjectSeat.module.css'

/** Outcome of one start request, mapped from the Host command execution. */
export type TeamStartResult =
  | { readonly kind: 'started' }
  /** The Host refused the start or the request failed; `text` is the Host's message. */
  | { readonly kind: 'refused'; readonly text: string }
  /** The composition registers no `/team` command. */
  | { readonly kind: 'unavailable' }

/** Business action injected by the browser plugin for one conversation. */
export interface TeamSubjectInjected {
  /** Start the Team of this conversation on one trimmed subject. */
  startTeam: (subject: string) => Promise<TeamStartResult>
}

/** Full props of the dock entry. */
export type TeamSubjectSeatProps =
  PropsRuntime<'conversation.input.dock'> & InjectFace<TeamSubjectInjected> & PropsLocale<typeof NS>

/**
 * Render the subject strip while the Lead conversation is still blank.
 * @param props - composed slot props.
 * @returns The strip, or null outside the main view, in a teammate
 * conversation, after any prompt, or once the Team started.
 */
export function TeamSubjectSeat({ session, useSessionRetainInfo, startTeam, t }: TeamSubjectSeatProps) {
  const main = useSessionRetainInfo(info => (info?.retainedBy.mainView ?? 0) > 0)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // React state disables the controls on the next render; the ref closes the
  // same-render window so a double submit cannot start the Team twice.
  const pendingRef = useRef(false)

  if (!main || !session.blank || session.subagent !== null || session.promptAttempted || started) return null

  const subject = draft.trim()
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (subject === '' || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    const result = await startTeam(subject)
    pendingRef.current = false
    setPending(false)
    switch (result.kind) {
      case 'started':
        setStarted(true)
        return
      case 'refused':
        setError(result.text)
        return
      case 'unavailable':
        setError(t('subject.unavailable'))
        return
      /* v8 ignore next 2 -- TeamStartResult is closed and every member is handled above. */
      default:
        assertNever(result)
    }
  }

  return (
    <div className={css.dock} data-team-subject>
      <form className={css.bar} onSubmit={(event) => { void submit(event) }}>
        <span className={css.glyph}><IconUsersOutlineRegular size={14} /></span>
        <span className={css.label}>{t('trigger')}</span>
        <Input
          className={css.field as string}
          value={draft}
          maxLength={200}
          disabled={pending}
          placeholder={t('subject.placeholder')}
          aria-label={t('subject.field')}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        {error !== null && <span className={css.error} role="alert" title={error}>{error}</span>}
        <Button type="submit" variant="primary" size="sm" disabled={pending || subject === ''}>
          {t('subject.start')}
        </Button>
      </form>
    </div>
  )
}
