/** Target-neutral Conversation state assembled from one Session event window. */
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationViewSnapshotStore } from './conversation.ts'

/** Latest registered target snapshots and their shell-level activity. */
export interface ConversationSnapshot {
  readonly views: ConversationViewSnapshotStore
  readonly activeTargets: ReadonlySet<string>
}

/** Empty Conversation value used before a Session binding is available. */
export const EMPTY_CONVERSATION_SNAPSHOT: ConversationSnapshot = {
  views: { get: () => undefined, grouped: () => undefined },
  activeTargets: new Set(),
}

/** Shell phase derived from Session lifecycle and registered target activity. */
export type ConversationPhase = 'blank' | 'engaging' | 'active'

/**
 * Resolve the shell phase without adding Conversation data to the Session snapshot.
 * @param session - current Session lifecycle state.
 * @param conversation - current target-neutral Conversation state.
 * @returns the phase used by the header, View ring, and composer layout.
 */
export function conversationPhase(
  session: SessionSnapshot,
  conversation: ConversationSnapshot,
): ConversationPhase {
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  return active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
}

/**
 * Equality for Conversation subscriptions whose only read is the shell phase.
 * `conversationPhase` consults whether any target is active and nothing else in
 * the Conversation snapshot, and its callers branch on an absent Conversation
 * before calling it — so a publication that keeps both facts re-renders
 * nothing, while either fact changing still re-renders.
 * @param left - previously selected Conversation snapshot.
 * @param right - newly published Conversation snapshot.
 * @returns whether both agree on presence and on target activity.
 */
export function sameConversationActivity(
  left: ConversationSnapshot | undefined,
  right: ConversationSnapshot | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (left.activeTargets.size > 0) === (right.activeTargets.size > 0)
}
