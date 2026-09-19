import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberView as TeamRosterMember,
  TeamTaskAction,
  TeamTaskId,
  TeamTaskMutationResult,
  RoomProposalView,
  RoomPromptResult,
  RoomFollowFrame,
  RoomRemoteView,
  TeamTaskView as TeamTask,
  TeamView,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline14, IconCloseOutline16, IconEditOutline16, IconPlusOutline16,
  IconRefreshOutline14, IconTrashOutline16, IconUserOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamAction.module.css'

/** Generated Remote result consumed directly by the Team UI. */
export type TeamActionResult<T> = RemoteResult<T>

/** Generated Remote result whose business value preserves Team task rejections. */
export type TeamTaskActionResult = RemoteResult<TeamTaskMutationResult>

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  load: (sessionId: SessionId) => Promise<TeamActionResult<TeamView>>
  loadRoom: (sessionId: SessionId) => Promise<TeamActionResult<RoomRemoteView>>
  createTask: (sessionId: SessionId, input: {
    subject: string
    description: string
    blockedBy: TeamTaskId[]
    writeScopes: string[]
  }) => Promise<TeamTaskActionResult>
  updateTask: (sessionId: SessionId, input: {
    taskId: TeamTaskId
    expectedRevision: number
    action: TeamTaskAction
    subject?: string
    description?: string
    blockedBy?: TeamTaskId[]
    writeScopes?: string[]
    owner?: string
    verdict?: 'approved' | 'rejected'
    reason?: string
  }) => Promise<TeamTaskActionResult>
  openTeammate: (sessionId: SessionId, member: TeamRosterMember) => Promise<void>
  /**
   * Follow one room while the panel is open.
   * @param sessionId - Lead Session whose room is followed.
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

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>

interface Draft {
  subject: string
  description: string
  blockers: string
  scopes: string
}

const EMPTY_DRAFT: Draft = { subject: '', description: '', blockers: '', scopes: '' }

function items(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function taskIds(value: string): TeamTaskId[] {
  return items(value) as TeamTaskId[]
}

/**
 * One failure line for either carrier: a Remote failure, or a Team business
 * rejection whose codes stay local to this seam and never ride the wire.
 */
function failureText(error: { readonly code: string; readonly message: string }): string {
  return `${error.message} (${error.code})`
}

/** One peer verdict on submitted work, using the room's own verdict wording. */
function taskVerdictKey(verdict: 'approved' | 'rejected'): TeamKey {
  switch (verdict) {
    case 'approved': return 'verdict.approve'
    case 'rejected': return 'verdict.reject'
  }
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
function voteLine(t: PropsLocale<typeof NS>['t'], label: string, names: readonly string[]): string {
  return `${label}: ${names.length === 0 ? t('none') : names.join(', ')}`
}

function memberStatusKey(status: TeamRosterMember['status']): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'idle': return 'memberStatus.idle'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
  }
}

