/** Recorded turn comparisons and declared outputs in the session's task overview. */
import { useEffect, useId, useMemo, useState } from 'react'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { FileTypeIcon, IconChevronDownOutlineRegular, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeliverablesInjected } from './Deliverables.tsx'
import type { PresentedPath } from './turn-deliverables.ts'
import { changesReviewAddress, changesSummaryUrl } from '../changes.ts'
import type { NS } from './locales.ts'
import css from './DeliverablesOverview.module.css'

/** Shared change cache and coding preference, supplied by the deliverables owner. */
export type DeliverablesOverviewInjected = Pick<DeliverablesInjected, 'loadChangesSummary'> & {
  hooks: Pick<DeliverablesInjected['hooks'], 'changesSummary' | 'showCodeDiff'>
}

type OverviewProps = PropsRuntime<'sidebar.right.tab.guide.section'>
  & PropsLocale<typeof NS> & InjectFace<DeliverablesOverviewInjected>

const GROUPED = new Intl.NumberFormat('en-US')

/**
 * Render the selected recorded turn's comparison and the latest declaration of each loaded output path.
 * @param props - session hooks, change cache, tab-local resource opener, and localized copy.
 * @returns compact changes and output sections.
 */
export function DeliverablesOverview({
  sessionId, useChat, useSessions, useShowCodeDiff, useChangesSummary, loadChangesSummary, openResource, t,
}: OverviewProps) {
  const chat = useChat(value => value)
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const showCodeDiff = useShowCodeDiff(value => value)
  const facts = useMemo(() => {
    const turns: { turn: number; seq: number }[] = []
    const outputs = new Map<string, PresentedPath>()
    for (const number of chat.timeline.turnOrder) {
      const turn = chat.timeline.turns.get(number)
      const data = turn?.data.get('deliverables')
      if (turn?.status === 'closed' && data?.changes !== undefined) turns.push({ turn: number, seq: data.changes.seq })
      for (const file of data?.presented ?? []) outputs.set(file.path, file)
    }
    return { turns: turns.reverse(), outputs: [...outputs.values()] }
  }, [chat])
  const [selectedSeq, setSelectedSeq] = useState<number>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [outputsOpen, setOutputsOpen] = useState(false)
  const historyId = useId()
  const outputsId = useId()
  const selected = facts.turns.find(turn => turn.seq === selectedSeq) ?? facts.turns[0]
  const summary = useChangesSummary(state => showCodeDiff && selected !== undefined
    ? state[changesSummaryUrl(sessionId, selected.seq)] : undefined)
  useEffect(() => {
    if (showCodeDiff && selected !== undefined && summary === undefined) void loadChangesSummary(sessionId, selected.seq)
  }, [showCodeDiff, selected, summary, sessionId, loadChangesSummary])
  const served = typeof summary === 'object' ? summary : undefined
  const pending = summary === 'loading' || summary === undefined
  return <>
    <section className={css.section} data-task-changes>
      <div className={css.heading}>
        <h3>{t('overview.changes')}</h3>
        {served !== undefined && <span className={css.counts}>
          <span className={css.added}>{t('changes.added', { count: GROUPED.format(served.added) })}</span>
          <span className={css.deleted}>{t('changes.deleted', { count: GROUPED.format(served.deleted) })}</span>
        </span>}
      </div>
      {!showCodeDiff ? <p className={css.empty}>{t('overview.codingOff')}</p>
        : selected === undefined ? <p className={css.empty}>{t('overview.noChanges')}</p>
          : <>
            <button type="button" className={css.row} onClick={() => { openResource(changesReviewAddress({ sessionId, ...selected }), { params: { index: 0 } }) }}>
              <span className={css.rowText}>{t('overview.turn', { turn: selected.turn })}</span>
              {!pending && <span className={css.secondary}>{served === undefined
                ? t('overview.expired') : t('changes.title', { count: String(served.total) })}</span>}
            </button>
            {pending && <div className={css.skeleton} role="status" aria-label={t('diff.loading')}><span /><span /></div>}
            {served !== undefined && <ul className={css.files}>
              {served.files.slice(0, 4).map((file, index) => <li key={file.path}>
                <button type="button" className={css.row}
                  aria-label={t('changes.viewDiff', { name: file.display })}
                  onClick={() => { openResource(changesReviewAddress({ sessionId, ...selected }), { params: { index } }) }}>
                  <PathLabel path={file.display} className={css.path} />
                  <span className={css.counts}>
                    {file.binary || file.oversized ? <span className={css.secondary}>{t(file.binary ? 'changes.binary' : 'changes.oversized')}</span> : <>
                      <span className={css.added}>{t('changes.added', { count: GROUPED.format(file.added) })}</span>
                      <span className={css.deleted}>{t('changes.deleted', { count: GROUPED.format(file.deleted) })}</span>
                    </>}
                  </span>
                </button>
              </li>)}
            </ul>}
            {facts.turns.length > 1 && <>
              <button type="button" className={css.disclosure} aria-expanded={historyOpen} aria-controls={historyId}
                onClick={() => { setHistoryOpen(value => !value) }}>
                <span>{t('overview.history', { count: facts.turns.length })}</span>
                <IconChevronDownOutlineRegular className={historyOpen ? css.expanded : undefined} />
              </button>
              {historyOpen && <ul id={historyId} className={css.files}>
                {facts.turns.map(turn => <li key={turn.seq}>
                  <button type="button" className={css.row} aria-pressed={turn.seq === selected.seq}
                    onClick={() => { setSelectedSeq(turn.seq) }}>
                    {t('overview.turn', { turn: turn.turn })}
                  </button>
                </li>)}
              </ul>}
            </>}
          </>}
    </section>
    <section className={css.section} data-task-outputs>
      <div className={css.heading}><h3>{t('overview.outputs')}</h3><span className={css.secondary}>{facts.outputs.length || ''}</span></div>
      {facts.outputs.length === 0 ? <p className={css.empty}>{t('overview.noOutputs')}</p>
        : <ul id={outputsId} className={css.files}>
          {(outputsOpen ? facts.outputs : facts.outputs.slice(0, 4)).map(file => <li key={file.path}>
            <button type="button" className={css.row} aria-label={t('presented.previewButton', { name: file.path })}
              onClick={() => { openResource(fileAddressFor(sessionId, cwd, file.path)) }}>
              <FileTypeIcon path={file.path} size={18} />
              <PathLabel path={file.path} className={css.path} />
            </button>
          </li>)}</ul>}
      {facts.outputs.length > 4 && <button type="button" className={css.disclosure} aria-expanded={outputsOpen} aria-controls={outputsId}
        onClick={() => { setOutputsOpen(value => !value) }}>
        <span>{t(outputsOpen ? 'overview.outputsCollapse' : 'overview.outputsAll', { count: facts.outputs.length })}</span>
        <IconChevronDownOutlineRegular className={outputsOpen ? css.expanded : undefined} />
      </button>}
    </section>
  </>
}
