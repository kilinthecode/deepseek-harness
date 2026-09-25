// @vitest-environment jsdom

import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  RoomFollowFrame, RoomPromptResult, RoomProposalView, RoomRemoteView,
  TeamMemberProjection, TeamProjection, TeamTaskId, TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionListState, SessionSnapshot, SessionSummary, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TeamAction, type TeamActionInjected, type TeamActionProps } from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const SESSION = 'lead' as SessionId
const WORKER = 'worker-id' as SessionId
const TASK_1 = 'task-1' as TeamTaskId
const TASK_2 = 'task-2' as TeamTaskId
const TASK_3 = 'task-3' as TeamTaskId
const PROPOSAL = 'proposal-1' as RoomProposalView['id']
const task: TeamTask = {
  id: TASK_1,
  revision: 1,
  subject: 'Implement runtime',
  description: 'Build the Team runtime',
  status: 'in_progress',
  ownerName: 'lead',
  blockedBy: [],
  writeScopes: ['src'],
  ready: false,
  writeScopeWarnings: ['write scopes overlap with task-2'],
}
const lead: TeamMemberProjection = { id: SESSION, name: 'lead', role: 'lead', phase: 'active' }
const worker: TeamMemberProjection = {
  id: WORKER, name: 'worker', role: 'teammate', phase: 'active',
}
const team: TeamProjection = { members: [lead, worker], tasks: [task] }
const rejected: RoomProposalView = {
  id: PROPOSAL,
  revision: 1,
  proposerName: 'lead',
  statement: 'Adopt a global mutable cache with no invalidation.',
  phase: 'rejected',
  requiredApprovals: 1,
  approvals: [],
  rejections: ['worker'],
  abstentions: [],
  awaiting: [],
  stalled: [],
  standings: [],
}
const room: RoomRemoteView = {
  enabled: true,
  participants: [
    { id: SESSION, name: 'lead', status: 'running', quiet: false },
    { id: WORKER, name: 'worker', status: 'inactive', quiet: false },
  ],
  chair: 'lead',
  messages: [{ author: 'worker', text: 'the cache serves stale reads' }],
  proposals: [rejected],
}

type Projections = SessionListState['projectionsBySession']

function summary(id: SessionId, running: boolean): SessionSummary {
  return { id, displayTitle: id, running, retainedBy: {}, blank: false, updatedAt: 0 }
}

function bench(options: {
  projections?: Projections
  sessionId?: SessionId
  parentSessionId?: SessionId
  openState?: SessionSnapshot['openState']
  statuses?: SessionStatusSnapshot
  running?: Record<SessionId, boolean>
  injected?: Partial<TeamActionInjected>
} = {}) {
  const sessionId = options.sessionId ?? SESSION
  const byId: Record<SessionId, SessionSummary> = {}
  for (const [id, running] of Object.entries(options.running ?? {}) as [SessionId, boolean][]) byId[id] = summary(id, running)
  const sessions = createSnapshotStore<SessionListState>({
    ids: Object.keys(byId) as SessionId[], byId, phase: 'ready',
    projectionsBySession: options.projections ?? { [SESSION]: { state: 'ready', error: null, values: { agentTeam: team } } },
  })
  const statuses = createSnapshotStore<SessionStatusSnapshot>(options.statuses ?? new Map())
  const session = createSnapshotStore<SessionSnapshot>({
    sessionId,
    pendingSubmissions: [],
    running: false,
    subagent: options.parentSessionId === undefined
      ? null
      : { address: { parentSessionId: options.parentSessionId, childSessionId: sessionId, mode: 'continuable' } },
    removed: false,
    openState: options.openState ?? 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  })
  const useSessions = bindSnapshotSelector(sessions)
  const injected: TeamActionInjected = {
    openTeammate: vi.fn(),
    // Room reads stay pending unless a case supplies a room, so roster and
    // task cases render exactly as they would in a composition without one.
    loadRoom: vi.fn(() => new Promise<never>(() => {})),
    followRoom: vi.fn(() => new Promise<void>(() => {})),
    promptParticipant: vi.fn(() => new Promise<never>(() => {})),
    proposeDecision: vi.fn(() => new Promise<never>(() => {})),
    escalateDecision: vi.fn(() => new Promise<never>(() => {})),
    ...options.injected,
  }
  const props: TeamActionProps = {
    sessionId,
    useSession: bindSnapshotSelector(session),
    useProjection: ((key: string, select?: (value: unknown) => unknown) => {
      const value = useSessions(state => state.projectionsBySession[sessionId]?.values[
        key as keyof SessionListState['projectionsBySession'][SessionId]['values']
      ])
      return select === undefined ? value : select(value)
    }) as UseProjection,
    useSessions,
    useSessionStatus: bindSnapshotSelector(statuses),
    ...injected,
    t: makeTranslate(zh, commonZh),
  } as TeamActionProps
  return { props, injected, sessions, statuses, session }
}

function openPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: /智能体团队/u }))
}

function setProjectionSnapshot(
  sessions: ReturnType<typeof bench>['sessions'],
  sessionId: SessionId,
  snapshot: Projections[SessionId],
): void {
  act(() => {
    const current = sessions.getSnapshot()
    sessions.set({ ...current, projectionsBySession: { ...current.projectionsBySession, [sessionId]: snapshot } })
  })
}

