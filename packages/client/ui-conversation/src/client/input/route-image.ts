/**
 * Composer route-image advisory: the one way another plugin tells the
 * composer whether the Session's current model route accepts image input.
 *
 * The composer cannot read the plugins that would know — the dependency runs
 * ui-model-selection → ui-conversation, never back — so the publisher pushes
 * here and the bar reads its own Session's store. Unlike a composer block,
 * this carries no reason text: `false` refuses new image intake, and `null`
 * (unknown capability, or the current selection is not listed) allows it and
 * leaves the decision to Host prompt admission.
 *
 * Host prompt admission refuses an image prompt the Session's resolved model
 * does not accept, regardless of this advisory. Host command execution does
 * not check the images an attachment-accepting command (`/goal`, `/plan`)
 * carries, so the composer's refusal under a `false` advisory is the only
 * guard on that path (package README, Known Limitations and Deferred Work).
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComposerRouteImage, RouteImageState } from '../contract/composer-route-image.ts'

/** The per-session route-image registry (one instance per plugin fiber). */
export class ComposerRouteImageRegistry implements ComposerRouteImage {
  private readonly stores = new Map<SessionId, SnapshotStore<RouteImageState>>()

  /** @inheritdoc */
  set(sessionId: SessionId, acceptsImages: RouteImageState): void {
    const store = this.storeFor(sessionId)
    if (store.getSnapshot() === acceptsImages) return
    store.set(acceptsImages)
  }

  /** @inheritdoc */
  storeFor(sessionId: SessionId): SnapshotStore<RouteImageState> {
    const existing = this.stores.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSnapshotStore<RouteImageState>(null)
    this.stores.set(sessionId, created)
    return created
  }

  /** @inheritdoc */
  forget(sessionId: SessionId): void {
    this.stores.delete(sessionId)
  }
}
