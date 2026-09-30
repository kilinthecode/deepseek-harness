/**
 * Host-only delivery and activity bookkeeping for peer sessions.
 *
 * The service needs three facts the log already carries: which peer deliveries
 * the target applied (so a mail file can be deleted), the deepest relay this
 * session has received from each peer (so a conversation cannot loop), and
 * whether the open turn was opened by an idle notice. All three are folded
 * from the whole session log, including an inherited fork prefix, and never
 * travel over a wire: no client asks for them.
 *
 * A fourth fold answers what the model already saw of its peers' published
 * activity, so a step shows a block once instead of once per step. It is
 * host-only for the same reason.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions/projection
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
// Type-only: the `peer-message` and `peer-idle` message sources this fold reads.
import type {} from './index.ts'
// Type-only: the `compaction/end` event that resets the activity dedupe state.
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { ContentBlock, ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import type { PeerMessageId } from './types.ts'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Section name of the peer block a rendered activity snapshot carries. */
export const PEER_ACTIVITY_SECTION = 'peer:activity'

/** Section name of one overlap warning a rendered activity snapshot carries. */
export const PEER_OVERLAP_SECTION = 'peer:overlap'

/**
 * Whether one content block carries model-facing text.
 * @param block - the block to inspect.
 * @returns whether the block is a text block.
 */
function isTextContent(block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> {
  return block.type === 'text'
}

/**
 * One message's complete text: its text blocks, in order.
 * @param content - the message's model-facing blocks.
 * @returns the joined text of its text blocks.
 */
function messageText(content: readonly ContentBlock[]): string {
  return content.filter(isTextContent).map(block => block.text).join('\n')
}

/**
 * The overlap text one activity snapshot is recognized by.
 * @param sections - the snapshot's named contributions.
 * @returns the `peer:overlap` section texts joined by a line feed, or `''` when it warned about nothing.
 */
export function overlapText(sections: readonly ContextSnapshotSection[]): string {
  return sections.filter(section => section.name === PEER_OVERLAP_SECTION).map(section => section.text).join('\n')
}

/**
 * One session's peer-delivery state.
 *
 * Plain JSON for every durable-cache consumer: delivery ids as opaque strings,
 * relay depth as a per-sender number, and the idle-turn bit.
 */
export interface PeerDeliveryState {
  /** Envelope ids of peer deliveries this session applied, in log order. */
  readonly delivered: readonly PeerMessageId[]
  /** Highest relay depth received from each sender session id. */
  readonly relayDepth: Readonly<Record<string, number>>
  /** Whether the open turn was opened by an idle notice. */
  readonly peerIdleTurn: boolean
}

const deliverySchema = z.object({
  delivered: z.array(z.string().min(1).transform(value => brandString<PeerMessageId>(value))).readonly(),
  relayDepth: z.record(z.string().min(1), z.number().int().min(1)).readonly(),
  peerIdleTurn: z.boolean(),
}).readonly()

const EMPTY_DELIVERY: PeerDeliveryState = { delivered: [], relayDepth: {}, peerIdleTurn: false }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Peer deliveries this session applied, its per-peer relay depth, and its idle-notice turn. */
    peerDelivery: PeerDeliveryState
  }
}

/**
 * Host-only fold of this session's peer deliveries and relay depth.
 *
 * The state is also the acceptance record the mailbox drain reads: a delivery
 * counts as applied when its envelope id appears here, because the fold sees
 * the logged `user/message` rather than the steered splice it came from.
 */
export const peerDeliveryProjection: ProjectionDefinition<'peerDelivery', PeerDeliveryState> = {
  key: 'peerDelivery',
  stateVersion: 1,
  stateSchema: deliverySchema,
  init: () => EMPTY_DELIVERY,
  apply: (state, event) => {
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'peer-message') {
        if (state.delivered.includes(source.messageId)) return state
        const previous = state.relayDepth[source.senderSessionId] ?? 0
        const relayDepth = Math.max(previous, source.relayDepth)
        return {
          delivered: [...state.delivered, source.messageId],
          relayDepth: relayDepth === previous
            ? state.relayDepth
            : { ...state.relayDepth, [source.senderSessionId]: relayDepth },
          peerIdleTurn: state.peerIdleTurn,
        }
      }
      if (source.kind === 'peer-idle') {
        if (state.delivered.includes(source.messageId)) return state
        return { delivered: [...state.delivered, source.messageId], relayDepth: state.relayDepth, peerIdleTurn: true }
      }
      // A person re-engaging restarts the relay budget; a schedule, webhook,
      // team, or peer producer does not.
      if (source.kind === 'user') {
        return Object.keys(state.relayDepth).length === 0 ? state : { ...state, relayDepth: {} }
      }
      return state
    }
    if (event.type === 'turn/end') {
      return state.peerIdleTurn ? { ...state, peerIdleTurn: false } : state
    }
    return state
  },
}

/**
 * One session's peer-activity dedupe state.
 *
 * The fields are the three questions a step asks: has this session already been
 * shown this exact block, has it already been warned about the same overlap,
 * and has it already been shown each peer the block would list. All three are
 * remembered from the logged snapshot rather than held in memory, so a resumed
 * session does not re-show a block its earlier steps already saw.
 */
export interface PeerActivityState {
  /** Complete text of the last `peer-activity` message this session logged. */
  readonly lastText: string
  /** That message's `peer:overlap` section texts joined by a line feed, `''` when it warned about nothing. */
  readonly lastOverlap: string
  /** Session ids of the peers that message listed, in block order; empty while this session was shown no block. */
  readonly lastPeerIds: readonly string[]
}

const activitySchema = z.object({
  lastText: z.string(),
  lastOverlap: z.string(),
  lastPeerIds: z.array(z.string()).readonly(),
}).readonly()

const EMPTY_ACTIVITY: PeerActivityState = { lastText: '', lastOverlap: '', lastPeerIds: [] }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The activity snapshot this session was last shown, for step-level dedupe. */
    peerActivity: PeerActivityState
  }
}

/**
 * Host-only fold of the activity snapshot this session was last shown.
 *
 * A compaction rewrites the conversation around one summary, so the block a
 * pre-compaction step saw is no longer in context: the reset makes the next
 * step show it again. A failed compaction changes nothing, so it keeps the
 * state.
 */
export const peerActivityProjection: ProjectionDefinition<'peerActivity', PeerActivityState> = {
  key: 'peerActivity',
  stateVersion: 2,
  stateSchema: activitySchema,
  init: () => EMPTY_ACTIVITY,
  apply: (state, event) => {
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'peer-activity') {
        return {
          lastText: messageText(event.data.content),
          lastOverlap: overlapText(source.sections),
          lastPeerIds: source.peerIds,
        }
      }
      return state
    }
    if (event.type === 'compaction/end' && event.data.error === undefined) {
      return state.lastText === '' && state.lastOverlap === '' && state.lastPeerIds.length === 0 ? state : EMPTY_ACTIVITY
    }
    return state
  },
}
