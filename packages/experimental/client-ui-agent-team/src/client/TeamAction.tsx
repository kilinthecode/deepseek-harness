import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  RoomFollowFrame,
  RoomPromptResult,
  RoomProposalView,
  RoomRemoteView,
  TeamMemberProjection,
  TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import {
  IconChevronDownOutlineRegular,
  IconUserOutlineRegular, IconUsersOutlineRegular, StateDot, Tag, Tooltip,
  useAnchoredPosition, useDismissOnOutsidePointer, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamAction.module.css'

/** Generated room Remote result consumed directly by the panel. */
export type TeamActionResult<T> = RemoteResult<T>

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  /** Open a roster Session from the current conversation. */
  openTeammate: (sessionId: SessionId, childSessionId: SessionId) => void
  /** Read the room of the Team the current conversation belongs to. */
  loadRoom: (sessionId: SessionId) => Promise<TeamActionResult<RoomRemoteView>>
  /**
   * Follow one room while the panel is open.
   * @param sessionId - current conversation; the plugin resolves its Lead.
   * @param signal - cancellation owned by the panel.
   * @param frame - receives every frame the Host delivers.
   * @returns fulfillment when the stream ends.
   */
  followRoom: (
    sessionId: SessionId,
    signal: AbortSignal,
    frame: (next: RoomFollowFrame) => void,
  ) => Promise<void>
  /** Give one participant the floor with an instruction the panel wrote. */
  promptParticipant: (
    sessionId: SessionId,
    input: { target: string; instruction: string },
  ) => Promise<TeamActionResult<RoomPromptResult>>
  /** Put one statement to the room as a collective decision. */
  proposeDecision: (
    sessionId: SessionId,
    input: { statement: string },
  ) => Promise<TeamActionResult<RoomProposalView>>
  /** Hand one unresolved decision to the human. */
  escalateDecision: (
    sessionId: SessionId,
    input: { proposalId: RoomProposalView['id']; reason: string },
  ) => Promise<TeamActionResult<RoomProposalView>>
}

/** Durable lifecycle overlaid with the member Session's live turn activity. */
type MemberStatus = 'running' | 'inactive' | 'provisioning' | 'failed'

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>

/**
 * Participants with more committed utterances in `next` than in `previous`.
 * @param previous - transcript of the previous followed view.
 * @param next - transcript a committed room change republished.
 * @returns names whose transcript entry count grew.
 */
function committedAuthors(
  previous: RoomRemoteView['messages'],
  next: RoomRemoteView['messages'],
): Set<string> {
  const before = new Map<string, number>()
  for (const message of previous) before.set(message.author, (before.get(message.author) ?? 0) + 1)
  const after = new Map<string, number>()
  for (const message of next) after.set(message.author, (after.get(message.author) ?? 0) + 1)
  return new Set([...after].filter(([author, count]) => count > (before.get(author) ?? 0)).map(([author]) => author))
}

/** One failure line for a room Remote failure. */
function failureText(error: { readonly code: string; readonly message: string }): string {
  return `${error.message} (${error.code})`
}

function statusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'verifying': return 'status.verifying'
    case 'completed': return 'status.completed'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'status.completed'
  }
}

/** One peer verdict on submitted work, using the room's own verdict wording. */
function taskVerdictKey(verdict: 'approved' | 'rejected'): TeamKey {
  switch (verdict) {
    case 'approved': return 'verdict.approve'
    case 'rejected': return 'verdict.reject'
  }
}

/** Localized label for one collective-decision phase. */
function phaseKey(phase: RoomProposalView['phase']): TeamKey {
  switch (phase) {
    case 'open': return 'phase.open'
    case 'accepted': return 'phase.accepted'
    case 'rejected': return 'phase.rejected'
    case 'escalated': return 'phase.escalated'
  }
}

function verdictKey(verdict: RoomProposalView['standings'][number]['verdict']): TeamKey {
  switch (verdict) {
    case 'approve': return 'verdict.approve'
    case 'reject': return 'verdict.reject'
    case 'abstain': return 'verdict.abstain'
  }
}

