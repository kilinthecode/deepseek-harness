/** Session task overview with feature-owned sections and registered tool launch rows; replaceable through the guide chain. */
import { ShortcutKeys } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ChainRenderOpts, HookContextOf, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightGuideBox } from '../../tab-registry.ts'
import { CubeGlyph } from './GuideTitle.tsx'
import css from './GuideBody.module.css'

/** What the guide body needs from its host beyond the framework shares. */
export interface GuideInjected {
  /** The registry's guide entries in `order`; observable, so a type registering later appears. */
  readonly hooks: {
    readonly shortcuts: ObservableSnapshot<readonly ShortcutCatalogEntry[]>
    readonly guideEntries: ObservableSnapshot<readonly SidebarRightGuideBox[]>
  }
}

/** The guide body's composed props: the tab it draws, its chain child, and the entries. */
export type GuideBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.guide' | 'sidebar.right.tab.guide.entry' | 'sidebar.right.tab.guide.section'>
  & InjectFace<GuideInjected>
  & PropsLocale<'sidebarRight'>

/** Entry count past which tool rows omit descriptions. */
const MAX_DESCRIBED_ENTRIES = 4

/** A tool launch row with its provider's glyph, title, optional description, and shortcut. */
function EntryBox({ entry, described, onPick, shortcut }: {
  shortcut: ShortcutCatalogEntry | undefined
  entry: SidebarRightGuideBox
  described: boolean
  onPick: (entry: SidebarRightGuideBox) => void
}): ReactNode {
  const Icon = entry.icon ?? CubeGlyph
  const description = described ? entry.description?.() : undefined
  return (
    <button
      type="button"
      className={css.entry}
      data-sidebar-right-guide-entry={entry.kind}
      aria-keyshortcuts={shortcut?.aria}
      onClick={() => { onPick(entry) }}
    >
      <span className={css.entryIcon}>
        <Icon size={description === undefined ? 22 : 26} className={entry.icon === undefined ? css.placeholderInk : undefined} />
      </span>
      <span className={css.entryText}>
        <span className={css.entryTitle}>{entry.title()}</span>
        {description !== undefined && <span className={css.entryDescription}>{description}</span>}
      </span>
      {shortcut !== undefined && shortcut.keys.length > 0 && <ShortcutKeys keys={shortcut.keys} />}
    </button>
  )
}

/** The guide tab's body, replaceable through its chain child. */
export function GuideBody({
  sessionId, useSessions, useTabInfo, useGuideEntries, renderSlot, renderSlotChain, useShortcuts, t,
}: GuideBodyProps): ReactNode {
  const shortcuts = useShortcuts(entries => entries)
  const summary = useSessions(state => state.byId[sessionId])
  const workspace = summary?.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
  const { tab } = useTabInfo()
  const entries = useGuideEntries(entries => entries)
  const options = {
    hookContext: useTabInfo,
    fallback: (
      <div className={css.guide} data-sidebar-right-guide data-task-overview>
        <div className={css.overview}>
          <header className={css.heading}>
            <h2 className={css.workspace} title={summary?.cwd}>{workspace || t('tab.guide.title')}</h2>
            {summary?.title && <p className={css.sessionTitle}>{summary.title}</p>}
          </header>
          <div className={css.sections}>{renderSlot('sidebar.right.tab.guide.section', {
            openResource: (address, opts) => { tab.actions.openResource(address, opts) },
          })}</div>
          {entries.length > 0 && <section className={css.tools}>
            <h3 className={css.sectionTitle}>{t('guide.tools')}</h3>
            {entries.map((entry) => {
              const described = entries.length <= MAX_DESCRIBED_ENTRIES
              const description = described ? entry.description?.() : undefined
              return <div key={JSON.stringify([entry.providerId, entry.id])} className={css.entryCell}>
                {renderSlot('sidebar.right.tab.guide.entry', {
                  entryId: entry.id, kind: entry.kind, title: entry.title(),
                  ...description === undefined ? {} : { description },
                }, {
                  entryKey: entry.providerId, hookContext: useTabInfo,
                  fallback: <EntryBox entry={entry} described={described}
                    shortcut={shortcuts.find(shortcut => shortcut.id === entry.commandId)}
                    onPick={(selected) => { tab.actions.openTab(selected.kind, { replaceTab: true }) }} />,
                })}
              </div>
            })}
          </section>}
        </div>
      </div>
    ),
  } satisfies ChainRenderOpts & { hookContext: HookContextOf<'sidebar.right.tab.guide'> }
  return renderSlotChain('sidebar.right.tab.guide', {}, options)
}
