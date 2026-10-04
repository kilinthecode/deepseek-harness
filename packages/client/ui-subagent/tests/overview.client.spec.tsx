// @vitest-environment jsdom
/** Overview child membership, completion evidence, navigation, and refresh. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SubagentOverview } from '../src/client/SubagentOverview.tsx'
import { en } from '../src/client/locales.ts'

const PARENT = SessionId('parent')
const CHILD = SessionId('child')
const DONE = SessionId('done')
const IDLE = SessionId('idle')
afterEach(cleanup)
const unused = (): never => { throw new Error('Overview fixture does not use this framework share') }
const standard = {
  usePanelInfo: unused, useSessionRetainInfo: unused, useWorkspaces: unused, useResource: unused,
  useProjection: unused, useConversation: unused, useInput: unused, useTrajectory: unused, useSession: unused,
  inputActions: { captureInsertion: unused, insertText: unused, persistDraft: () => undefined, setDraft: unused, addAttachments: unused,
    removeAttachment: unused, pruneAttachments: unused, submit: unused },
}

function mount(state: 'ready' | 'loading' | 'error' = 'ready') {
  const child = (id: typeof CHILD, running: boolean, completed?: boolean) => ({
    id, title: id, displayTitle: id, retainedBy: {}, updatedAt: 1, blank: false, running,
    projectionValues: { subagentTiming: { settledMs: 10, ...(completed === undefined ? {} : { lastTurnCompleted: completed }) } },
  })
  const sessions: SessionListState = { ids: [], phase: 'ready',
    byId: { [CHILD]: child(CHILD, true), [DONE]: child(DONE, false, true), [IDLE]: child(IDLE, false),
      [SessionId('orphan')]: child(SessionId('orphan'), false, true) },
    projectionsBySession: { [PARENT]: { state, error: null, values: { subagentCatalog: [
      { id: CHILD, mode: 'continuable', label: 'Research', createdAt: 1 },
      { id: DONE, mode: 'one-shot', label: 'Review', createdAt: 1 },
      { id: IDLE, mode: 'continuable', label: 'Waiting', createdAt: 1 },
    ] } } },
  }
  const openChild = vi.fn(), openChildAside = vi.fn(), refreshProjection = vi.fn()
  const props: Parameters<typeof SubagentOverview>[0] = { ...standard, sessionId: PARENT, t: makeTranslate(en),
    useChat: unused, useSessions: selector => selector(sessions), useSessionStatus: selector => selector(new Map()),
    openChild, openChildAside, refreshProjection, openResource: vi.fn(),
  }
  return { ...render(<SubagentOverview {...props} />), openChild, openChildAside, refreshProjection }
}
describe('task subagent overview', () => {
  it('distinguishes running, done, and inactive children using catalog membership and completion evidence', () => {
    const view = mount()
    expect(view.getByText('1 running')).toBeDefined()
    expect(view.getByText('1 done')).toBeDefined()
    expect(view.getByText('1 inactive')).toBeDefined()
    expect(view.queryByText('orphan')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Research running' }))
    expect(view.openChild).toHaveBeenCalledWith({ parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable' })
    fireEvent.click(view.getByRole('button', { name: 'Open Review in sidebar' }))
    expect(view.openChildAside).toHaveBeenCalledWith({ parentSessionId: PARENT, childSessionId: DONE, mode: 'one-shot' })
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(view.refreshProjection).not.toHaveBeenCalled()
  })
  it('retains known rows during refresh and errors and keeps retry available', () => {
    const pending = mount('loading')
    expect(pending.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(pending.getByText('Research')).toBeDefined()
    cleanup()
    const failed = mount('error')
    expect(failed.getByText('Unable to load subagents')).toBeDefined()
    expect(failed.getByText('Research')).toBeDefined()
    fireEvent.click(failed.getByRole('button', { name: 'Retry' }))
    expect(failed.refreshProjection).toHaveBeenCalledWith(PARENT)
  })
})