/** One vote line, naming the participants on each side or nobody at all. */
function voteLine(t: TranslateNS<typeof NS>, label: string, names: readonly string[]): string {
  return `${label}: ${names.length === 0 ? t('none') : names.join(', ')}`
}

function memberStatusKey(status: MemberStatus): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
  }
}

function memberDotState(status: Exclude<MemberStatus, 'inactive'>): StateDotState {
  switch (status) {
    case 'running':
    case 'provisioning': return 'ongoing'
    case 'failed': return 'error'
  }
}

function taskDotState(task: TeamTask): StateDotState {
  switch (task.status) {
    case 'pending': return task.ready ? 'idle' : 'warning'
    case 'in_progress':
    case 'verifying': return 'ongoing'
    case 'completed': return 'done'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'idle'
  }
}

type TeamMemberRowProps = Pick<TeamActionProps,
  'sessionId' | 'useSessions' | 'useSessionStatus' | 'openTeammate' | 't'
> & {
  member: TeamMemberProjection
  memberCount: number
  onError: (message: string) => void
}

function TeamMemberRow({
  member, memberCount, sessionId, useSessions, useSessionStatus, openTeammate, onError, t,
}: TeamMemberRowProps) {
  const model = useSessions(state => state.projectionsBySession[member.id]?.values.modelSelection?.next?.model)
  const running = useSessionStatus(state => state.get(member.id)?.running)
  const summaryRunning = useSessions(state => state.byId[member.id]?.running)
  const status: MemberStatus = member.phase === 'active'
    ? (running ?? summaryRunning) === true ? 'running' : 'inactive'
    : member.phase
  const isCurrent = member.id === sessionId
  const highlightCurrent = isCurrent && memberCount > 1
  const inert = isCurrent || status === 'failed' || status === 'provisioning'

  return (
    <Tooltip label={t('open')} side="bottom" gap={4} disabled={inert}>
      <button
        type="button"
        className={highlightCurrent ? `${css.member} ${css.memberCurrent}` : css.member}
        disabled={inert}
        onClick={() => {
          try {
            openTeammate(sessionId, member.id)
          } catch (reason) {
            onError(String(reason))
          }
        }}
      >
        <span className={css.memberDot}>
          {status === 'inactive'
            ? <IconUserOutlineRegular size={14} className={css.inactiveIcon} />
            : <StateDot state={memberDotState(status)} />}
        </span>
        <span className={css.memberText}>
          <span className={css.memberName}>
            <span className={css.memberNameText}>{member.name}</span>
            {isCurrent && <Tag tone="info" className={css.currentTag}>{t('current')}</Tag>}
          </span>
          <small>
            {t(memberStatusKey(status))}
            {model !== undefined && (
              <span className={css.memberModel}>{` · ${t('model')}: ${model}`}</span>
            )}
          </small>
          {member.error !== undefined && <small className={css.diagnostic}>{member.error}</small>}
        </span>
      </button>
    </Tooltip>
  )
}

