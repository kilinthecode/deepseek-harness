/** Projection-backed direct children in the session's task overview. */
import { useEffect, useId, useState } from 'react'
import { IconChevronDownOutlineRegular, IconPanelLeftOutlineRegular, IconRefreshOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentCatalogInjected } from './SubagentHeaderLineage.tsx'
import { NS } from './locales.ts'
import css from './SubagentOverview.module.css'

type OverviewProps = PropsRuntime<'sidebar.right.tab.guide.section'> & SubagentCatalogInjected & PropsLocale<typeof NS>

/**
 * Render authoritative direct-child membership, completion evidence, and main/aside navigation.
 * @param props - catalog and status hooks, child actions, and localized copy.
 * @returns the subagent section, retaining known rows during refresh or failure.
 */
export function SubagentOverview({
  sessionId, useSessions, useSessionStatus, openChild, openChildAside, refreshProjection, t,
}: OverviewProps) {
  const projection = useSessions(state => state.projectionsBySession[sessionId])
  const summaries = useSessions(state => state.byId)
  const statuses = useSessionStatus(value => value)
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const entries = projection?.values.subagentCatalog ?? []
  const loading = projection?.state !== 'error' && entries.length === 0 && (projection === undefined || projection.state === 'loading'
    || (projection.state === 'idle' && projection.values.subagentCatalog === undefined))
  const running = (id: typeof sessionId): boolean => (statuses.get(id)?.running ?? summaries[id]?.running) === true
  const completed = (id: typeof sessionId): boolean => !running(id)
    && summaries[id]?.projectionValues?.subagentTiming?.lastTurnCompleted === true
  const runningCount = entries.filter(entry => running(entry.id)).length
  const doneCount = entries.filter(entry => completed(entry.id)).length
  useEffect(() => {
    if (projection === undefined || (projection.state === 'idle' && projection.values.subagentCatalog === undefined)) refreshProjection(sessionId)
  }, [projection, refreshProjection, sessionId])
  return <section className={css.section} data-task-subagents>
    <div className={css.heading}>
      <h3>{t('overview.title')}</h3>
      {projection?.state === 'error' && <Tooltip label={t('retry')} side="bottom" portal>
        <button type="button" className={css.icon} aria-label={t('retry')}
          onClick={() => { refreshProjection(sessionId) }}><IconRefreshOutlineRegular /></button>
      </Tooltip>}
    </div>
    {entries.length > 0 && <p className={css.counts}>
      {runningCount > 0 && <span>{t('overview.running', { count: runningCount })}</span>}
      {doneCount > 0 && <span>{t('overview.done', { count: doneCount })}</span>}
      {entries.length - runningCount - doneCount > 0 && <span>{t('overview.idle', { count: entries.length - runningCount - doneCount })}</span>}
    </p>}
    {projection?.state === 'error' && <p className={css.notice} role="status">{t('load.error')}</p>}
    {loading ? <div className={css.skeleton} role="status" aria-label={t('loading.label')}><span /><span /></div>
      : entries.length === 0 && projection?.state !== 'error' ? <p className={css.notice}>{t('overview.empty')}</p>
        : <ul id={listId} className={css.list}>
          {(expanded ? entries : entries.slice(0, 4)).map((entry) => {
            const label = entry.label ?? entry.id
            const address = { parentSessionId: sessionId, childSessionId: entry.id, mode: entry.mode }
            const state = running(entry.id) ? 'ongoing' : completed(entry.id) ? 'done' : 'idle'
            const activity = t(state === 'ongoing' ? 'activity.running' : state === 'done' ? 'activity.completed' : 'activity.inactive')
            return <li key={entry.id} className={css.row}>
              <button type="button" className={css.child} onClick={() => { openChild(address) }}>
                <StateDot state={state} />
                <span className={css.label} title={label}>{label}</span>{' '}
                <span className={css.activity}>{activity}</span>
              </button>
              <Tooltip label={t('open.sidebar')} side="bottom" portal>
                <button type="button" className={css.icon} aria-label={t('open.sidebar.aria', { label })}
                  onClick={() => { openChildAside(address) }}><IconPanelLeftOutlineRegular /></button>
              </Tooltip>
            </li>
          })}
        </ul>}
    {entries.length > 4 && <button type="button" className={css.disclosure} aria-expanded={expanded} aria-controls={listId}
      onClick={() => { setExpanded(value => !value) }}>
      <span>{t(expanded ? 'overview.collapse' : 'overview.all', { count: entries.length })}</span>
      <IconChevronDownOutlineRegular className={expanded ? css.expanded : undefined} />
    </button>}
  </section>
}
