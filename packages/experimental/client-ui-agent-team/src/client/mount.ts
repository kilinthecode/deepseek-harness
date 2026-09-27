/** Source-safe Agent Teams browser registration and room Remote mount lifecycle. */

import type { RoomRemoteView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type {} from '@deepseek-ai/dsh-experimental-agent-team/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { TeamAction, type TeamActionInjected, type TeamActionResult } from './TeamAction.tsx'
import { TeamSubjectSeat, type TeamStartResult, type TeamSubjectInjected } from './TeamSubjectSeat.tsx'
import { en, NS, zh, type TeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Teams roster, room, and task-board copy. */
    'agent-team': TeamKey
  }
}

/** Required browser services for room and command RPC, navigation, slots, and localized copy. */
export const inject = ['sessions', 'uiWorkspace', 'remote', 'slots', 'locale']

/**
 * Start one conversation's Team through the Host `/team` command.
 * @param ctx - Client Context carrying the mounted `commands` Remote namespace.
 * @param sessionId - blank Lead conversation.
 * @param subject - trimmed Team subject.
 * @returns the command outcome in the start strip's terms.
 */
async function startTeam(ctx: ClientContext, sessionId: SessionId, subject: string): Promise<TeamStartResult> {
  const result = await ctx.remote.commands.execute(sessionId, `/team ${subject}`, [])
  if (!result.ok) return { kind: 'refused', text: result.error.message }
  if (result.value === undefined) return { kind: 'unavailable' }
  const outcome = result.value.result
  return outcome.kind === 'success' ? { kind: 'started' } : { kind: 'refused', text: outcome.text }
}

/**
 * Register the Team locale dictionaries, the conversation-header action, and
 * the start strip above a blank conversation's composer. The panel reads the
 * Lead Session's `agentTeam` projection from the shared Session store; its
 * room section calls the mounted `agentTeams` Remote namespace, and the start
 * strip calls the `commands` namespace.
 * @param ctx - Client Context carrying the injected navigation, locale, slot, Session, and Remote services.
 */
export function registerAgentTeamUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-agent-team: dictionaries')
  const sessions = ctx.sessions
  const leadSessionId = (sessionId: SessionId): SessionId => {
    const address = sessions.binding(sessionId)?.session.getSnapshot().subagent?.address
    return address?.parentSessionId ?? sessionId
  }

  const actions: TeamActionInjected = {
    openTeammate(sessionId: SessionId, childSessionId: SessionId): void {
      const parentSessionId = leadSessionId(sessionId)
      if ((sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0) return
      if (childSessionId === parentSessionId) {
        ctx.uiWorkspace.openSession(parentSessionId)
        return
      }
      ctx.uiWorkspace.openSession({
        parentSessionId,
        childSessionId,
        mode: 'continuable',
      })
    },
    async loadRoom(sessionId): Promise<TeamActionResult<RoomRemoteView>> {
      return await ctx.remote.agentTeams.room(leadSessionId(sessionId))
    },
    async followRoom(sessionId, signal, frame) {
      for await (const next of ctx.remote.agentTeams.roomStream(leadSessionId(sessionId), signal)) frame(next)
    },
    async promptParticipant(sessionId, input) {
      return await ctx.remote.agentTeams.roomPrompt(leadSessionId(sessionId), input)
    },
    async proposeDecision(sessionId, input) {
      return await ctx.remote.agentTeams.roomPropose(leadSessionId(sessionId), input)
    },
    async escalateDecision(sessionId, input) {
      return await ctx.remote.agentTeams.roomEscalate(leadSessionId(sessionId), input)
    },
  }

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-team',
      order: -20,
      locale: NS,
      inject: () => actions,
    }, TeamAction),
  )

  // Ahead of the Todo (0) and Goal (10) cards, which a blank conversation never shows.
  ctx.slots.inject(
    'conversation.input.dock',
    () => ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'agent-team-subject',
      order: -10,
      locale: NS,
      inject: (sessionId): TeamSubjectInjected => ({
        startTeam: subject => startTeam(ctx, sessionId, subject),
      }),
    }, TeamSubjectSeat),
  )
}

/**
 * Mount the generated room Remote contribution, then register the browser UI.
 * @param ctx - Client Context carrying navigation, locale, slot, Session, and Remote services.
 * @param contribution - generated Team descriptors selected by the browser entry.
 * @returns disposer for both the UI registrations and the Remote namespace.
 */
export async function mountAgentTeamUi(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['sessions', 'uiWorkspace', 'remote.agentTeams', 'remote.commands', 'slots', 'locale'], registerAgentTeamUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
