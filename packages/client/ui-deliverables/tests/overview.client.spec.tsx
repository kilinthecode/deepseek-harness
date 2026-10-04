// @vitest-environment jsdom
/** Task overview preserves turn coordinates, coding visibility, and declared output paths. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationTurnDataMap, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { EMPTY_CHAT_SNAPSHOT } from '../../ui-chat/src/client/contract/snapshot.ts'
import { changesReviewAddress, changesSummaryUrl, type ChangesSummary } from '../src/changes.ts'
import { DeliverablesOverview } from '../src/client/DeliverablesOverview.tsx'
import { en } from '../src/client/locales.ts'

const SESSION = SessionId('overview')
afterEach(cleanup)
const unused = (): never => { throw new Error('Overview fixture does not use this framework share') }
const standard = {
  usePanelInfo: unused, useSessionRetainInfo: unused, useWorkspaces: unused, useResource: unused,
  useProjection: unused, useConversation: unused, useInput: unused, useTrajectory: unused, useSession: unused,
  inputActions: { captureInsertion: unused, insertText: unused, persistDraft: () => undefined, setDraft: unused, addAttachments: unused,
    removeAttachment: unused, pruneAttachments: unused, submit: unused },
}

function turn(number: number, seq: number, status: TurnLocation['status'] = 'closed', paths = ['out/report.md']): TurnLocation {
  const values: Partial<ConversationTurnDataMap> = { deliverables: { produced: [], changes: { seq },
    presented: paths.map((path, index) => ({ path, seq: seq - 1, index })) } }
  return { turn: number, status, start: undefined, end: undefined, steps: [], data: {
    get: key => values[key], source: key => ({ getSnapshot: () => values[key], subscribe: () => () => {} }),
  } }
}
function mount(coding = true, missing = false) {
  const chat = createSnapshotStore({ ...EMPTY_CHAT_SNAPSHOT, timeline: {
    turnOrder: [1, 2, 3], turns: new Map([[1, turn(1, 10)], [2, turn(2, 20)], [3, turn(3, 30, 'open')]]),
  } })
  const summary = (turn: number): ChangesSummary => ({ turn, total: 1, added: turn + 2, deleted: 1,
    files: [{ path: 'src/main.ts', display: 'src/main.ts', added: turn + 2, deleted: 1 }] })
  const summaries = createSnapshotStore<Record<string, ChangesSummary | 'missing' | 'loading'>>({
    [changesSummaryUrl(SESSION, 10)]: summary(1), [changesSummaryUrl(SESSION, 20)]: missing ? 'missing' : summary(2),
  })
  const sessions: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const openResource = vi.fn()
  const loadChangesSummary = vi.fn(async () => {})
  const props: Parameters<typeof DeliverablesOverview>[0] = {
    ...standard, sessionId: SESSION, t: makeTranslate(en), openResource,
    useChat: bindSnapshotSelector(chat), useSessions: selector => selector(sessions),
    useSessionStatus: unused, useShowCodeDiff: selector => selector(coding),
    useChangesSummary: bindSnapshotSelector(summaries), loadChangesSummary,
  }
  return { ...render(<DeliverablesOverview {...props} />), chat, summaries, openResource, loadChangesSummary }
}
describe('task deliverables overview', () => {
  it('selects the latest completed turn and opens file reviews with their original coordinates', () => {
    const view = mount()
    expect(view.getByText('Turn 2')).toBeDefined()
    expect(view.queryByText('Turn 3')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'View changes to src/main.ts' }))
    expect(view.openResource).toHaveBeenLastCalledWith(
      changesReviewAddress({ sessionId: SESSION, turn: 2, seq: 20 }), { params: { index: 0 } })
    fireEvent.click(view.getByRole('button', { name: /Loaded change history/ }))
    fireEvent.click(view.getByRole('button', { name: 'Turn 1' }))
    fireEvent.click(view.getByRole('button', { name: 'View changes to src/main.ts' }))
    expect(view.openResource).toHaveBeenLastCalledWith(
      changesReviewAddress({ sessionId: SESSION, turn: 1, seq: 10 }), { params: { index: 0 } })
  })
  it('deduplicates declared paths and opens their shared preview', () => {
    const view = mount()
    expect(view.getAllByRole('button', { name: 'Open out/report.md in sidebar' })).toHaveLength(1)
    fireEvent.click(view.getByRole('button', { name: 'Open out/report.md in sidebar' }))
    expect(view.openResource).toHaveBeenCalledWith('dsh-resource://file/session/overview/out/report.md')
  })
  it('keeps coding facts hidden without reading summaries and retains output access', () => {
    const view = mount(false)
    expect(view.getByText('Enable Coding Tools in Settings to review changes')).toBeDefined()
    expect(view.queryByText('Turn 2')).toBeNull()
    expect(view.queryByText('+4')).toBeNull()
    expect(view.loadChangesSummary).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: 'Open out/report.md in sidebar' })).toBeDefined()
  })
  it('folds long output lists and preserves preview actions after expansion', () => {
    const view = mount(false)
    act(() => { view.chat.set({ ...view.chat.getSnapshot(), timeline: { turnOrder: [1],
      turns: new Map([[1, turn(1, 10, 'closed', ['out/a.md', 'out/b.md', 'out/c.md', 'out/d.md', 'out/e.md'])]]),
    } }) })
    expect(view.getAllByRole('button', { name: /^Open out\// })).toHaveLength(4)
    const disclosure = view.getByRole('button', { name: 'View all 5 outputs' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)
    expect(view.getAllByRole('button', { name: /^Open out\// })).toHaveLength(5)
    fireEvent.click(view.getByRole('button', { name: 'Open out/e.md in sidebar' }))
    expect(view.openResource).toHaveBeenCalledWith('dsh-resource://file/session/overview/out/e.md')
    fireEvent.click(view.getByRole('button', { name: 'Show fewer outputs' }))
    expect(view.queryByRole('button', { name: 'Open out/e.md in sidebar' })).toBeNull()
  })
  it('shows unavailable comparisons and follows later completed turns', () => {
    const view = mount(true, true)
    expect(view.getByText('Comparison unavailable')).toBeDefined()
    act(() => { view.summaries.set({ ...view.summaries.getSnapshot(), [changesSummaryUrl(SESSION, 30)]: {
      turn: 3, total: 0, added: 0, deleted: 0, files: [],
    } }); view.chat.set({ ...view.chat.getSnapshot(), timeline: { turnOrder: [1, 2, 3],
      turns: new Map([[1, turn(1, 10)], [2, turn(2, 20)], [3, turn(3, 30)]]),
    } }) })
    expect(view.getByText('Turn 3')).toBeDefined()
    expect(view.queryByText('Comparison unavailable')).toBeNull()
  })
})
