/** Agent Teams navigation page using the shared Conversation composer. */
import { IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { NS } from './locales.ts'
import css from './TeamPage.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Selected Session or blank composer on the Agent Teams page. */
    'agent-team.page': { kind: 'single'; scope: 'session-maybe' }
    /** Roster, shared tasks, and room controls for the selected Team. */
    'agent-team.overview': { kind: 'single'; scope: 'session'; owner: TeamOverviewOwnerProps }
  }
}

/** Presentation label supplied by the Team page toolbar. */
export interface TeamOverviewOwnerProps {
  /** Localized toolbar label; absent uses the Team dialog title. */
  label?: string
}

/** Optional Session page inputs and shared Conversation content renderer. */
export type TeamPageProps = PropsRuntime<'agent-team.page'>
  & PropsLocale<typeof NS> & PropsRenderSlots<'agent-team.overview'>
  & PropsRenderFactories

/**
 * Bind the page to the same current Session as the ordinary Conversation.
 * @param props - main panel's declared page renderer.
 * @returns selected or empty Agent Teams page.
 */
export function TeamPanel({ renderSlot }: PropsRuntime<'main'> & PropsRenderSlots<'agent-team.page'>) {
  return renderSlot('agent-team.page', {})
}

/**
 * Show Team controls and one shared composer with a dark glass material.
 * @param props - selected Session sources, localized copy, and declared renderers.
 * @returns Team page with the ordinary draft and submission behavior.
 */
export function TeamPage({ sessionId, renderSlot, renderFactorySlot, t }: TeamPageProps) {
  return (
    <div className={css.page} data-agent-teams-page data-team-composer>
      <header className={css.header} data-window-drag>
        <h1><IconUsersOutlineRegular size={18} />{t('panel')}</h1>
        {sessionId !== undefined && renderSlot('agent-team.overview', { label: t('details') })}
      </header>
      {renderFactorySlot('conversation.content', { variant: 'main' })}
    </div>
  )
}

/**
 * Render the Team glyph in expanded navigation and the collapsed rail.
 * @param props - icon size supplied by the sidebar.
 * @returns decorative Team icon; the sidebar owns its accessible name.
 */
export function TeamPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconUsersOutlineRegular size={size} />
}
