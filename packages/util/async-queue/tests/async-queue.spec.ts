import { describe, expect, it } from 'vitest'
import { AsyncQueue } from '@deepseek-ai/dsh-async-queue'

function storage<T>(queue: AsyncQueue<T>): readonly (T | undefined)[] {
  // Retaining a taken entry's reference is observable behavior without a public query API.
  return (queue as unknown as { readonly buffer: readonly (T | undefined)[] }).buffer
}

describe('AsyncQueue', () => {
  it('takes pushed entries in push order', () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.push(3)

    expect(queue.size).toBe(3)
    expect(queue.take()).toBe(1)
    expect(queue.take()).toBe(2)
    expect(queue.take()).toBe(3)
  })

  it('returns undefined from take while no entry is buffered', () => {
    const queue = new AsyncQueue<number>()

    expect(queue.take()).toBeUndefined()
    expect(queue.size).toBe(0)
  })

  it('stays reusable after the consumer drains the buffer', () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    expect(queue.take()).toBe(1)
    expect(queue.take()).toBeUndefined()

    queue.push(2)
    expect(queue.size).toBe(1)
    expect(queue.take()).toBe(2)
  })

  it('releases the reference of a taken entry', () => {
    const queue = new AsyncQueue<object>()
    const taken = {}
    queue.push(taken)
    queue.push({})

    expect(queue.take()).toBe(taken)
    expect(storage(queue)).not.toContain(taken)
  })

  it('resolves wait when a later push arrives', async () => {
    const queue = new AsyncQueue<string>()
    const parked = queue.wait()
    let resolved = false
    const observed = parked.then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)

    queue.push('frame')
    await observed
    expect(resolved).toBe(true)
    expect(queue.take()).toBe('frame')
  })

  it('resolves wait as soon as an entry is already buffered', async () => {
    const queue = new AsyncQueue<string>()
    queue.push('frame')

    await expect(queue.wait()).resolves.toBeUndefined()
    expect(queue.take()).toBe('frame')
  })

  it('resolves wait when the queue ends', async () => {
    const queue = new AsyncQueue<string>()
    const parked = queue.wait()

    queue.end()
    await expect(parked).resolves.toBeUndefined()
    expect(queue.finished).toBe(true)
  })

  it('resolves wait immediately once the queue has ended', async () => {
    const queue = new AsyncQueue<string>()
    queue.end()

    await expect(queue.wait()).resolves.toBeUndefined()
  })

  it('keeps end idempotent and leaves buffered entries takeable', () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    queue.end()
    queue.end()

    expect(queue.finished).toBe(true)
    expect(queue.size).toBe(1)
    expect(queue.take()).toBe(1)
  })

  it('refuses a push after end', () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    queue.end()
    queue.push(2)

    expect(queue.size).toBe(1)
    expect(queue.take()).toBe(1)
    expect(queue.take()).toBeUndefined()
  })

  it('uses size to distinguish a buffered undefined from an empty queue', () => {
    const queue = new AsyncQueue<number | undefined>()
    queue.push(undefined)

    expect(queue.size).toBe(1)
    expect(queue.take()).toBeUndefined()
    expect(queue.size).toBe(0)
    expect(queue.take()).toBeUndefined()
  })
})