function setProjection(sessions: ReturnType<typeof bench>['sessions'], sessionId: SessionId, value: TeamProjection): void {
  setProjectionSnapshot(sessions, sessionId, { state: 'ready', error: null, values: { agentTeam: value } })
}

/** Bench whose room read resolves to one fixed view. */
function roomBench(value: RoomRemoteView, injected: Partial<TeamActionInjected> = {}) {
  return bench({ injected: { loadRoom: vi.fn(() => Promise.resolve({ ok: true as const, value })), ...injected } })
}

describe('TeamAction', () => {
  it('renders the Lead projection and applies later projection frames without any user action', async () => {
    const b = bench()
    render(<TeamAction {...b.props} />)
    expect(screen.getByRole('button', { name: /智能体团队/u }).textContent).toBe(zh.trigger)
    openPanel()
    expect(await screen.findByText('Implement runtime')).toBeTruthy()
    expect(screen.getByText('write scopes overlap with task-2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /刷新|Refresh/u })).toBeNull()

    setProjection(b.sessions, SESSION, {
      members: [lead, worker, { id: 'worker-b' as SessionId, name: 'worker-b', role: 'teammate', phase: 'provisioning' }],
      tasks: [task, { ...task, id: TASK_2, subject: 'Pushed task', status: 'pending', ready: true, writeScopeWarnings: [] }],
    })
    expect(screen.getByText('Pushed task')).toBeTruthy()
    expect(screen.getByRole('button', { name: /worker-b/u })).toHaveProperty('disabled', true)
    expect(screen.getByRole('heading', { name: '成员3' })).toBeTruthy()
  })

  it('overlays live Session status and the durable model selection on roster rows', () => {
    const statuses: SessionStatusSnapshot = new Map([[WORKER, { running: true, pendingInteraction: undefined, completionUnread: false }]])
    const b = bench({
      statuses,
      running: { [SESSION]: true },
      projections: {
        [SESSION]: {
          state: 'ready', error: null,
          values: { agentTeam: team, modelSelection: { lastUsed: null, next: { provider: 'p', model: 'lead-model' } } },
        },
        [WORKER]: {
          state: 'ready', error: null,
          values: { modelSelection: { lastUsed: { provider: 'p', model: 'worker-model' }, next: { provider: 'p', model: 'worker-model' } } },
        },
      },
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('button', { name: new RegExp(`lead.*${zh['memberStatus.running']}.*lead-model`, 'u') })).toBeTruthy()
    const row = screen.getByRole('button', { name: new RegExp(`worker.*${zh['memberStatus.running']}.*worker-model`, 'u') })
    expect(row.querySelector('[data-state="ongoing"]')).not.toBeNull()

    act(() => { b.statuses.set(new Map([[WORKER, { running: false, pendingInteraction: undefined, completionUnread: false }]])) })
    expect(screen.getByRole('button', { name: /^worker.*未运行/u })).toBeTruthy()

    act(() => {
      b.statuses.set(new Map())
      b.sessions.update((draft) => { draft.byId[WORKER] = summary(WORKER, true) })
    })
    expect(screen.getByRole('button', { name: /^worker.*运行中/u })).toBeTruthy()
  })

  it('reads the Lead projection from an addressed teammate conversation', () => {
    const b = bench({ sessionId: WORKER, parentSessionId: SESSION })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^worker/u }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^lead/u }))
    expect(b.injected.openTeammate).toHaveBeenCalledWith(WORKER, SESSION)
  })

  it.each([false, true])('accepts shared baselines and late capability updates (teammate page: %s)', (addressed) => {
    const b = bench({
      ...(addressed ? { sessionId: WORKER, parentSessionId: SESSION } : {}),
      projections: {}, openState: 'loading',
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    act(() => { b.session.set({ ...b.session.getSnapshot(), openState: 'open' }) })
    expect(screen.getByRole('status').textContent).toBe(zh.unavailable)
    setProjectionSnapshot(b.sessions, SESSION, { state: 'idle', error: null, values: { agentTeam: team } })
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    setProjectionSnapshot(b.sessions, SESSION, { state: 'idle', error: null, values: {} })
    expect(screen.getByRole('status').textContent).toBe(zh.unavailable)
    setProjection(b.sessions, SESSION, { members: [lead], tasks: [] })
    expect(screen.getByText(zh.empty)).toBeTruthy()
  })

  it('waits for the shared Session list and accepts cached projections without an explicit read', () => {
    const b = bench({ projections: {} })
    b.sessions.update((draft) => { draft.phase = 'pending' })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    act(() => { b.sessions.set({
      ...b.sessions.getSnapshot(), phase: 'ready',
      projectionsBySession: { [SESSION]: { state: 'idle', error: null, values: { agentTeam: team } } },
    }) })
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each([false, true])('ignores unrelated Session updates (teammate page: %s)', (addressed) => {
    const b = bench(addressed ? { sessionId: WORKER, parentSessionId: SESSION } : {})
    const onRender = vi.fn()
    render(<Profiler id="team" onRender={onRender}><TeamAction {...b.props} /></Profiler>)
    openPanel()
    onRender.mockClear()

    act(() => {
      const current = b.sessions.getSnapshot()
      const projectionsBySession = Object.fromEntries(Object.entries(current.projectionsBySession)
        .map(([id, snapshot]) => [id, { ...snapshot }]))
      b.sessions.set({
        ...current,
        byId: { ...current.byId, ['unrelated' as SessionId]: summary('unrelated' as SessionId, true) },
        projectionsBySession: {
          ...projectionsBySession,
          ['unrelated' as SessionId]: { state: 'ready', error: null, values: { agentTeam: { members: [], tasks: [] } } },
        },
      })
      b.statuses.set(new Map([['unrelated' as SessionId, { running: true, pendingInteraction: undefined, completionUnread: false }]]))
    })
    expect(onRender).not.toHaveBeenCalled()

    setProjectionSnapshot(b.sessions, WORKER, {
      state: 'ready', error: null,
      values: { modelSelection: { lastUsed: null, next: { provider: 'p', model: 'updated-worker-model' } } },
    })
    expect(screen.getByRole('button', { name: /worker.*updated-worker-model/u })).toBeTruthy()
    setProjection(b.sessions, SESSION, { ...team, tasks: [{ ...task, subject: 'Updated parent task' }] })
    expect(screen.getByText('Updated parent task')).toBeTruthy()
  })

  it('shows capability absence after a successful read instead of loading forever', () => {
    const b = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: {} } } })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.queryByText(zh.loading)).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Team 暂不可用')
  })

  it('surfaces a Team projection failure beside the last valid state', () => {
    const b = bench({
      projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: { ...team, failure: 'revision is not contiguous' } } } },
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('alert').textContent).toBe('团队持久记录无效：revision is not contiguous')
    expect(screen.getByText('Implement runtime')).toBeTruthy()
  })

  it('renders roster/task state variants and reports navigation failures', () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const b = bench({
      projections: {
        [SESSION]: {
          state: 'ready', error: null,
          values: {
            agentTeam: {
              members: [
                lead,
                worker,
                { id: 'failed-id' as SessionId, name: 'failed-worker', role: 'teammate', phase: 'failed', error: 'provider failed' },
                { id: 'provisioning-id' as SessionId, name: 'provisioning-worker', role: 'teammate', phase: 'provisioning' },
              ],
              tasks: [
                { ...unownedTask, id: 'ready-task' as TeamTaskId, status: 'pending', ready: true },
                { ...unownedTask, id: 'blocked-task' as TeamTaskId, status: 'pending', ready: false, blockedBy: [TASK_1] },
                { ...task, id: 'completed-task' as TeamTaskId, status: 'completed', ownerName: 'worker' },
              ],
            },
          },
        },
      },
    })
    b.injected.openTeammate = vi.fn(() => { throw new Error('navigation failed') })
    render(<TeamAction {...b.props} {...b.injected} />)
    openPanel()
    expect(screen.getByText('provider failed')).toBeTruthy()
    expect(screen.getByText(zh.ready)).toBeTruthy()
    expect(screen.getByText(zh.blocked)).toBeTruthy()
    expect(screen.getAllByText('Owner: 未分配')).toHaveLength(2)
    expect(screen.getByText('Owner: worker')).toBeTruthy()
    const failedMember = screen.getByRole<HTMLButtonElement>('button', { name: /failed-worker/u })
    const provisioningMember = screen.getByRole<HTMLButtonElement>('button', { name: /provisioning-worker/u })
    expect(failedMember.disabled).toBe(true)
    expect(failedMember.querySelector('[data-state="error"]')).not.toBeNull()
    expect(provisioningMember.disabled).toBe(true)
    expect(provisioningMember.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^lead/u }).disabled).toBe(true)
    const tasks = [...document.querySelectorAll('article')]
    expect(tasks.map(card => card.querySelector('[data-state]')?.getAttribute('data-state')))
      .toEqual(['idle', 'warning', 'done'])
    for (const card of tasks) expect(card.querySelector('button, input, select, textarea')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^worker/u }))
    expect(screen.getByRole('alert').textContent).toBe('Error: navigation failed')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /智能体团队/u }))
  })

  it('shows a submitted task awaiting its peer verdict and the recorded verification', () => {
    const b = bench({
      projections: {
        [SESSION]: {
          state: 'ready', error: null,
          values: {
            agentTeam: {
              members: [lead, worker],
              tasks: [
                { ...task, revision: 2, status: 'verifying', verification: { submittedRevision: 2 } },
                {
                  ...task,
                  id: TASK_2,
                  subject: 'Rejected work',
                  revision: 3,
                  verification: {
                    submittedRevision: 2, verifierName: 'worker', verdict: 'rejected', reason: 'the cache never invalidates',
                  },
                },
                {
                  ...task,
                  id: TASK_3,
                  subject: 'Approved work',
                  revision: 4,
                  status: 'completed',
                  verification: { submittedRevision: 3, verifierName: 'lead', verdict: 'approved' },
                },
              ],
            },
          },
        },
      },
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    const [verifying, rejectedTask] = [...document.querySelectorAll('article')]
    expect(verifying?.textContent).toContain(zh['status.verifying'])
    expect(verifying?.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ongoing')
    expect(screen.getByText(`${zh.verification}: ${zh.none}`)).toBeTruthy()
    expect(rejectedTask?.textContent).toContain(zh['status.in_progress'])
    expect(screen.getByText(`${zh.verification}: worker · ${zh['verdict.reject']} — the cache never invalidates`)).toBeTruthy()
    expect(screen.getByText(`${zh.verification}: lead · ${zh['verdict.approve']}`)).toBeTruthy()
    for (const card of [verifying, rejectedTask]) expect(card?.querySelector('button, input, select, textarea')).toBeNull()
  })

  it('closes the panel and clears a navigation failure when the conversation switches sessions', () => {
    const b = bench()
    b.injected.openTeammate = vi.fn(() => { throw new Error('navigation failed') })
    const rendered = render(<TeamAction {...b.props} {...b.injected} />)
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: /^worker/u }))
    expect(screen.getByRole('alert')).toBeTruthy()

    const next = bench({ sessionId: 'next-lead' as SessionId, projections: {}, openState: 'loading' })
    rendered.rerender(<TeamAction {...next.props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    openPanel()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
  })

  it('keeps panel interactions open and dismisses on outside pointer or Escape', () => {
    const b = bench()
    const rendered = render(<TeamAction {...b.props} />)
    const trigger = screen.getByRole('button', { name: /智能体团队/u })
    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog')
    expect(rendered.container.contains(panel)).toBe(false)
    expect(document.activeElement).toBe(panel)
    fireEvent.pointerDown(panel)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(trigger)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('button', { name: /^worker/u }), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: /^worker/u }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([true, false])('clamps a long task description behind an expand toggle (ResizeObserver: %s)', async (resizeObserver) => {
    if (!resizeObserver) vi.stubGlobal('ResizeObserver', undefined)
    const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(120)
    const clientHeight = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(60)
    try {
      render(<TeamAction {...bench().props} />)
      fireEvent.click(screen.getByRole('button', { name: /智能体团队/u }))
      const expand = await screen.findByRole('button', { name: zh['task.expand'] })
      const description = screen.getByText('Build the Team runtime')
      expect(expand.getAttribute('aria-expanded')).toBe('false')
      expect(description.className).not.toBe('')

      fireEvent.click(expand)
      const collapse = screen.getByRole('button', { name: zh['task.collapse'] })
      expect(collapse.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByText('Build the Team runtime').className).toBe('')

      fireEvent.click(collapse)
      expect(screen.getByRole('button', { name: zh['task.expand'] })).toBeTruthy()
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })

  it('opens on hover and preserves the trigger-to-panel crossing grace', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    const b = bench()
    const rendered = render(<TeamAction {...b.props} />)
    const trigger = screen.getByRole('button', { name: /智能体团队/u })
    const root = trigger.parentElement!

    fireEvent.mouseEnter(trigger)
    await advance(149)
    expect(screen.queryByRole('dialog')).toBeNull()
    await advance(1)
    const panel = screen.getByRole('dialog')

    fireEvent.mouseEnter(trigger)
    expect(screen.getByRole('dialog')).toBe(panel)

    fireEvent.mouseLeave(root)
    fireEvent.mouseEnter(panel)
    await advance(120)
    expect(screen.getByRole('dialog')).toBe(panel)

    fireEvent.mouseLeave(panel)
    await advance(119)
    expect(screen.getByRole('dialog')).toBe(panel)
    await advance(1)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root, { relatedTarget: document.body })
    rendered.unmount()
    await advance(150)
  })

  it('pins a click-opened panel through hover-out until explicit dismissal', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    render(<TeamAction {...bench().props} />)
    const trigger = screen.getByRole('button', { name: /智能体团队/u })
    const root = trigger.parentElement!

    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog')
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.mouseEnter(panel)
    fireEvent.mouseLeave(panel)
    await advance(300)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.mouseEnter(trigger)
    await advance(150)
    const hovered = screen.getByRole('dialog')
    fireEvent.click(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.getByRole('dialog')).toBe(hovered)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens by click only while the trigger is collapsed to its icon', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    render(<TeamAction {...bench().props} />)
    const trigger = screen.getByRole('button', { name: /智能体团队/u })
    const label = screen.getByText(zh.trigger)
    const computedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element =>
      element === label ? { display: 'none' } as CSSStyleDeclaration : computedStyle(element))

    fireEvent.mouseEnter(trigger)
    await advance(300)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('keeps projection updates live without polling while pinned', async () => {
    vi.useFakeTimers()
    const b = bench()
    render(<TeamAction {...b.props} />)
    openPanel()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    setProjection(b.sessions, SESSION, { ...team, tasks: [{ ...task, subject: 'Pushed while pinned' }] })
    expect(screen.getByText('Pushed while pinned')).toBeTruthy()
  })

  it('keeps an accessible trigger name when its label is collapsed', () => {
    render(<TeamAction {...bench().props} />)
    screen.getByText(zh.trigger).style.display = 'none'
    expect(screen.getByRole('button', { name: zh.trigger })).toBeTruthy()
  })

  it('dismisses a hovered panel with Escape without stealing composer focus', async () => {
    vi.useFakeTimers()
    render(<><textarea aria-label="Composer" /><TeamAction {...bench().props} /></>)
    const composer = screen.getByRole('textbox')
    composer.focus()
    fireEvent.mouseEnter(screen.getByRole('button', { name: zh.trigger }))
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'a' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(composer)
  })
})