/** Task card with a two-line description clamp expanded from a toggle in the meta row. */
function TaskCard({ task, t }: { task: TeamTask; t: TranslateNS<typeof NS> }) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    if (expanded) return
    const paragraph = textRef.current
    /* v8 ignore next -- the paragraph mounts in the same commit as the effect. */
    if (paragraph === null) return
    const measure = (): void => { setClamped(paragraph.scrollHeight > paragraph.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => { observer.disconnect() }
  }, [task.description, expanded])
  const verification = task.verification
  return (
    <article className={css.task}>
      <div className={css.taskTitle}>
        <strong>{task.subject}</strong>
        <span className={css.taskState}>
          <StateDot state={taskDotState(task)} />
          <span>{t(statusKey(task.status))}</span>
        </span>
      </div>
      <p ref={textRef} className={expanded ? undefined : css.clampedDescription}>{task.description}</p>
      {verification !== undefined && (
        <p className={css.verification}>
          {`${t('verification')}: ${verification.verifierName ?? t('none')}`
            + (verification.verdict === undefined ? '' : ` · ${t(taskVerdictKey(verification.verdict))}`)
            + (verification.reason === undefined ? '' : ` — ${verification.reason}`)}
        </p>
      )}
      <div className={css.meta}>
        {(clamped || expanded) && (
          <button
            type="button"
            className={css.expandToggle}
            aria-expanded={expanded}
            onClick={() => { setExpanded(current => !current) }}
          >
            {t(expanded ? 'task.collapse' : 'task.expand')}
            <IconChevronDownOutlineRegular size={12} className={expanded ? css.expandToggleOpen : undefined} />
          </button>
        )}
        <span>{task.id}</span>
        <span>{t('owner')}: {task.ownerName ?? t('unowned')}</span>
        {task.status === 'pending' && <span>{task.ready ? t('ready') : t('blocked')}</span>}
        {task.blockedBy.length > 0 && <span>{t('blockedBy')}: {task.blockedBy.join(', ')}</span>}
        {task.writeScopes.length > 0 && <span>{t('writeScopes')}: {task.writeScopes.join(', ')}</span>}
        {task.writeScopeWarnings.map(warning => <span key={warning} className={css.warning}>{warning}</span>)}
      </div>
    </article>
  )
}

type RoomSectionProps = Pick<TeamActionProps,
  'sessionId' | 'loadRoom' | 'followRoom' | 'promptParticipant' | 'proposeDecision' | 'escalateDecision' | 't'
>

/**
 * Room transcript, decision board, and the three panel-owned room actions.
 * It reads the room once when the panel opens and follows it while mounted;
 * a composition without a room renders nothing.
 */
