/**
 * Merge an authoritative baseline without moving identities already visible to
 * the client. Baseline-only identities are inserted relative to the nearest
 * following known identity; identities absent from the baseline are removed.
 *
 * @param current - the established client order.
 * @param baseline - the latest authoritative rows.
 * @param keyOf - stable identity selector.
 * @returns baseline-valued rows with the established relative order retained.
 */
export function mergeOrderedBaseline<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => unknown,
): T[] {
  const baselineByKey = new Map<unknown, T>()
  let hasDuplicateKey = false
  for (const value of baseline) {
    const key = keyOf(value)
    if (baselineByKey.has(key)) hasDuplicateKey = true
    baselineByKey.set(key, value)
  }
  if (hasDuplicateKey) return mergeOrderedBaselineWithDuplicates(current, baseline, keyOf)

  const merged = current
    .map(value => baselineByKey.get(keyOf(value)))
    .filter((value): value is T => value !== undefined)
  const mergedKeys = new Set(merged.map(keyOf))
  const before = new Map<unknown, T[]>()
  const appended: T[] = []
  const noFollowing = Symbol('no following identity')
  let followingKnown: unknown = noFollowing

  for (let index = baseline.length - 1; index >= 0; index--) {
    const value = baseline[index]
    /* v8 ignore next -- dense-array guard: index is bounded by baseline.length. */
    if (value === undefined) continue
    const key = keyOf(value)
    if (mergedKeys.has(key)) {
      if (!(typeof key === 'number' && Number.isNaN(key))) followingKnown = key
      continue
    }
    const rows = followingKnown === noFollowing ? appended : before.get(followingKnown) ?? []
    rows.push(value)
    if (followingKnown !== noFollowing && !before.has(followingKnown)) before.set(followingKnown, rows)
  }

  for (const rows of before.values()) rows.reverse()
  appended.reverse()
  const result: T[] = []
  const emitted = new Set<unknown>()
  for (const value of merged) {
    const key = keyOf(value)
    if (!emitted.has(key)) {
      const insertions = before.get(key)
      if (insertions !== undefined) {
        for (const insertion of insertions) result.push(insertion)
      }
      emitted.add(key)
    }
    result.push(value)
  }
  for (const value of appended) result.push(value)
  return result
}

/** Insert duplicate baseline identities relative to the next identity already merged. */
function mergeOrderedBaselineWithDuplicates<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => unknown,
): T[] {
  const baselineByKey = new Map<unknown, T>()
  for (const value of baseline) baselineByKey.set(keyOf(value), value)

  const merged = current
    .map(value => baselineByKey.get(keyOf(value)))
    .filter((value): value is T => value !== undefined)
  const mergedKeys = new Set(merged.map(keyOf))

  for (let index = 0; index < baseline.length; index++) {
    const value = baseline[index]
    /* v8 ignore next -- dense-array guard: index is bounded by baseline.length. */
    if (value === undefined || mergedKeys.has(keyOf(value))) continue
    let insertion = merged.length
    for (let following = index + 1; following < baseline.length; following++) {
      const candidate = baseline[following]
      /* v8 ignore next -- dense-array guard: following is bounded by baseline.length. */
      if (candidate === undefined) continue
      const known = merged.findIndex(item => keyOf(item) === keyOf(candidate))
      if (known !== -1) {
        insertion = known
        break
      }
    }
    merged.splice(insertion, 0, value)
    mergedKeys.add(keyOf(value))
  }
  return merged
}
