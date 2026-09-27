/**
 * Delegation-tree root resolution over durable session-header lineage.
 *
 * @module dsh-session/delegation
 */

import type { SessionHeader, SessionId } from './types.ts'

/**
 * The delegation tree's root session id, shared by every request in the tree
 * for provider cache-routing: a top-level session (no `parentSession`) is its
 * own root. A delegated child walks `parentSession` upward through
 * `lookupHeader`, which resolves one ancestor's header from the current
 * session registry rather than from a live parent `Agent` — so a
 * cold-resumed child derives the same root purely from its own header
 * lineage. The walk stops at the furthest ancestor `lookupHeader` still
 * resolves: an ancestor it cannot resolve (already ended, or not currently
 * loaded in this process) makes that ancestor's own id the returned root, the
 * nearest ancestor this process can still name. A cyclic lineage (data
 * corruption; the store never produces one through ordinary creation) stops
 * the walk the same way instead of looping forever.
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
