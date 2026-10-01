/** Live Session projection state with reconnect baselines. */

import type { Context } from '@deepseek-ai/cordis'
import { FrameQueue } from '@deepseek-ai/dsh-deque'
import type {
  Session, SessionId,
} from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionProjectionBaseline,
  SessionProjectionValues,
} from './types.ts'

/** Owns the Host-wide Session control stream. */
export class SessionControlController {
  private readonly streams = new Set<ControlQueue>()

  /** @param ctx - Host context carrying live Agent and projection services. */
  constructor(private readonly ctx: Context) {
    ctx.sessionProjections.onChanged((session, key, value, seq) => {
      this.broadcast({
        type: 'projection',
        sessionId: session.id,
        key,
        value: value as JsonValue,
        seq,
      })
    })
    ctx.effect(() => () => {
      for (const stream of this.streams) stream.finish()
      this.streams.clear()
    }, 'session-controller.control')
  }

  /**
   * Open one generation of Host-wide live control state.
   * @param signal - Remote stream cancellation.
   * @returns one complete baseline followed by live replacement frames.
   */
  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    signal.throwIfAborted()
    const queue = new ControlQueue()
    this.streams.add(queue)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* queue.iterate(signal)
    } finally {
      this.streams.delete(queue)
      queue.finish()
    }
  }

  private baseline(): SessionControlBaseline {
    const sessions = this.ctx.sessions.list()
    return {
      projections: this.projectionBaseline(sessions),
    }
  }

  private projectionBaseline(
    sessions: readonly Session[],
  ): Readonly<Record<SessionId, SessionProjectionBaseline>> {
    const blocks = Object.create(null) as Record<SessionId, SessionProjectionBaseline>
    for (const session of sessions) {
      const snapshot = this.ctx.sessionProjections.snapshot(session)
      blocks[session.id] = {
        asOfSeq: snapshot.asOfSeq,
        // Every projection definition validates its value before snapshot publication.
        values: snapshot.values as SessionProjectionValues,
      }
    }
    return blocks
  }

  private broadcast(frame: SessionControlFrame): void {
    for (const stream of this.streams) stream.push(frame)
  }
}

class ControlQueue extends FrameQueue<SessionControlFrame> {
  constructor() {
    // A Session control stream is torn down while the client is still attached,
    // so frames committed before the close are delivered rather than dropped.
    super('drain')
  }
}
