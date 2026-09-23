import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Whether the Session's current model route accepts image input, as
 * `ui-model-selection` computes it from the shared catalog directory.
 * `false` is the only refusing value; `null` covers unknown capability
 * (catalog not loaded, or the current selection is not listed).
 */
export type RouteImageState = boolean | null

/** The registry face other plugins reach through `ctx.conversation.routeImage`. */
export interface ComposerRouteImage {
  /**
   * Publish this Session's route-image advisory.
   * @param sessionId - Session whose route capability changed.
   * @param acceptsImages - Whether the current route accepts image input.
   */
  set(sessionId: SessionId, acceptsImages: RouteImageState): void
  /**
   * Resolve the observable route-image state for one Session.
   * @param sessionId - Session to observe.
   * @returns Identity-stable state store, initialized to `null`.
   */
  storeFor(sessionId: SessionId): SnapshotStore<RouteImageState>
  /**
   * Drop one Session's store.
   * @param sessionId - Session being released.
   */
  forget(sessionId: SessionId): void
}
