/**
 * Agent Team start strip docked above the composer of a blank Lead
 * conversation: an editable participant roster and a subject field, whose
 * submission starts the Team through the Host `/team` command. It renders
 * nothing once the conversation has begun.
 */

import { useRef, useState, type FormEvent } from 'react'
import {
  Button, IconCloseOutlineRegular, IconPlusOutlineRegular, IconUsersOutlineRegular, Input, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { TeamMemberProjection } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamSubjectSeat.module.css'

/**
 * Duty assignable to a Team participant from the strip, mirrored from the
 * roster projection's own optional `duty` field so the union cannot drift
 * from the one the panel already renders.
 */
export type RosterDuty = NonNullable<TeamMemberProjection['duty']>

/** Roster the strip offers on mount: one planner, two executors. */
const DEFAULT_ROSTER: readonly RosterDuty[] = ['planner', 'executor', 'executor']

/** Outcome of one start request, mapped from the Host command execution. */
export type TeamStartResult =
  | { readonly kind: 'started' }
  /** The Host refused the start or the request failed; `text` is the Host's message. */
  | { readonly kind: 'refused'; readonly text: string }
  /** The composition registers no `/team` command. */
  | { readonly kind: 'unavailable' }

/** Business action injected by the browser plugin for one conversation. */
export interface TeamSubjectInjected {
  /**
   * Start the Team of this conversation on one trimmed subject.
   * @param subject - trimmed Team subject.
   * @param members - roster duties in chip order, excluding the fixed Lead
   * chip; an empty roster starts a Team with no participant duties.
   */
  startTeam: (subject: string, members: readonly RosterDuty[]) => Promise<TeamStartResult>
}

/** Full props of the dock entry. */
export type TeamSubjectSeatProps =
  PropsRuntime<'conversation.input.dock'> & InjectFace<TeamSubjectInjected> & PropsLocale<typeof NS>

function dutyKey(duty: RosterDuty): TeamKey {
  switch (duty) {
    case 'planner': return 'duty.planner'
    case 'executor': return 'duty.executor'
    /* v8 ignore next -- RosterDuty is closed and every member is handled above. */
    default: return assertNever(duty)
  }
}

/**
 * One removable roster chip. Its accessible name states the duty and, for a
 * duty that can repeat, its 1-based position among same-duty chips, so two
 * executors keep distinct remove labels.
 */
function ParticipantChip({ duty, ordinal, onRemove, t }: {
  duty: RosterDuty
  ordinal: number | null
  onRemove: () => void
  t: TranslateNS<typeof NS>
}) {
  const label = ordinal === null ? t(dutyKey(duty)) : `${t(dutyKey(duty))} ${String(ordinal)}`
  const removeLabel = t('roster.remove', { name: label })
  return (
    <span className={css.chip}>
      <span className={css.chipLabel}>{label}</span>
      <Tooltip label={removeLabel} side="bottom" gap={4}>
        <button type="button" className={css.chipRemove} aria-label={removeLabel} onClick={onRemove}>
          <IconCloseOutlineRegular size={10} />
        </button>
      </Tooltip>
    </span>
  )
}

/**
 * Render the subject strip while the Lead conversation is still blank.
 * @param props - composed slot props.
 * @returns The strip, or null outside the main view, in a teammate
 * conversation, after any prompt, or once the Team started.
 */
export function TeamSubjectSeat({ session, useSessionRetainInfo, startTeam, t }: TeamSubjectSeatProps) {
  const main = useSessionRetainInfo(info => (info?.retainedBy.mainView ?? 0) > 0)
  const [draft, setDraft] = useState('')
  const [roster, setRoster] = useState<readonly RosterDuty[]>(DEFAULT_ROSTER)
  const [pending, setPending] = useState(false)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // React state disables the controls on the next render; the ref closes the
  // same-render window so a double submit cannot start the Team twice.
  const pendingRef = useRef(false)

  if (!main || !session.blank || session.subagent !== null || session.promptAttempted || started) return null

  const subject = draft.trim()
  const hasPlanner = roster.includes('planner')
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (subject === '' || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    const result = await startTeam(subject, roster)
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

  // The Add planner control disables itself once a planner exists (below),
  // so the click that reaches here never fires while one is already present.
  const addPlanner = (): void => {
    setRoster(current => [...current, 'planner'])
  }
  const addExecutor = (): void => {
    setRoster(current => [...current, 'executor'])
  }
  const removeAt = (index: number): void => {
    setRoster(current => current.filter((_, candidate) => candidate !== index))
  }

  // Executors repeat, so each one's remove control needs a distinct ordinal;
  // a planner is capped at one and never needs one.
  const ordinals: (number | null)[] = []
  let executorsSeen = 0
  for (const duty of roster) ordinals.push(duty === 'executor' ? ++executorsSeen : null)

  return (
    <div className={css.dock} data-team-subject>
      <div className={css.card}>
        <div
          className={css.roster}
          role="group"
          aria-label={t('roster.group', { count: String(roster.length + 1) })}
        >
          <Tag tone="solid" className={css.leadChip}>{t('roster.lead')}</Tag>
          {roster.map((duty, index) => (
            <ParticipantChip
              key={`${duty}-${String(index)}`}
              duty={duty}
              ordinal={ordinals[index] ?? null}
              onRemove={() => { removeAt(index) }}
              t={t}
            />
          ))}
          <Button
            variant="outline"
            size="sm"
            icon={<IconPlusOutlineRegular size={12} />}
            disabled={hasPlanner}
            onClick={addPlanner}
          >{t('roster.addPlanner')}</Button>
          <Button
            variant="outline"
            size="sm"
            icon={<IconPlusOutlineRegular size={12} />}
            onClick={addExecutor}
          >{t('roster.addExecutor')}</Button>
        </div>
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
    </div>
  )
}
