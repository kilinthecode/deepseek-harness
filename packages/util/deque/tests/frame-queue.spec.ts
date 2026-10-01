import { describe, expect, it, vi } from 'vitest'
import { FrameQueue } from '@deepseek-ai/dsh-deque'

/** Collect every frame one queue delivers to a single reader. */
async function collect<T>(queue: FrameQueue<T>, signal: AbortSignal, seen: T[] = []): Promise<T[]> {
  for await (const frame of queue.iterate(signal)) seen.push(frame)
  return seen
}

/** Await until `predicate` holds, so a test never races the reader. */
async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  throw new Error('condition never held')
}

describe('FrameQueue', () => {
  it('delivers entries queued before a reader arrives, in FIFO order', async () => {
    const queue = new FrameQueue<number>('discard')
    expect(queue.size).toBe(0)
    expect(queue.finished).toBe(false)

    queue.push(1)
    queue.push(2)
    expect(queue.size).toBe(2)

    const seen: number[] = []
    const reading = collect(queue, new AbortController().signal, seen)
    await until(() => seen.length === 2)
    queue.finish()

    expect(seen).toEqual([1, 2])
    expect(await reading).toEqual([1, 2])
  })

  it('delivers an entry pushed while the reader waits', async () => {
    const queue = new FrameQueue<string>('discard')
    const seen: string[] = []
    const reading = collect(queue, new AbortController().signal, seen)
    await until(() => queue.size === 0)

    queue.push('live')
    await until(() => seen.length === 1)
    queue.finish()

    expect(await reading).toEqual(['live'])
  })

  it('ends the iteration on finish without draining under the discard policy', async () => {
    const queue = new FrameQueue<number>('discard')
    queue.push(1)
    queue.finish()

    expect(queue.finished).toBe(true)
    expect(await collect(queue, new AbortController().signal)).toEqual([])
  })

  it('delivers the queued backlog on finish under the drain policy', async () => {
    const queue = new FrameQueue<number>('drain')
    queue.push(1)
    queue.push(2)
    queue.finish()

    expect(await collect(queue, new AbortController().signal)).toEqual([1, 2])
  })

  it('drops entries pushed after the queue finished', () => {
    const queue = new FrameQueue<number>('drain')
    queue.finish()
    queue.push(1)

    expect(queue.size).toBe(0)
  })

  it('releases a waiting reader once and ignores later finishes', async () => {
    const queue = new FrameQueue<number>('drain')
    const reading = collect(queue, new AbortController().signal)
    await until(() => queue.size === 0)

    queue.finish()
    queue.finish()

    expect(await reading).toEqual([])
  })

  it('finishes the queue when the caller aborts and detaches its listener', async () => {
    const queue = new FrameQueue<number>('drain')
    const controller = new AbortController()
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const reading = collect(queue, controller.signal)
    await until(() => queue.size === 0)

    controller.abort()

    expect(await reading).toEqual([])
    expect(queue.finished).toBe(true)
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('does not drain an already-aborted reader', async () => {
    const queue = new FrameQueue<number>('drain')
    queue.push(1)
    const controller = new AbortController()
    controller.abort()

    expect(await collect(queue, controller.signal)).toEqual([])
  })
})
