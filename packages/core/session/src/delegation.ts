/**
 * Delegation-tree root resolution over durable session-header lineage.
 *
 * @module dsh-session/delegation
 */

import type { SessionHeader, SessionId } from './types.ts'

/**
 * The delegation tree's root session id, shared by every request in the tree
 * for provider cache-routing. The walk follows `parentSession` upward through
 * headers `lookupHeader` can resolve, and returns the id of the first
 * ancestor whose header does not resolve — known from the last resolvable
 * header's own `parentSession` field, even though that ancestor's own header
 * could not be loaded (already ended, or not currently loaded in this
 * process) — or the top-level ancestor's own id when every header up to it
 * resolves. A disposed root therefore still keys the whole tree, because its
 * child already knows its id even though its own header is gone; an unloaded
 * intermediate ancestor instead keys only its own subtree, because the walk
 * cannot see past it to whatever lies beyond. `lookupHeader` resolves one
 * ancestor's header from the current session registry, never from a live
 * parent `Agent`. A cyclic lineage (data corruption; the store never produces
 * one through ordinary creation) stops the walk the same way instead of
 * looping forever.
 * @param header - the current session's own durable header.
 * @param lookupHeader - resolve one ancestor session's header; `undefined` when it is not currently loadable.
 * @returns the resolved root session id.
 */
export function delegationTreeRoot(
  header: SessionHeader,
  lookupHeader: (id: SessionId) => SessionHeader | undefined,
): SessionId {
  const seen = new Set<SessionId>([header.id])
  let current = header
  while (current.parentSession !== undefined) {
    const parentId = current.parentSession
    if (seen.has(parentId)) return parentId
    const parentHeader = lookupHeader(parentId)
    if (parentHeader === undefined) return parentId
    seen.add(parentId)
    current = parentHeader
  }
  return current.id
}
