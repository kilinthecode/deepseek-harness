/**
 * Zero-dependency circular deque for queues that retain entries across asynchronous work.
 * @module @deepseek-ai/dsh-deque
 */

const MIN_CAPACITY = 16

/**
 * A circular deque with amortized constant-time insertion and removal.
 * Removed entries are cleared immediately, and sparse storage shrinks after
 * the live entry count reaches one quarter of its capacity.
 */
export class Deque<T> {
  private buffer = new Array<T | undefined>(MIN_CAPACITY)
  private head = 0
  private count = 0

  /** Number of entries available to remove. */
  get size(): number {
    return this.count
  }

  /**
   * Append one entry after the current tail.
   * @param value - entry to append.
   */
  pushBack(value: T): void {
    this.ensureCapacity()
    const tail = this.head + this.count
    this.buffer[tail < this.buffer.length ? tail : tail - this.buffer.length] = value
    this.count += 1
  }

  /**
   * Insert one entry before the current head.
   * @param value - entry to prepend.
   */
  pushFront(value: T): void {
    this.ensureCapacity()
    this.head = this.head === 0 ? this.buffer.length - 1 : this.head - 1
    this.buffer[this.head] = value
    this.count += 1
  }

  /**
   * Remove the current head entry and clear its retained reference.
   * Callers whose element type includes `undefined` use {@link size} to
   * distinguish an empty deque from an `undefined` entry.
   * @returns the removed entry, or `undefined` when the deque is empty.
   */
  popFront(): T | undefined {
    if (this.count === 0) return undefined
    const value = this.buffer[this.head] as T
    this.buffer[this.head] = undefined
    this.head += 1
    if (this.head === this.buffer.length) this.head = 0
    this.count -= 1
    this.compact()
    return value
  }

  /** Drop every entry and release the current backing storage. */
  clear(): void {
    this.buffer = new Array<T | undefined>(MIN_CAPACITY)
    this.head = 0
    this.count = 0
  }

  private ensureCapacity(): void {
    if (this.count < this.buffer.length) return
    this.resize(this.buffer.length * 2)
  }

  private compact(): void {
    if (this.count === 0) {
      this.head = 0
      return
    }
    if (this.buffer.length > MIN_CAPACITY && this.count <= this.buffer.length / 4) {
      this.resize(Math.max(MIN_CAPACITY, this.buffer.length / 2))
    }
  }

  private resize(capacity: number): void {
    const next = new Array<T | undefined>(capacity)
    let source = this.head
    for (let index = 0; index < this.count; index += 1) {
      next[index] = this.buffer[source]
      source += 1
      if (source === this.buffer.length) source = 0
    }
    this.buffer = next
    this.head = 0
  }
}

/** How one {@link FrameQueue} reader finishes with entries still queued. */
export type FrameQueueDrain =
  /** Deliver the remaining backlog to the reader before the iteration ends. */
  | 'drain'
  /** End the iteration as soon as the queue finishes, discarding the backlog. */
  | 'discard'

/**
 * Buffered hand-off from many producers to one asynchronous reader.
 *
 * {@link push} delivers immediately when the reader is waiting and otherwise
 * queues; {@link finish} releases a waiting reader, and {@link iterate} yields
 * queued entries in FIFO order until the queue finishes or its signal aborts.
 * The caller declares, once, whether a finish drains the backlog or discards it,
 * so a queue whose reader must observe the tail and one torn down without
 * further delivery share this implementation without sharing that policy.
 */
export class FrameQueue<T> {
  private readonly buffer = new Deque<T>()
  private wake: (() => void) | undefined
  private done = false

  /**
   * @param drain - backlog policy applied when the queue finishes.
   */
  constructor(private readonly drain: FrameQueueDrain) {}

  /** Number of entries waiting for the reader. */
  get size(): number {
    return this.buffer.size
  }

  /** Whether this queue has finished; a finished queue discards further pushes. */
  get finished(): boolean {
    return this.done
  }

  /**
   * Queue one entry for the reader, or discard it when the queue already finished.
   * @param entry - entry to deliver to the reader.
   */
  push(entry: T): void {
    if (this.done) return
    this.buffer.pushBack(entry)
    this.release()
  }

  /** Finish the reader: queued entries follow the construction-time drain policy. */
  finish(): void {
    if (this.done) return
    this.done = true
    this.release()
  }

  /**
   * Yield queued entries in order until the queue finishes or the signal aborts.
   * @param signal - caller cancellation; aborting finishes the queue.
   * @returns every entry the reader observed while the queue stayed open.
   */
  async *iterate(signal: AbortSignal): AsyncIterable<T> {
    const onAbort = (): void => { this.finish() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        const entry = this.buffer.popFront()
        if (entry !== undefined) {
          yield entry
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      if (this.drain === 'drain') {
        while (this.buffer.size > 0 && !signal.aborted) yield this.buffer.popFront() as T
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.finish()
    }
  }

  private release(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}
