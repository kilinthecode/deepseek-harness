import { describe, expect, it } from 'vitest'
import { mergeOrderedBaseline } from '../src/client/ordered-baseline.ts'

describe('mergeOrderedBaseline', () => {
  it('keeps established order and places new rows before the nearest following established identity', () => {
    const current = [{ id: 'a', value: 'old-a' }, { id: 'removed', value: 'old' }, { id: 'c', value: 'old-c' }]
    const baseline = [
      { id: 'x', value: 'x' },
      { id: 'a', value: 'new-a' },
      { id: 'y', value: 'y' },
      { id: 'z', value: 'z' },
      { id: 'c', value: 'new-c' },
      { id: 'tail', value: 'tail' },
    ]

    expect(mergeOrderedBaseline(current, baseline, row => row.id)).toEqual([
      baseline[0], baseline[1], baseline[2], baseline[3], baseline[4], baseline[5],
    ])
  })

  it('retains last baseline values for established duplicate keys and first values for new duplicates', () => {
    const current = [{ id: 'a', value: 'old-a' }, { id: 'a', value: 'duplicate-a' }, { id: 'c', value: 'old-c' }]
    const baseline = [
      { id: 'new', value: 'first-new' },
      { id: 'a', value: 'first-a' },
      { id: 'new', value: 'last-new' },
      { id: 'a', value: 'last-a' },
      { id: 'c', value: 'new-c' },
    ]

    expect(mergeOrderedBaseline(current, baseline, row => row.id)).toEqual([
      baseline[0], baseline[3], baseline[3], baseline[4],
    ])
  })

  it('lets a later duplicate of an inserted identity anchor an intervening row', () => {
    const current = [{ id: 'X' }]
    const baseline = [{ id: 'A' }, { id: 'B' }, { id: 'A' }, { id: 'X' }]

    expect(mergeOrderedBaseline(current, baseline, row => row.id)).toEqual([
      baseline[1], baseline[0], baseline[3],
    ])
  })

  it('keeps successive inserted identities available as duplicate anchors', () => {
    const current = [{ id: 'X' }]
    const baseline = [{ id: 'A' }, { id: 'B' }, { id: 'A' }, { id: 'C' }, { id: 'B' }, { id: 'X' }]

    expect(mergeOrderedBaseline(current, baseline, row => row.id)).toEqual([
      baseline[3], baseline[1], baseline[0], baseline[5],
    ])
  })

  it('preserves strict-equality anchor behavior for NaN keys', () => {
    const current = [{ id: Number.NaN }]
    const baseline = [{ id: 'new' }, { id: Number.NaN }]

    expect(mergeOrderedBaseline(current, baseline, row => row.id)).toEqual([
      baseline[1], baseline[0],
    ])
  })

  it('does bounded key selection work for a tail anchor and many new rows', () => {
    const count = 256
    const current = [{ id: count }]
    const baseline = Array.from({ length: count + 1 }, (_, id) => ({ id }))
    let keyCalls = 0

    const result = mergeOrderedBaseline(current, baseline, (row) => {
      keyCalls++
      return row.id
    })

    expect(result).toEqual(baseline)
    // The former repeated look-ahead/findIndex/splice path exceeds this by
    // orders of magnitude for the same tail-anchored baseline.
    expect(keyCalls).toBeLessThan(count * 5)
  })

})