function RoomSection({
  sessionId, loadRoom, followRoom, promptParticipant, proposeDecision, escalateDecision, t,
}: RoomSectionProps) {
  const [room, setRoom] = useState<RoomRemoteView | null>(null)
  /** Text each participant is streaming right now, keyed by participant name. */
  const [streaming, setStreaming] = useState<Readonly<Record<string, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [promptTarget, setPromptTarget] = useState('')
  const [promptDraft, setPromptDraft] = useState('')
  const [statementDraft, setStatementDraft] = useState('')
  /** Decision whose escalate form is open, and the reason being written. */
  const [escalating, setEscalating] = useState<string | null>(null)
  const [escalateReason, setEscalateReason] = useState('')
  const generation = useRef(0)
  /**
   * Transcript of the latest followed view, compared with the next view frame.
   * A room read never updates it: a read that already shows an utterance must
   * not hide that utterance's commit from the follow that clears its live text.
   */
  const followed = useRef<RoomRemoteView['messages']>([])

  const refresh = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    try {
      const result = await loadRoom(sessionId)
      if (generation.current !== current) return
      if (result.ok) setRoom(result.value)
      else setError(failureText(result.error))
    } catch (reason: unknown) {
      // An unmounted Remote namespace reaches the panel as a rejection, not a result.
      if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [loadRoom, sessionId])

  useEffect(() => {
    void refresh()
    return () => { generation.current += 1 }
  }, [refresh])

  const enabled = room?.enabled === true
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    // A committed change republishes the whole view. Only the participants
    // whose utterance it committed stop streaming; another participant's live
    // text survives a view that records someone else's message or a review.
    followRoom(sessionId, controller.signal, (frame) => {
      if (frame.type === 'view') {
        const committed = committedAuthors(followed.current, frame.view.messages)
        followed.current = frame.view.messages
        setRoom(frame.view)
        if (committed.size > 0) {
          setStreaming(previous => Object.fromEntries(
            Object.entries(previous).filter(([author]) => !committed.has(author)),
          ))
        }
        return
      }
      setStreaming(previous => ({
        ...previous,
        [frame.participant]: `${previous[frame.participant] ?? ''}${frame.delta}`,
      }))
    }).catch(() => {
      // A closed stream leaves the last complete view in place.
    })
    return () => { controller.abort() }
  }, [enabled, sessionId, followRoom])

  /** Run one room action, keeping failures visible and the view current. */
  const runAction = async (
    key: string,
    operation: () => Promise<TeamActionResult<unknown>>,
  ): Promise<boolean> => {
    setPending(current => new Set(current).add(key))
    try {
      const result = await operation()
      if (!result.ok) {
        setError(failureText(result.error))
        return false
      }
      setError(null)
      await refresh()
      return true
    } catch (reason: unknown) {
      // A carrier failure reaches the panel as a thrown error, not a result.
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const submitPrompt = async (): Promise<void> => {
    const instruction = promptDraft.trim()
    if (promptTarget === '' || instruction.length === 0) {
      setError(t('room.promptRequired'))
      return
    }
    const delivered = await runAction('room-prompt', () => promptParticipant(sessionId, {
      target: promptTarget,
      instruction,
    }))
    if (delivered) setPromptDraft('')
  }

  const submitProposal = async (): Promise<void> => {
    const statement = statementDraft.trim()
    if (statement.length === 0) {
      setError(t('room.statementRequired'))
      return
    }
    const opened = await runAction('room-propose', () => proposeDecision(sessionId, { statement }))
    if (opened) setStatementDraft('')
  }

  const submitEscalation = async (proposalId: RoomProposalView['id']): Promise<void> => {
    const reason = escalateReason.trim()
    if (reason.length === 0) {
      setError(t('room.reasonRequired'))
      return
    }
    const escalated = await runAction(`room-escalate-${proposalId}`, () => escalateDecision(sessionId, {
      proposalId,
      reason,
    }))
    if (escalated) {
      setEscalating(null)
      setEscalateReason('')
    }
  }

  const errorAlert = error === null
    ? null
    : <div className={css.error} role="alert"><StateDot state="error" />{error}</div>
  if (room === null || !room.enabled) return errorAlert === null ? null : <section>{errorAlert}</section>
  const liveEntries = Object.entries(streaming).filter(([, text]) => text.length > 0)
  /** Live participants that produced no work within the room's window. */
  const quiet = room.participants.filter(participant => participant.quiet).map(participant => participant.name)

  return (
    <section data-team-room>
      {errorAlert}
      <h3>{t('room')}</h3>
      <div className={css.chair}>{t('chair')}: {room.chair}</div>
      <div className={css.roomControls}>
        <select
          aria-label={t('room.promptTarget')}
          value={promptTarget}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => { setPromptTarget(event.target.value) }}
        >
          <option value=''>{t('room.promptTarget')}</option>
          {room.participants.map(participant => (
            <option key={participant.name} value={participant.name}>{participant.name}</option>
          ))}
        </select>
        <input
          aria-label={t('room.instruction')}
          value={promptDraft}
          placeholder={t('room.instruction')}
          onChange={(event: ChangeEvent<HTMLInputElement>) => { setPromptDraft(event.target.value) }}
        />
        <button
          type="button"
          disabled={pending.has('room-prompt')}
          onClick={() => { void submitPrompt() }}
        >{t('room.prompt')}</button>
      </div>
      <div className={css.roomControls}>
        <input
          aria-label={t('room.statement')}
          value={statementDraft}
          placeholder={t('room.statement')}
          onChange={(event: ChangeEvent<HTMLInputElement>) => { setStatementDraft(event.target.value) }}
        />
        <button
          type="button"
          disabled={pending.has('room-propose')}
          onClick={() => { void submitProposal() }}
        >{t('room.propose')}</button>
      </div>
      <h3>{t('transcript')}</h3>
      {room.messages.length === 0 && liveEntries.length === 0
        && <p className={css.emptyNotice}>{t('noTranscript')}</p>}
      <div className={css.transcript}>
        {room.messages.map((message, index) => (
          <div key={`${message.author}-${String(index)}`} className={css.turn}>
            <span className={css.author}>{message.author}</span>
            <span className={css.turnText}>{message.text}</span>
          </div>
        ))}
        {liveEntries.map(([author, text]) => (
          <div key={`live-${author}`} className={css.turn}>
            <span className={css.author}>{author}</span>
            <span className={css.liveText}>{text}</span>
          </div>
        ))}
      </div>
      <h3>{t('decisions')}</h3>
      {quiet.length > 0 && <div className={css.warning}>{t('quiet')}: {quiet.join(', ')}</div>}
      {room.proposals.length === 0 && <p className={css.emptyNotice}>{t('noDecisions')}</p>}
      <div className={css.decisions}>
        {room.proposals.map((proposal) => {
          const escalateKey = `room-escalate-${proposal.id}`
          return (
            <div key={proposal.id} className={css.decision}>
              <div className={css.decisionHead}>
                <span className={css.phase} data-phase={proposal.phase}>{t(phaseKey(proposal.phase))}</span>
                <span className={css.decisionId}>
                  <span>{proposal.id}</span>
                  <span>{t('revision')}</span>
                  <span>{proposal.revision}</span>
                </span>
                <span>{t('proposer')}: {proposal.proposerName}</span>
              </div>
              <p className={css.statement}>{proposal.statement}</p>
              <div className={css.votes}>
                <span>{voteLine(t, t('votes.approvals'), proposal.approvals)}</span>
                <span>{voteLine(t, t('votes.rejections'), proposal.rejections)}</span>
                <span>{voteLine(t, t('votes.abstentions'), proposal.abstentions)}</span>
                <span>{voteLine(t, t('votes.awaiting'), proposal.awaiting)}</span>
                {proposal.stalled.length > 0 && (
                  <span className={css.warning}>{voteLine(t, t('votes.stalled'), proposal.stalled)}</span>
                )}
              </div>
              {proposal.standings.length > 0 && (
                <ul className={css.standings}>
                  {proposal.standings.map(standing => (
                    <li key={standing.reviewer} className={css.standing}>
                      <span className={css.standingHead}>{standing.reviewer} · {t(verdictKey(standing.verdict))}</span>
                      <span className={css.standingReason}>{standing.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
              {proposal.phase === 'open' && (
                <div className={css.roomControls}>
                  <button
                    type="button"
                    aria-expanded={escalating === proposal.id}
                    disabled={pending.has(escalateKey)}
                    onClick={() => {
                      setEscalating(current => current === proposal.id ? null : proposal.id)
                      setEscalateReason('')
                    }}
                  >{t('room.escalate')}</button>
                  {escalating === proposal.id && (
                    <>
                      <input
                        aria-label={t('room.reason')}
                        value={escalateReason}
                        placeholder={t('room.reason')}
                        onChange={(event: ChangeEvent<HTMLInputElement>) => { setEscalateReason(event.target.value) }}
                      />
                      <button
                        type="button"
                        disabled={pending.has(escalateKey)}
                        onClick={() => { void submitEscalation(proposal.id) }}
                      >{t('room.escalateSubmit')}</button>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Render the Team roster, the room when the composition has one, and the read-only task board. */
export function TeamAction({
  sessionId, useSession, useSessions, useSessionStatus, openTeammate,
  loadRoom, followRoom, promptParticipant, proposeDecision, escalateDecision, t,
}: TeamActionProps) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const triggerLabelRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16,
  })
  const positioned = position !== null
  const leadSessionId = useSession(snapshot => snapshot.subagent?.address.parentSessionId) ?? sessionId
  const team = useSessions(state => state.projectionsBySession[leadSessionId]?.values.agentTeam)
  const opening = useSession(snapshot => snapshot.openState === 'loading')
  const listing = useSessions(state => state.phase === 'pending')
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pinnedRef = useRef(false)

  const cancelHoverChange = (): void => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
  }

  useEffect(() => {
    cancelHoverChange()
    pinnedRef.current = false
    setOpen(false)
    setError(null)
  }, [sessionId])

  useEffect(() => cancelHoverChange, [])

  useLayoutEffect(() => {
    if (open && positioned && pinnedRef.current) panelRef.current?.focus()
  }, [open, positioned])

  const changeOpen = (next: boolean): void => {
    cancelHoverChange()
    if (!next) pinnedRef.current = false
    setOpen(next)
  }

  const scheduleHoverOpen = (): void => {
    cancelHoverChange()
    if (open) return
    const label = triggerLabelRef.current
    /* v8 ignore next -- the label mounts with the trigger that received the hover. */
    if (label === null) return
    // Icon-only trigger (label collapsed by the header container query):
    // hover-open would surprise on such a small target, so only click opens.
    if (getComputedStyle(label).display === 'none') return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      changeOpen(true)
    }, 150)
  }

  const scheduleHoverClose = (): void => {
    cancelHoverChange()
    if (pinnedRef.current) return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      changeOpen(false)
    }, 120)
  }

  useDismissOnOutsidePointer(rootRef, open, changeOpen, panelRef)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancelHoverChange()
      pinnedRef.current = false
      setOpen(false)
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
    }
    document.addEventListener('keydown', dismiss)
    return () => { document.removeEventListener('keydown', dismiss) }
  }, [open])

  const compact = team !== undefined && team.members.length === 1 && team.tasks.length === 0

  return (
    <div
      ref={rootRef}
      className={css.root}
      data-team-action
      onMouseLeave={scheduleHoverClose}
    >
      <button
        type="button"
        ref={triggerRef}
        onMouseEnter={scheduleHoverOpen}
        className={css.trigger}
        aria-label={t('trigger')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          cancelHoverChange()
          pinnedRef.current = true
          if (!open) changeOpen(true)
          else panelRef.current?.focus()
        }}
      >
        <IconUsersOutlineRegular size={14} />
        <span ref={triggerLabelRef} className={css.triggerLabel}>{t('trigger')}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={compact ? `${css.panel} ${css.panelCompact}` : css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={t('trigger')}
          data-team-panel
          onMouseEnter={cancelHoverChange}
          onMouseLeave={scheduleHoverClose}
        >
          <div className={css.body}>
            {error !== null && (
              <div className={css.error} role="alert"><StateDot state="error" />{error}</div>
            )}
            {team === undefined && (
              <div className={css.notice} role="status">
                <StateDot state={opening || listing ? 'ongoing' : 'warning'} />
                {t(opening || listing ? 'loading' : 'unavailable')}
              </div>
            )}
            {team !== undefined && (
              <>
                {team.failure !== undefined && (
                  <div className={css.error} role="alert"><StateDot state="error" />{t('failure', { message: team.failure })}</div>
                )}
                <section>
                  <h3>
                    {t('roster')}
                    {team.members.length > 1 && <span className={css.count}>{team.members.length}</span>}
                  </h3>
                  <div className={css.roster}>
                    {team.members.map(member => (
                      <TeamMemberRow
                        key={member.id}
                        member={member}
                        memberCount={team.members.length}
                        sessionId={sessionId}
                        useSessions={useSessions}
                        useSessionStatus={useSessionStatus}
                        openTeammate={openTeammate}
                        onError={setError}
                        t={t}
                      />
                    ))}
                  </div>
                </section>
                <RoomSection
                  sessionId={sessionId}
                  loadRoom={loadRoom}
                  followRoom={followRoom}
                  promptParticipant={promptParticipant}
                  proposeDecision={proposeDecision}
                  escalateDecision={escalateDecision}
                  t={t}
                />
                <section>
                  {team.tasks.length === 0
                    ? <p className={css.emptyNotice}>{t('empty')}</p>
                    : (
                      <>
                        <h3>{t('tasks')}<span className={css.count}>{team.tasks.length}</span></h3>
                        <div className={css.tasks}>
                          {team.tasks.map(task => <TaskCard key={task.id} task={task} t={t} />)}
                        </div>
                      </>
                    )}
                </section>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
