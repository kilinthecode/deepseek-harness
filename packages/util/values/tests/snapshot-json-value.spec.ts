/**
 * Prototype verdicts of the JSON walk: this realm's intrinsics are accepted by
 * identity without re-deriving the constructor representation, while forged,
 * subclassed, and cross-realm prototypes still take the descriptor/source slow
 * path. The `Function.prototype.toString` call count is the waste signal: a
 * same-realm graph must not reach it at all.
 */

import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonValue, snapshotJsonValue } from '../src/index.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A graph of `count` same-realm plain objects, each under a nested array. */
function nestedGraph(count: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({ index, nested: [{ value: `${index}` }] }))
}

describe('same-realm prototype verdicts', () => {
  it('verdicts current-realm plain objects and arrays without reading constructor source', () => {
    const constructorSource = vi.spyOn(Function.prototype, 'toString')

    const source = nestedGraph(1_000)
    const snapshot = snapshotJsonValue(source)

    expect(constructorSource).not.toHaveBeenCalled()
    expect(snapshot).toEqual(source)
    expect(snapshot).not.toBe(source)
  })

  it('keeps the cross-realm slow path for intrinsic containers from another realm', () => {
    const constructorSource = vi.spyOn(Function.prototype, 'toString')
    const foreign = runInNewContext('({ list: [1, { value: 2 }], record: { value: 3 } })') as {
      list: unknown[]
      record: { value: number }
    }

    expect(isJsonValue(foreign)).toBe(true)
    expect(snapshotJsonValue(foreign)).toEqual({ list: [1, { value: 2 }], record: { value: 3 } })
    expect(constructorSource).toHaveBeenCalled()
  })

  it('still rejects forged intrinsic prototypes, subclassed containers, and cycles', () => {
    const prototype = Object.create(null) as Record<string, unknown>
    const Forged = function Forged(): void {}
    Object.defineProperty(Forged, 'name', { value: 'Object' })
    Forged.prototype = prototype
    Object.defineProperty(prototype, 'constructor', { value: Forged })
    const forged = Object.assign(Object.create(prototype) as Record<string, unknown>, { value: 1 })
    class Subclass extends Array<number> {}
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(snapshotJsonValue(forged)).toBeUndefined()
    expect(snapshotJsonValue(new Subclass(1))).toBeUndefined()
    expect(snapshotJsonValue(cyclic)).toBeUndefined()
    expect(snapshotJsonValue(Object.assign(Object.create(null) as Record<string, unknown>, { value: 1 })))
      .toEqual({ value: 1 })
  })

  it('falls back to the slow path when this realm’s Array.prototype loses its intrinsic parent', () => {
    const original = Object.getPrototypeOf(Array.prototype) as object
    try {
      Object.setPrototypeOf(Array.prototype, null)
      expect(isJsonValue([1])).toBe(false)
      expect(snapshotJsonValue([1])).toBeUndefined()
    } finally {
      Object.setPrototypeOf(Array.prototype, original)
    }
  })
})