/** Render the live Team roster and compare-and-set task board. */
export function TeamAction({
  sessionId, load, loadRoom, createTask, updateTask, openTeammate, followRoom,
  promptParticipant, proposeDecision, escalateDecision, t,
}: TeamActionProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<TeamView | null>(null)
  const [room, setRoom] = useState<RoomRemoteView | null>(null)
  /** Text each participant is streaming right now, keyed by participant name. */
  const [streaming, setStreaming] = useState<Readonly<Record<string, string>>>({})
  /** Task whose verification form is open, and the reason being written. */
  const [roomPromptTarget, setRoomPromptTarget] = useState('')
  const [roomPromptDraft, setRoomPromptDraft] = useState('')
  const [roomStatementDraft, setRoomStatementDraft] = useState('')
  /** Decision whose escalate form is open, and the reason being written. */
  const [escalatingRoom, setEscalatingRoom] = useState<string | null>(null)
  const [escalateRoomReason, setEscalateRoomReason] = useState('')
  const [verifyingTask, setVerifyingTask] = useState<string | null>(null)
  const [verifyReason, setVerifyReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState<Draft>(EMPTY_DRAFT)
  const [editing, setEditing] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT)
  const [pendingTasks, setPendingTasks] = useState<ReadonlySet<string>>(() => new Set())
  const sessionRef = useRef(sessionId)
  const refreshGeneration = useRef(0)
  sessionRef.current = sessionId

  useEffect(() => {
    refreshGeneration.current += 1
    setOpen(false)
    setLoading(false)
    setView(null)
    setRoom(null)
    setStreaming({})
    setVerifyingTask(null)
    setVerifyReason('')
    setRoomPromptTarget('')
    setRoomPromptDraft('')
    setRoomStatementDraft('')
    setEscalatingRoom(null)
    setEscalateRoomReason('')
    setError(null)
    setCreating(false)
    setCreateDraft(EMPTY_DRAFT)
    setEditing(null)
    setEditDraft(EMPTY_DRAFT)
    setPendingTasks(new Set())
  }, [sessionId])

  const liveEntries = Object.entries(streaming).filter(([, text]) => text.length > 0)
  /** Live participants that produced no work within the room's window. */
  const quiet = room === null ? [] : room.participants.filter(participant => participant.quiet).map(participant => participant.name)
  const roomOpen = open && room !== null && room.enabled
  useEffect(() => {
    if (!roomOpen) return
    const controller = new AbortController()
    // A committed change republishes the whole view, so streaming text is
    // dropped once its utterance is durable.
    void followRoom(sessionId, controller.signal, (frame) => {
      if (frame.type === 'view') {
        setRoom(frame.view)
        setStreaming({})
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
  }, [roomOpen, sessionId, followRoom])

  const refresh = useCallback(async (): Promise<boolean> => {
    const requestedSession = sessionId
    const generation = ++refreshGeneration.current
    setLoading(true)
    // The room and the roster are read together: a decision without its roster,
    // or a roster without the decisions it is accountable for, is not a view of
    // the same room.
    const [result, roomResult] = await Promise.all([load(requestedSession), loadRoom(requestedSession)])
    if (sessionRef.current !== requestedSession || refreshGeneration.current !== generation) return false
    setLoading(false)
    if (result.ok) {
      setView(result.value)
      setError(null)
    } else {
      setError(failureText(result.error))
      return false
    }
    if (roomResult.ok) setRoom(roomResult.value)
    else setError(failureText(roomResult.error))
    return true
  }, [load, loadRoom, sessionId])

  const invalidateRefresh = useCallback((): void => {
    refreshGeneration.current += 1
    setLoading(false)
  }, [])

  const settleTask = useCallback(async (
    taskId: string,
    operation: () => Promise<TeamTaskActionResult>,
  ): Promise<TeamTask | undefined> => {
    const requestedSession = sessionId
    invalidateRefresh()
    setPendingTasks(current => new Set(current).add(taskId))
    try {
      const result = await operation()
      if (sessionRef.current !== requestedSession) return undefined
      if (!result.ok) {
        setError(failureText(result.error))
        return undefined
      }
      if (!result.value.ok) {
        if (result.value.error.code === 'team-task-conflict') {
          const reloaded = await refresh()
          if (sessionRef.current !== requestedSession) return undefined
          if (reloaded) setError(t('conflict'))
        } else {
          setError(failureText(result.value.error))
        }
        return undefined
      }
      const task = result.value.value
      setError(null)
      await refresh()
      if (sessionRef.current !== requestedSession) return undefined
      return task
    } finally {
      if (sessionRef.current === requestedSession) {
        setPendingTasks((current) => {
          const next = new Set(current)
          next.delete(taskId)
          return next
        })
      }
    }
  }, [invalidateRefresh, refresh, sessionId, t])

  const submitVerification = async (task: TeamTask, verdict: 'approved' | 'rejected'): Promise<void> => {
    const reason = verifyReason.trim()
    // A verdict without its objection is exactly what peer verification exists to
    // prevent, so the panel refuses it before the Host has to.
    if (reason.length === 0) {
      setError(t('verification.reasonRequired'))
      return
    }
    const settled = await settleTask(task.id, () => updateTask(sessionId, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'verify',
      verdict,
      reason,
    }))
    if (settled !== undefined) {
      setVerifyingTask(null)
      setVerifyReason('')
    }
  }

  /** Run one room action, keeping failures visible and the view current. */
  const runRoomAction = useCallback(async (
    key: string,
    operation: () => Promise<TeamActionResult<unknown>>,
  ): Promise<boolean> => {
    const requestedSession = sessionId
    invalidateRefresh()
    setPendingTasks(current => new Set(current).add(key))
    try {
      const result = await operation()
      if (sessionRef.current !== requestedSession) return false
      if (!result.ok) {
        setError(failureText(result.error))
        return false
      }
      setError(null)
      await refresh()
      return sessionRef.current === requestedSession
    } catch (error: unknown) {
      // A carrier failure reaches the panel as a thrown error, not a result.
      if (sessionRef.current === requestedSession) {
        setError(error instanceof Error ? error.message : String(error))
      }
      return false
    } finally {
      if (sessionRef.current === requestedSession) {
        setPendingTasks((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    }
  }, [invalidateRefresh, refresh, sessionId])

  const submitRoomPrompt = async (): Promise<void> => {
    const instruction = roomPromptDraft.trim()
    if (roomPromptTarget === '' || instruction.length === 0) {
      setError(t('room.promptRequired'))
      return
    }
    const delivered = await runRoomAction('room-prompt', () => promptParticipant(sessionId, {
      target: roomPromptTarget,
      instruction,
    }))
    if (delivered) setRoomPromptDraft('')
  }

  const submitRoomProposal = async (): Promise<void> => {
    const statement = roomStatementDraft.trim()
    if (statement.length === 0) {
      setError(t('room.statementRequired'))
      return
    }
    const opened = await runRoomAction('room-propose', () => proposeDecision(sessionId, { statement }))
    if (opened) setRoomStatementDraft('')
  }

  const submitRoomEscalation = async (proposalId: RoomProposalView['id']): Promise<void> => {
    const reason = escalateRoomReason.trim()
    if (reason.length === 0) {
      setError(t('room.reasonRequired'))
      return
    }
    const escalated = await runRoomAction(`room-escalate-${proposalId}`, () => escalateDecision(sessionId, {
      proposalId,
      reason,
    }))
    if (escalated) {
      setEscalatingRoom(null)
      setEscalateRoomReason('')
    }
  }

  const submitCreate = async (): Promise<void> => {
    const subject = createDraft.subject.trim()
    const description = createDraft.description.trim()
    /* v8 ignore next -- TaskForm disables Save while either normalized field is empty. */
    if (subject === '' || description === '') return
    const created = await settleTask('create', () => createTask(sessionId, {
      subject,
      description,
      blockedBy: taskIds(createDraft.blockers),
      writeScopes: items(createDraft.scopes),
    }))
    if (created === undefined) return
    setCreateDraft(EMPTY_DRAFT)
    setCreating(false)
  }

  const startEdit = (task: TeamTask): void => {
    setEditing(task.id)
    setEditDraft({
      subject: task.subject,
      description: task.description,
      blockers: task.blockedBy.join(', '),
      scopes: task.writeScopes.join(', '),
    })
  }

  const submitEdit = async (task: TeamTask): Promise<void> => {
    const requestedSession = sessionId
    const edited = await settleTask(task.id, () => updateTask(requestedSession, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'edit',
      subject: editDraft.subject.trim(),
      description: editDraft.description.trim(),
      writeScopes: items(editDraft.scopes),
    }))
    if (edited === undefined) return
    const blockedBy = taskIds(editDraft.blockers)
    if (blockedBy.length === edited.blockedBy.length
      && blockedBy.every((blocker, index) => blocker === edited.blockedBy[index])) {
      setEditing(null)
      return
    }
    const dependencyTask = await settleTask(task.id, () => updateTask(requestedSession, {
      taskId: task.id,
      expectedRevision: edited.revision,
      action: 'set_dependencies',
      blockedBy,
    }))
    if (dependencyTask === undefined) return
    setEditing(null)
  }

  const teammates = view?.members.filter(member => member.role === 'teammate') ?? []
  const assignable = view?.members.filter(member => member.status !== 'failed' && member.status !== 'provisioning') ?? []

  return (
    <div className={css.root} data-team-action>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) void refresh()
        }}
      >
        <IconUserOutline16 size={14} />
        <span>{t('trigger')}</span>
        {teammates.length > 0 && <span className={css.count}>{teammates.length}</span>}
      </button>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('trigger')}>
          <div className={css.toolbar}>
            <strong>{t('trigger')}</strong>
            <span className={css.spacer} />
            <button type="button" className={css.iconButton} aria-label={t('refresh')} onClick={() => { void refresh() }}>
              <IconRefreshOutline14 />
            </button>
            <button type="button" className={css.iconButton} aria-label={t('close')} onClick={() => { setOpen(false) }}>
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          {error !== null && <div className={css.error} role="alert">{error}</div>}
          {loading && view === null && <div className={css.notice}>{t('loading')}</div>}
          {view !== null && (
            <>
              <section>
                <h3>{t('roster')}</h3>
                <div className={css.roster}>
                  {view.members.map(member => (
                    <button
                      key={member.id}
                      type="button"
                      className={css.member}
                      disabled={member.role === 'lead' || member.status === 'failed' || member.status === 'provisioning'}
                      title={member.role === 'teammate' ? t('open') : undefined}
                      onClick={() => {
                        void openTeammate(sessionId, member).catch((reason: unknown) => { setError(String(reason)) })
                      }}
                    >
                      <StateDot state={member.status === 'running' ? 'ongoing' : member.status === 'failed' ? 'error' : 'done'} />
                      <span className={css.memberText}>
                        <span>{member.name}</span>
                        <small>{t(memberStatusKey(member.status))}{member.model === undefined ? '' : ` · ${t('model')}: ${member.model}`}</small>
                        {member.diagnostics.map(diagnostic => <small key={diagnostic} className={css.diagnostic}>{diagnostic}</small>)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
              {room !== null && room.enabled && (
                <section>
                  <div className={css.roomControls}>
                    <select
                      aria-label={t('room.promptTarget')}
                      value={roomPromptTarget}
                      onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                        setRoomPromptTarget(event.target.value)
                      }}
                    >
                      <option value=''>{t('room.promptTarget')}</option>
                      {room.participants.map(participant => (
                        <option key={participant.name} value={participant.name}>{participant.name}</option>
                      ))}
                    </select>
                    <input
                      value={roomPromptDraft}
                      placeholder={t('room.instruction')}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setRoomPromptDraft(event.target.value)
                      }}
                    />
                    <button
                      type="button"
                      disabled={pendingTasks.has('room-prompt')}
                      onClick={() => { void submitRoomPrompt() }}
                    >{t('room.prompt')}</button>
                  </div>
                  <div className={css.roomControls}>
                    <input
                      value={roomStatementDraft}
                      placeholder={t('room.statement')}
                      onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setRoomStatementDraft(event.target.value)
                      }}
                    />
                    <button
                      type="button"
                      disabled={pendingTasks.has('room-propose')}
                      onClick={() => { void submitRoomProposal() }}
                    >{t('room.propose')}</button>
                  </div>
                  <h3>{t('transcript')}</h3>
                  {room.messages.length === 0 && liveEntries.length === 0
                    && <div className={css.notice}>{t('noTranscript')}</div>}
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
                  <div className={css.sectionTitle}>
                    <h3>{t('decisions')}</h3>
                    <span className={css.chair}>{t('room')} · {t('chair')}: {room.chair}</span>
                  </div>
                  {quiet.length > 0 && (
                    <div className={css.warning}>{t('quiet')}: {quiet.join(', ')}</div>
                  )}
                  {room.proposals.length === 0 && <div className={css.notice}>{t('noDecisions')}</div>}
                  <div className={css.decisions}>
                    {room.proposals.map(proposal => (
                      <div key={proposal.id} className={css.decision}>
                        <div className={css.decisionHead}>
                          <span className={css.phase} data-phase={proposal.phase}>{t(phaseKey(proposal.phase))}</span>
                          <span className={css.decisionId}>
                            <span>{proposal.id}</span>
                            <span>{t('revision')}</span>
                            <span>{proposal.revision}</span>
                          </span>
                          <span className={css.spacer} />
                          <span>{t('proposer')}: {proposal.proposerName}</span>
                        </div>
                        <p className={css.statement}>{proposal.statement}</p>
                        <div className={css.votes}>
                          <span>{voteLine(t, t('votes.approvals'), proposal.approvals)}</span>
                          <span>{voteLine(t, t('votes.rejections'), proposal.rejections)}</span>
                          <span>{voteLine(t, t('votes.abstentions'), proposal.abstentions)}</span>
                          <span>{voteLine(t, t('votes.awaiting'), proposal.awaiting)}</span>
                          {proposal.stalled.length > 0 && (
                            <span className={css.warning}>
                              {voteLine(t, t('votes.stalled'), proposal.stalled)}
                            </span>
                          )}
                        </div>
                        {proposal.standings.length > 0 && (
                          <ul className={css.standings}>
                            {proposal.standings.map(standing => (
                              <li key={standing.reviewer} className={css.standing}>
                                <span className={css.standingHead}>
                                  {standing.reviewer} · {t(verdictKey(standing.verdict))}
                                </span>
                                <span className={css.standingReason}>{standing.reason}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {proposal.phase === 'open' && (escalatingRoom === proposal.id
                          ? (
                            <div className={css.form}>
                              <textarea
                                value={escalateRoomReason}
                                placeholder={t('room.reason')}
                                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                                  setEscalateRoomReason(event.target.value)
                                }}
                              />
                              <div className={css.formActions}>
                                <button
                                  type="button"
                                  disabled={pendingTasks.has(`room-escalate-${proposal.id}`)}
                                  onClick={() => { void submitRoomEscalation(proposal.id) }}
                                >{t('room.escalateSubmit')}</button>
                                <button
                                  type="button"
                                  onClick={() => { setEscalatingRoom(null); setEscalateRoomReason('') }}
                                >{t('cancel')}</button>
                              </div>
                            </div>
                          )
                          : (
                            <button
                              type="button"
                              disabled={pendingTasks.has(`room-escalate-${proposal.id}`)}
                              onClick={() => { setEscalatingRoom(proposal.id); setEscalateRoomReason('') }}
                            >{t('room.escalate')}</button>
                          ))}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <section>
                <div className={css.sectionTitle}>
                  <h3>{t('tasks')}</h3>
                  <button type="button" className={css.smallButton} onClick={() => { setCreating(true) }}>
                    <IconPlusOutline16 size={13} /> {t('create')}
                  </button>
                </div>
                {creating && (
                  <TaskForm
                    draft={createDraft}
                    setDraft={setCreateDraft}
                    pending={pendingTasks.has('create')}
                    onSave={() => { void submitCreate() }}
                    onCancel={() => { setCreating(false) }}
                    t={t}
                  />
                )}
                {view.tasks.length === 0 && !creating && <div className={css.notice}>{t('empty')}</div>}
                <div className={css.tasks}>
                  {view.tasks.map(task => editing === task.id
                    ? (
                      <TaskForm
                        key={task.id}
                        draft={editDraft}
                        setDraft={setEditDraft}
                        pending={pendingTasks.has(task.id)}
                        onSave={() => { void submitEdit(task) }}
                        onCancel={() => { setEditing(null) }}
                        t={t}
                      />
                    )
                    : (
                      <article key={task.id} className={css.task}>
                        <div className={css.taskTitle}>
                          <strong>{task.subject}</strong>
                          <span>{t(statusKey(task.status))}</span>
                        </div>
                        <p>{task.description}</p>
                        {task.verification !== undefined && (
                          <p className={css.verification}>
                            {`${t('verification')}: ${task.verification.verifierName ?? t('none')}`
                              + (task.verification.verdict === undefined
                                ? ''
                                : ` · ${t(taskVerdictKey(task.verification.verdict))}`)
                              + (task.verification.reason === undefined ? '' : ` — ${task.verification.reason}`)}
                          </p>
                        )}
                        <div className={css.meta}>
                          <span>{task.id}</span>
                          {task.status === 'pending' && <span>{task.ready ? t('ready') : t('blocked')}</span>}
                          {task.blockedBy.length > 0 && <span>{t('blockedBy')}: {task.blockedBy.join(', ')}</span>}
                          {task.writeScopes.length > 0 && <span>{t('writeScopes')}: {task.writeScopes.join(', ')}</span>}
                          {task.writeScopeWarnings.map(warning => <span key={warning} className={css.warning}>{warning}</span>)}
                        </div>
                        <div className={css.taskActions}>
                          <label>
                            {t('owner')}
                            <select
                              value={task.ownerName ?? ''}
                              disabled={pendingTasks.has(task.id) || task.status === 'completed'}
                              onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                                const owner = event.target.value
                                void settleTask(task.id, () => updateTask(sessionId, {
                                  taskId: task.id,
                                  expectedRevision: task.revision,
                                  action: 'reassign',
                                  ...owner === '' ? {} : { owner },
                                }))
                              }}
                            >
                              <option value="">{t('unowned')}</option>
                              {assignable.map(member => <option key={member.id} value={member.name}>{member.name}</option>)}
                            </select>
                          </label>
                          <button type="button" onClick={() => { startEdit(task) }} disabled={pendingTasks.has(task.id)}>
                            <IconEditOutline16 size={13} /> {t('edit')}
                          </button>
                          {task.status === 'in_progress' && (
                            <button type="button" disabled={pendingTasks.has(task.id)} onClick={() => {
                              void settleTask(task.id, () => updateTask(sessionId, {
                                taskId: task.id, expectedRevision: task.revision, action: 'submit',
                              }))
                            }}><IconCheckOutline14 /> {t('submit')}</button>
                          )}
                          {task.status === 'verifying' && (verifyingTask === task.id
                            ? (
                              <div className={css.form}>
                                <textarea
                                  value={verifyReason}
                                  placeholder={t('verification.reason')}
                                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                                    setVerifyReason(event.target.value)
                                  }}
                                />
                                <div className={css.formActions}>
                                  <button
                                    type="button"
                                    disabled={pendingTasks.has(task.id)}
                                    onClick={() => { void submitVerification(task, 'approved') }}
                                  >{t('verdict.approve')}</button>
                                  <button
                                    type="button"
                                    disabled={pendingTasks.has(task.id)}
                                    onClick={() => { void submitVerification(task, 'rejected') }}
                                  >{t('verdict.reject')}</button>
                                  <button
                                    type="button"
                                    onClick={() => { setVerifyingTask(null); setVerifyReason('') }}
                                  >{t('cancel')}</button>
                                </div>
                              </div>
                            )
                            : (
                              <button
                                type="button"
                                disabled={pendingTasks.has(task.id)}
                                onClick={() => { setVerifyingTask(task.id); setVerifyReason('') }}
                              ><IconCheckOutline14 /> {t('verify')}</button>
                            ))}
                          {task.status === 'completed' && (
                            <button type="button" disabled={pendingTasks.has(task.id)} onClick={() => {
                              void settleTask(task.id, () => updateTask(sessionId, {
                                taskId: task.id, expectedRevision: task.revision, action: 'reopen',
                              }))
                            }}>{t('reopen')}</button>
                          )}
                          <button type="button" disabled={pendingTasks.has(task.id)} onClick={() => {
                            void settleTask(task.id, () => updateTask(sessionId, {
                              taskId: task.id, expectedRevision: task.revision, action: 'delete',
                            }))
                          }}><IconTrashOutline16 size={13} /> {t('delete')}</button>
                        </div>
                      </article>
                    ))}
                </div>
              </section>
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface TaskFormProps {
  draft: Draft
  setDraft: (draft: Draft) => void
  pending: boolean
  onSave: () => void
  onCancel: () => void
  t: TeamActionProps['t']
}

function TaskForm({ draft, setDraft, pending, onSave, onCancel, t }: TaskFormProps) {
  const field = (key: keyof Draft, value: string): void => { setDraft({ ...draft, [key]: value }) }
  return (
    <div className={css.form}>
      <input value={draft.subject} placeholder={t('subject')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('subject', event.target.value) }} />
      <textarea value={draft.description} placeholder={t('description')} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { field('description', event.target.value) }} />
      <input value={draft.blockers} placeholder={t('blockers')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('blockers', event.target.value) }} />
      <input value={draft.scopes} placeholder={t('scopes')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('scopes', event.target.value) }} />
      <div className={css.formActions}>
        <button type="button" disabled={pending || draft.subject.trim() === '' || draft.description.trim() === ''} onClick={onSave}>{t('save')}</button>
        <button type="button" disabled={pending} onClick={onCancel}>{t('cancel')}</button>
      </div>
    </div>
  )
}