describe('TeamAction room', () => {
  it('reads the room only once the panel opens, through the current conversation', async () => {
    const b = roomBench(room)
    render(<TeamAction {...b.props} />)
    expect(b.injected.loadRoom).not.toHaveBeenCalled()
    openPanel()
    expect(await screen.findByText('the cache serves stale reads')).toBeTruthy()
    expect(b.injected.loadRoom).toHaveBeenCalledOnce()
    expect(b.injected.loadRoom).toHaveBeenCalledWith(SESSION)
    await waitFor(() => { expect(b.injected.followRoom).toHaveBeenCalledOnce() })
    expect(b.injected.followRoom).toHaveBeenCalledWith(SESSION, expect.any(AbortSignal), expect.any(Function))
  })

  it('omits the room section entirely when the composition has no room', async () => {
    const b = roomBench({ enabled: false, participants: [], chair: 'lead', messages: [], proposals: [] })
    render(<TeamAction {...b.props} />)
    openPanel()
    await waitFor(() => { expect(b.injected.loadRoom).toHaveBeenCalledOnce() })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    // A deployment without a room shows the roster and tasks, not an empty room.
    expect(document.querySelector('[data-team-room]')).toBeNull()
    expect(screen.queryByText(zh.transcript)).toBeNull()
    expect(b.injected.followRoom).not.toHaveBeenCalled()
  })

  it('renders the room transcript and each decision with its recorded votes', async () => {
    render(<TeamAction {...roomBench(room).props} />)
    openPanel()

    expect(await screen.findByText('the cache serves stale reads')).toBeTruthy()
    expect(screen.getByText('Adopt a global mutable cache with no invalidation.')).toBeTruthy()
    expect(screen.getByText('proposal-1')).toBeTruthy()
    expect(screen.getByText(zh.revision)).toBeTruthy()
    expect(screen.getByText(zh['phase.rejected'])).toBeTruthy()
    expect(screen.getByText(`${zh['votes.rejections']}: worker`)).toBeTruthy()
    expect(screen.getByText(`${zh['votes.approvals']}: ${zh.none}`)).toBeTruthy()
    // A settled decision awaits nobody, so the panel says so instead of naming
    // reviewers who can no longer change the outcome.
    expect(screen.getByText(`${zh['votes.awaiting']}: ${zh.none}`)).toBeTruthy()
    expect(screen.getByText(`${zh.chair}: lead`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['room.escalate'] })).toBeNull()
  })

  it('labels every decision phase the room can report', async () => {
    const phases = (['open', 'accepted', 'escalated'] as const).map(phase => ({
      ...rejected,
      id: `proposal-${phase}` as RoomProposalView['id'],
      phase,
    }))
    render(<TeamAction {...roomBench({ ...room, proposals: phases }).props} />)
    openPanel()

    expect(await screen.findByText(zh['phase.open'])).toBeTruthy()
    expect(screen.getByText(zh['phase.accepted'])).toBeTruthy()
    expect(screen.getByText(zh['phase.escalated'])).toBeTruthy()
  })

  it('shows why each reviewer stood where it did', async () => {
    const debated: RoomRemoteView = {
      ...room,
      proposals: [{
        ...rejected,
        standings: [
          { reviewer: 'worker', verdict: 'reject', reason: 'the cache never invalidates' },
          { reviewer: 'auditor', verdict: 'approve', reason: 'bounded staleness is acceptable' },
          { reviewer: 'lead', verdict: 'abstain', reason: 'the owner decides' },
        ],
      }],
    }
    render(<TeamAction {...roomBench(debated).props} />)
    openPanel()

    expect(await screen.findByText(`worker · ${zh['verdict.reject']}`)).toBeTruthy()
    expect(screen.getByText('the cache never invalidates')).toBeTruthy()
    expect(screen.getByText(`auditor · ${zh['verdict.approve']}`)).toBeTruthy()
    expect(screen.getByText(`lead · ${zh['verdict.abstain']}`)).toBeTruthy()
  })

  it('names quiet participants and the reviewers that went silent on an escalated decision', async () => {
    const escalated: RoomRemoteView = {
      ...room,
      participants: room.participants.map(participant => ({ ...participant, quiet: participant.name === 'worker' })),
      proposals: [{ ...rejected, phase: 'escalated', stalled: ['worker'] }],
    }
    render(<TeamAction {...roomBench(escalated).props} />)
    openPanel()

    expect(await screen.findByText(`${zh['votes.stalled']}: worker`)).toBeTruthy()
    expect(screen.getByText(`${zh.quiet}: worker`)).toBeTruthy()
  })

  it('claims no silent reviewer while a decision is still being answered', async () => {
    render(<TeamAction {...roomBench(room).props} />)
    openPanel()

    await screen.findByText('proposal-1')
    expect(screen.queryByText(new RegExp(zh['votes.stalled'], 'u'))).toBeNull()
    expect(screen.queryByText(new RegExp(zh.quiet, 'u'))).toBeNull()
  })

  it('reports an empty room without inventing transcript or decisions', async () => {
    render(<TeamAction {...roomBench({ enabled: true, participants: [], chair: 'lead', messages: [], proposals: [] }).props} />)
    openPanel()

    expect(await screen.findByText(zh.noTranscript)).toBeTruthy()
    expect(screen.getByText(zh.noDecisions)).toBeTruthy()
  })

  it('surfaces a room load failure beside the roster', async () => {
    const b = bench({
      injected: {
        loadRoom: vi.fn(() => Promise.resolve({
          ok: false as const,
          error: new RemoteError('gateway/internal', 'room unavailable', {}),
        })),
      },
    })
    render(<TeamAction {...b.props} />)
    openPanel()

    expect((await screen.findByRole('alert')).textContent).toBe('room unavailable (gateway/internal)')
    expect(screen.getByText('Implement runtime')).toBeTruthy()
  })

  it('reports a room read the carrier rejects instead of answering', async () => {
    const thrown = bench({ injected: { loadRoom: vi.fn(() => Promise.reject(new Error('room namespace is not mounted'))) } })
    const view = render(<TeamAction {...thrown.props} />)
    openPanel()
    expect((await screen.findByRole('alert')).textContent).toBe('room namespace is not mounted')
    view.unmount()

    const opaque = bench({ injected: { loadRoom: vi.fn<TeamActionInjected['loadRoom']>().mockRejectedValue('socket closed') } })
    render(<TeamAction {...opaque.props} />)
    openPanel()
    expect((await screen.findByRole('alert')).textContent).toBe('socket closed')
  })

  it('shows a participant streaming live, then its committed utterance', async () => {
    let emit: ((frame: RoomFollowFrame) => void) | undefined
    const followRoom = vi.fn((_sessionId: SessionId, _signal: AbortSignal, frame: (next: RoomFollowFrame) => void) => {
      emit = frame
      return new Promise<void>(() => {})
    })
    render(<TeamAction {...roomBench(room, { followRoom }).props} />)
    openPanel()
    await screen.findByText('the cache serves stale reads')
    await waitFor(() => { expect(emit).toBeDefined() })
    // A followed room opens on its complete view.
    act(() => { emit?.({ type: 'view', view: room }) })

    act(() => { emit?.({ type: 'stream', participant: 'worker', delta: 'stale reads' }) })
    act(() => { emit?.({ type: 'stream', participant: 'worker', delta: ' are' }) })
    expect(screen.getByText('stale reads are')).toBeTruthy()

    // A committed change republishes the whole view, so the live text yields to
    // the durable transcript entry.
    act(() => {
      emit?.({
        type: 'view',
        view: { ...room, messages: [...room.messages, { author: 'worker', text: 'stale reads are a bug' }] },
      })
    })
    expect(screen.getByText('stale reads are a bug')).toBeTruthy()
    expect(screen.queryByText('stale reads are')).toBeNull()
  })

  it('keeps a live answer while another participant commits its own', async () => {
    let emit: ((frame: RoomFollowFrame) => void) | undefined
    const followRoom = vi.fn((_sessionId: SessionId, _signal: AbortSignal, frame: (next: RoomFollowFrame) => void) => {
      emit = frame
      return new Promise<void>(() => {})
    })
    render(<TeamAction {...roomBench(room, { followRoom }).props} />)
    openPanel()
    await screen.findByText('the cache serves stale reads')
    await waitFor(() => { expect(emit).toBeDefined() })
    act(() => { emit?.({ type: 'view', view: room }) })

    act(() => { emit?.({ type: 'stream', participant: 'worker', delta: 'a long answer' }) })
    act(() => { emit?.({ type: 'stream', participant: 'lead', delta: 'a short note' }) })
    // A change that commits no utterance, such as a review, leaves both streams live.
    act(() => { emit?.({ type: 'view', view: { ...room, chair: 'worker' } }) })
    expect(screen.getByText('a long answer')).toBeTruthy()
    expect(screen.getByText('a short note')).toBeTruthy()
    // The Lead's utterance commits first; the worker is still answering.
    act(() => {
      emit?.({
        type: 'view',
        view: { ...room, messages: [...room.messages, { author: 'lead', text: 'a short note, committed' }] },
      })
    })
    act(() => { emit?.({ type: 'stream', participant: 'worker', delta: ' continues' }) })
    expect(screen.getByText('a long answer continues')).toBeTruthy()
    expect(screen.queryByText('a short note')).toBeNull()
    expect(screen.getByText('a short note, committed')).toBeTruthy()
  })

  it('clears live text whose commit a room read showed before the follow delivered it', async () => {
    let emit: ((frame: RoomFollowFrame) => void) | undefined
    const followRoom = vi.fn((_sessionId: SessionId, _signal: AbortSignal, frame: (next: RoomFollowFrame) => void) => {
      emit = frame
      return new Promise<void>(() => {})
    })
    const committed: RoomRemoteView = {
      ...room,
      messages: [...room.messages, { author: 'worker', text: 'stale reads are a bug' }],
    }
    const loadRoom = vi.fn<TeamActionInjected['loadRoom']>()
      .mockResolvedValueOnce({ ok: true, value: room })
      .mockResolvedValue({ ok: true, value: committed })
    const proposeDecision = vi.fn(() => Promise.resolve({ ok: true as const, value: rejected }))
    render(<TeamAction {...bench({ injected: { loadRoom, followRoom, proposeDecision } }).props} />)
    openPanel()
    await screen.findByText('the cache serves stale reads')
    await waitFor(() => { expect(emit).toBeDefined() })
    act(() => { emit?.({ type: 'view', view: room }) })
    act(() => { emit?.({ type: 'stream', participant: 'worker', delta: 'stale reads are' }) })

    // A panel action re-reads the room, and the read lands before the follow delivers the same commit.
    fireEvent.change(screen.getByRole('textbox', { name: zh['room.statement'] }), {
      target: { value: 'adopt the panel path' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['room.propose'] }))
    expect(await screen.findByText('stale reads are a bug')).toBeTruthy()
    act(() => { emit?.({ type: 'view', view: committed }) })
    expect(screen.queryByText('stale reads are')).toBeNull()
  })

  it('stops following the room when the panel closes', async () => {
    let signal: AbortSignal | undefined
    const followRoom = vi.fn((_sessionId: SessionId, next: AbortSignal) => {
      signal = next
      return new Promise<void>(() => {})
    })
    render(<TeamAction {...roomBench(room, { followRoom }).props} />)
    openPanel()
    await waitFor(() => { expect(signal).toBeDefined() })
    expect(signal?.aborted).toBe(false)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(signal?.aborted).toBe(true)
  })

  it('grants the floor, opens a decision, and hands one to the human', async () => {
    const open: RoomRemoteView = { ...room, proposals: [{ ...rejected, phase: 'open', rejections: [], awaiting: ['worker'] }] }
    const promptParticipant = vi.fn((..._args: Parameters<TeamActionInjected['promptParticipant']>) =>
      Promise.resolve({
        ok: true as const,
        value: { messageId: 'message-1' as RoomPromptResult['messageId'], status: 'accepted' as const },
      }))
    const proposeDecision = vi.fn((..._args: Parameters<TeamActionInjected['proposeDecision']>) =>
      Promise.resolve({ ok: true as const, value: open.proposals[0]! }))
    const escalateDecision = vi.fn((..._args: Parameters<TeamActionInjected['escalateDecision']>) =>
      Promise.resolve({ ok: true as const, value: { ...open.proposals[0]!, phase: 'escalated' as const } }))
    const b = roomBench(open, { promptParticipant, proposeDecision, escalateDecision })
    render(<TeamAction {...b.props} />)
    openPanel()
    await screen.findByText('the cache serves stale reads')

    // The panel refuses incomplete instructions before the Host is asked.
    fireEvent.click(screen.getByRole('button', { name: zh['room.propose'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh['room.statementRequired'])
    expect(proposeDecision).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['room.prompt'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh['room.promptRequired'])
    expect(promptParticipant).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: zh['room.statement'] }), {
      target: { value: 'adopt the panel path' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['room.propose'] }))
    await waitFor(() => { expect(proposeDecision).toHaveBeenCalledOnce() })
    expect(proposeDecision.mock.calls[0]).toEqual([SESSION, { statement: 'adopt the panel path' }])
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(b.injected.loadRoom).toHaveBeenCalledTimes(2)

    fireEvent.change(screen.getByRole('combobox', { name: zh['room.promptTarget'] }), {
      target: { value: 'worker' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: zh['room.instruction'] }), {
      target: { value: 'give your view' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['room.prompt'] }))
    await waitFor(() => { expect(promptParticipant).toHaveBeenCalledOnce() })
    expect(promptParticipant.mock.calls[0]).toEqual([SESSION, { target: 'worker', instruction: 'give your view' }])

    // An escalation carries the reason the human reads.
    const escalate = screen.getByRole('button', { name: zh['room.escalate'] })
    fireEvent.click(escalate)
    expect(escalate.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh['room.escalateSubmit'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh['room.reasonRequired'])
    expect(escalateDecision).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: zh['room.reason'] }), {
      target: { value: 'the reviewers disagree' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['room.escalateSubmit'] }))
    await waitFor(() => { expect(escalateDecision).toHaveBeenCalledOnce() })
    expect(escalateDecision.mock.calls[0]).toEqual([SESSION, { proposalId: PROPOSAL, reason: 'the reviewers disagree' }])
    await waitFor(() => { expect(screen.queryByRole('textbox', { name: zh['room.reason'] })).toBeNull() })
  })

  it('keeps the prompt and escalation drafts when the Host refuses them', async () => {
    const open: RoomRemoteView = { ...room, proposals: [{ ...rejected, phase: 'open', rejections: [], awaiting: ['worker'] }] }
    const promptParticipant = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: new RemoteError('gateway/internal', 'floor refused', {}) })
      .mockRejectedValueOnce('socket closed')
    const escalateDecision = vi.fn(() =>
      Promise.resolve({ ok: false as const, error: new RemoteError('gateway/internal', 'escalation refused', {}) }))
    render(<TeamAction {...roomBench(open, { promptParticipant, escalateDecision }).props} />)
    openPanel()
    await screen.findByText('the cache serves stale reads')

    fireEvent.change(screen.getByRole('combobox', { name: zh['room.promptTarget'] }), { target: { value: 'worker' } })
    const instruction = screen.getByRole<HTMLInputElement>('textbox', { name: zh['room.instruction'] })
    fireEvent.change(instruction, { target: { value: 'give your view' } })
    fireEvent.click(screen.getByRole('button', { name: zh['room.prompt'] }))
    expect((await screen.findByRole('alert')).textContent).toBe('floor refused (gateway/internal)')
    // A carrier that rejects with a non-Error value still reaches the reader.
    fireEvent.click(screen.getByRole('button', { name: zh['room.prompt'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('socket closed') })
    expect(instruction.value).toBe('give your view')

    const escalate = screen.getByRole('button', { name: zh['room.escalate'] })
    fireEvent.click(escalate)
    const reason = screen.getByRole<HTMLInputElement>('textbox', { name: zh['room.reason'] })
    fireEvent.change(reason, { target: { value: 'the reviewers disagree' } })
    fireEvent.click(screen.getByRole('button', { name: zh['room.escalateSubmit'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('escalation refused (gateway/internal)') })
    expect(reason.value).toBe('the reviewers disagree')
    // The escalate control toggles its form closed again.
    fireEvent.click(escalate)
    expect(escalate.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox', { name: zh['room.reason'] })).toBeNull()
  })

  it('keeps the last room view when the live follow ends', async () => {
    const followRoom = vi.fn(() => Promise.reject(new Error('stream closed')))
    render(<TeamAction {...roomBench(room, { followRoom }).props} />)
    openPanel()
    expect(await screen.findByText('the cache serves stale reads')).toBeTruthy()
    await waitFor(() => { expect(followRoom).toHaveBeenCalledOnce() })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('the cache serves stale reads')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a room read that settles after the panel closed', async () => {
    const pending: Array<PromiseWithResolvers<Awaited<ReturnType<TeamActionInjected['loadRoom']>>>> = []
    const loadRoom = vi.fn(() => {
      const next = Promise.withResolvers<Awaited<ReturnType<TeamActionInjected['loadRoom']>>>()
      pending.push(next)
      return next.promise
    })
    const followRoom = vi.fn(() => new Promise<void>(() => {}))
    render(<TeamAction {...bench({ injected: { loadRoom, followRoom } }).props} />)
    openPanel()
    await waitFor(() => { expect(loadRoom).toHaveBeenCalledOnce() })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    openPanel()
    await waitFor(() => { expect(loadRoom).toHaveBeenCalledTimes(2) })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await act(async () => {
      pending[0]!.resolve({ ok: true as const, value: room })
      pending[1]!.reject(new Error('late failure'))
      await Promise.resolve()
    })
    openPanel()
    await waitFor(() => { expect(loadRoom).toHaveBeenCalledTimes(3) })
    // Neither stale answer reached the reopened panel.
    expect(screen.queryByText('the cache serves stale reads')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(followRoom).not.toHaveBeenCalled()
  })

  it('reports a rejected room action and a thrown carrier failure without clearing the draft', async () => {
    const proposeDecision = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: new RemoteError('gateway/internal', 'room refused', {}) })
      .mockRejectedValueOnce(new Error('carrier lost'))
    render(<TeamAction {...roomBench(room, { proposeDecision }).props} />)
    openPanel()
    await screen.findByText('the cache serves stale reads')

    const statement = screen.getByRole<HTMLInputElement>('textbox', { name: zh['room.statement'] })
    fireEvent.change(statement, { target: { value: 'adopt the panel path' } })
    fireEvent.click(screen.getByRole('button', { name: zh['room.propose'] }))
    expect((await screen.findByRole('alert')).textContent).toBe('room refused (gateway/internal)')
    fireEvent.click(screen.getByRole('button', { name: zh['room.propose'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('carrier lost') })
    expect(statement.value).toBe('adopt the panel path')
  })
})

it('keeps the hover panel open when the pointer returns directly to its trigger', async () => {
  vi.useFakeTimers()
  render(<TeamAction {...bench().props} />)
  const trigger = screen.getByRole('button', { name: zh.trigger })
  fireEvent.mouseOver(trigger, { relatedTarget: document.body })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  const panel = screen.getByRole('dialog')
  fireEvent.mouseOut(trigger, { relatedTarget: panel })
  fireEvent.mouseOver(panel, { relatedTarget: trigger })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(screen.getByRole('dialog')).toBe(panel)
  fireEvent.mouseOut(panel, { relatedTarget: trigger })
  fireEvent.mouseOver(trigger, { relatedTarget: panel })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(screen.getByRole('dialog')).toBe(panel)
})

it('cancels pending hover dismissal when the trigger is activated from the keyboard', async () => {
  vi.useFakeTimers()
  render(<TeamAction {...bench().props} />)
  const trigger = screen.getByRole('button', { name: zh.trigger })
  trigger.focus()
  fireEvent.mouseOver(trigger, { relatedTarget: document.body })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  fireEvent.mouseOut(trigger, { relatedTarget: document.body })
  fireEvent.click(trigger, { detail: 0 })
  await act(async () => { await vi.advanceTimersByTimeAsync(120) })
  expect(screen.getByRole('dialog')).toBe(document.activeElement)
})

it('updates expansion availability on paragraph resize and disconnects its observer', () => {
  const observers: TestResizeObserver[] = []
  class TestResizeObserver implements ResizeObserver {
    observe = vi.fn<ResizeObserver['observe']>()
    unobserve = vi.fn<ResizeObserver['unobserve']>()
    disconnect = vi.fn()
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this) }
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(36)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(36)
  const view = render(<TeamAction {...bench().props} />)
  openPanel()
  const paragraph = screen.getByText('Build the Team runtime')
  const observer = observers.find(item => item.observe.mock.calls.some(([target]) => target === paragraph))!
  expect(observer).toBeDefined()
  expect(screen.queryByRole('button', { name: zh['task.expand'] })).toBeNull()
  scrollHeight.mockReturnValue(72)
  act(() => { observer.callback([], observer) })
  expect(screen.getByRole('button', { name: zh['task.expand'] })).toBeTruthy()
  scrollHeight.mockReturnValue(36)
  act(() => { observer.callback([], observer) })
  expect(screen.queryByRole('button', { name: zh['task.expand'] })).toBeNull()
  view.unmount()
  expect(observer.disconnect).toHaveBeenCalledOnce()
})
