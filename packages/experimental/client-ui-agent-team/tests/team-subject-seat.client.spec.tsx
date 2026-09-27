// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRetainInfo, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TeamSubjectSeat, type TeamStartResult, type TeamSubjectSeatProps } from '../src/client/TeamSubjectSeat.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SESSION = 'lead' as SessionId

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION,
    pendingSubmissions: [],
    running: false,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: true,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
    ...overrides,
  }
}

function bench(options: {
  session?: Partial<SessionSnapshot>
  retain?: SessionRetainInfo | undefined
  start?: (subject: string) => Promise<TeamStartResult>
} = {}) {
  const retain = createSnapshotStore<SessionRetainInfo | undefined>(
    'retain' in options ? options.retain : { referenceCount: 1, retainedBy: { mainView: 1 } },
  )
  const startTeam = vi.fn(options.start ?? (() => Promise.resolve<TeamStartResult>({ kind: 'started' })))
  const props = {
    session: snapshot(options.session),
    sessionId: SESSION,
    useSessionRetainInfo: bindSnapshotSelector(retain),
    startTeam,
    t: makeTranslate(zh, commonZh),
  } as TeamSubjectSeatProps
  return { props, startTeam, retain }
}

function field(): HTMLInputElement {
  return screen.getByRole('textbox', { name: zh['subject.field'] })
}

function startButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: zh['subject.start'] })
}

describe('TeamSubjectSeat', () => {
  it('starts the Team on the trimmed subject and leaves the dock once it started', async () => {
    const b = bench()
    render(<TeamSubjectSeat {...b.props} />)
    expect(startButton().disabled).toBe(true)
    fireEvent.change(field(), { target: { value: '  Ship the parser  ' } })
    expect(startButton().disabled).toBe(false)
    fireEvent.click(startButton())
    await waitFor(() => { expect(document.querySelector('[data-team-subject]')).toBeNull() })
    expect(b.startTeam).toHaveBeenCalledExactlyOnceWith('Ship the parser')
  })

  it.each([
    ['a conversation that is no longer blank', { session: { blank: false } }],
    ['a teammate conversation', { session: { subagent: { address: { parentSessionId: 'x' as SessionId, childSessionId: SESSION, mode: 'continuable' as const } } } }],
    ['a conversation whose first prompt was already sent', { session: { promptAttempted: true } }],
    ['a conversation outside the main view', { retain: { referenceCount: 1, retainedBy: {} } }],
    ['a conversation without retain information', { retain: undefined }],
  ] as const)('renders nothing for %s', (_label, options) => {
    render(<TeamSubjectSeat {...bench(options).props} />)
    expect(document.querySelector('[data-team-subject]')).toBeNull()
  })

  it('submits only a non-empty subject, once, and keeps the draft while it waits', async () => {
    let settle: (result: TeamStartResult) => void = () => {}
    const b = bench({ start: () => new Promise<TeamStartResult>((resolve) => { settle = resolve }) })
    render(<TeamSubjectSeat {...b.props} />)
    fireEvent.change(field(), { target: { value: '   ' } })
    fireEvent.submit(field().closest('form')!)
    expect(b.startTeam).not.toHaveBeenCalled()

    fireEvent.change(field(), { target: { value: 'Ship' } })
    const form = field().closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(b.startTeam).toHaveBeenCalledOnce()
    expect(field().disabled).toBe(true)
    expect(startButton().disabled).toBe(true)
    await act(async () => { settle({ kind: 'refused', text: 'subject exceeds 200 characters' }) })
    expect(field().value).toBe('Ship')
    expect(field().disabled).toBe(false)
  })

  it('shows a Host refusal in place and clears it on the next attempt', async () => {
    const results: TeamStartResult[] = [
      { kind: 'refused', text: 'Only the Team Lead conversation can start an Agent Team.' },
      { kind: 'unavailable' },
    ]
    const b = bench({ start: () => Promise.resolve(results.shift()!) })
    render(<TeamSubjectSeat {...b.props} />)
    fireEvent.change(field(), { target: { value: 'Ship' } })
    fireEvent.click(startButton())
    expect((await screen.findByRole('alert')).textContent).toBe('Only the Team Lead conversation can start an Agent Team.')
    fireEvent.click(startButton())
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh['subject.unavailable']) })
    expect(document.querySelector('[data-team-subject]')).not.toBeNull()
  })
})
