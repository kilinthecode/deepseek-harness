/** Shared composer placement for main Conversation pages. */
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { conversationPhase, type ConversationSnapshot } from './snapshot.ts'

/** Composer visibility and placement during Session loading and activity. */
export interface ConversationPresentation {
  /** Whether the composer uses the centered empty-conversation layout. */
  readonly hero: boolean
  /** Hide while settling, center when empty, or dock beside active content. */
  readonly phase: 'settling' | 'hero' | 'active'
}

/**
 * Keep the composer hidden until history or a blank catalog row determines its placement.
 * @param sessionId - selected Session, absent on the New Session page.
 * @param session - current lifecycle state, absent before binding.
 * @param conversation - assembled Conversation, absent before binding.
 * @param summaryBlank - catalog evidence that the selected Session has no conversation.
 * @returns centered, docked, or temporarily hidden composer presentation.
 */
export function conversationPresentation(
  sessionId: SessionId | undefined,
  session: SessionSnapshot | undefined,
  conversation: ConversationSnapshot | undefined,
  summaryBlank: boolean | undefined,
): ConversationPresentation {
  const blank = session === undefined || conversation === undefined
    || conversationPhase(session, conversation) === 'blank'
  const settling = sessionId !== undefined && (
    (blank && session?.openState === 'loading' && summaryBlank !== true)
    || (session?.subagent?.address.mode === 'continuable' && session.subagent.parentAvailable === undefined)
  )
  const hero = sessionId === undefined || (blank && (session?.openState === 'open' || summaryBlank === true))
  return { hero, phase: settling ? 'settling' : hero ? 'hero' : 'active' }
}
