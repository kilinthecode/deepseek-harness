/**
 * Buffered hand-off between synchronous producers and one asynchronous consumer.
 * @module @deepseek-ai/dsh-async-queue
 */

/**
 * Buffered hand-off from one or more synchronous producers to one
 * async-iterator consumer.
 *
 * A producer calls {@link push}; the consumer alternates {@link take} with
 * {@link wait}. This class owns entry order, waking the parked consumer, and the
 * finished state that refuses later pushes. It deliberately does not own the
 * iteration loop: consumers differ on what happens after {@link end}. The live
 * control stream in `@deepseek-ai/dsh-api-session-controller` drains the entries
 * still buffered; the room stream in `@deepseek-ai/dsh-experimental-agent-team`
 * delivers nothing after the end, because disposal ends its readers before their
 * listeners stop. Only the consumer knows which applies, so each writes its own
 * loop, including cancellation.
 *
 * One consumer at a time: a second concurrent {@link wait} replaces the parked
 * resolver of the first, which then stays parked until the next {@link push} or
 * {@link end}.
 */
export class AsyncQueue<T> {
  private buffer: (T | undefined)[] = []
  private head = 0
  private wake: (() => void) | undefined
  private done = false

  /** Number of entries waiting to be taken. */
  get size(): number {
    return this.buffer.length - this.head
  }

  /** Whether {@link end} has finished the queue; buffered entries stay takeable. */
  get finished(): boolean {
    return this.done
  }

  /**
   * Append one entry for the consumer. A push after {@link end} is refused, so a
   * producer that races the end never hands over another entry.
   * @param value - entry to hand over.
   */
  push(value: T): void {
    if (this.done) return
    this.buffer.push(value)
    this.wakeNow()
  }

  /**
   * Finish the queue: refuse later pushes and release the parked consumer.
   * Idempotent, and entries buffered before the call remain available to
   * {@link take}.
   */
  end(): void {
    if (this.done) return
    this.done = true
    this.wakeNow()
  }

  /**
   * Remove the oldest buffered entry and release its reference.
   * @returns the removed entry, or `undefined` when none is buffered. A consumer
   *   whose entry type includes `undefined` reads {@link size} to tell an empty
   *   queue from a buffered `undefined`.
   */
  take(): T | undefined {
    if (this.head === this.buffer.length) return undefined
    const value = this.buffer[this.head]
    this.buffer[this.head] = undefined
    this.head += 1
    if (this.head === this.buffer.length) {
      this.buffer = []
      this.head = 0
    }
    return value
  }

  /**
   * Resolve once an entry is buffered or the queue has finished, whichever comes
   * first; returns immediately when either already holds.
   * @returns a promise the consumer awaits before retrying {@link take}.
   */
  async wait(): Promise<void> {
    if (this.done || this.head < this.buffer.length) return
    await new Promise<void>((resolve) => { this.wake = resolve })
  }

  private wakeNow(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}
