/**
 * Host-only delivery bookkeeping for peer mailboxes.
 *
 * The service needs three facts the log already carries: which peer deliveries
 * the target applied (so a mail file can be deleted), the deepest relay this
 * session has received from each peer (so a conversation cannot loop), and
 * whether the open turn was opened by an idle notice. All three are folded
 * from the whole session log, including an inherited fork prefix, and never
 * travel over a wire: no client asks for them.
 *
 * @module @deepseek-ai/dsh-experimental-peer-sessions/projection
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
// Type-only: the `peer-message` and `peer-idle` message sources this fold reads.
import type {} from './index.ts'
import type { PeerMessageId } from './types.ts'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

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
