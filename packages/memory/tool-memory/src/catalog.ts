/**
 * The memory snapshot: visible records inlined or indexed within a byte
 * budget, injected as a durable user-role message once per conversation
 * surface generation. `memoryCatalog` folds `step/start` to a pending step,
 * a committed `user/message` while pending (or this plugin's own snapshot
 * message unconditionally) to `{ taken: true }`, `step/end` to not-pending,
 * and `compaction/summary` to `{ taken: false, stepPending: false }`.
 * Replay rebuilds every model request from the log.
 * @module @deepseek-ai/dsh-tool-memory/src/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { MEMORY_TYPES, compareStoredText } from '@deepseek-ai/dsh-memory'
import type { MemoryRecord, MemoryScanFinding, MemoryType, MemoryVisible } from '@deepseek-ai/dsh-memory'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Memory snapshot attribution; readers preserve the content without this producer.
     * Its projection uses the kind to mark a surface generation as taken.
     * @persistenceAttribution
     */
    'tool-memory': { kind: 'tool-memory' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Whether this surface generation has already taken its snapshot opportunity. */
    memoryCatalog: MemoryCatalogState
  }
}

const memoryCatalogStateSchema = zod.object({
  taken: zod.boolean(),
  /**
   * A step has logged `step/start` but its `agent/request`/`prepareCall`
   * route resolution has not yet committed a `user/message`: cancellation
   * during that async phase commits neither the system prompt nor the
   * step's accepted messages, so this stays the only record that a step
   * began until either a message actually lands or the step ends.
   */
  stepPending: zod.boolean(),
})

/** Folded snapshot-injection state. */
export type MemoryCatalogState = zod.infer<typeof memoryCatalogStateSchema>

/** First line of every injected snapshot. */
export const SNAPSHOT_HEADER = 'Saved memories (snapshot):'

const OMISSION_LINE_AT_MAX_COUNT = '… 9999999 more; use memory_recall'

/**
 * Smallest positive `injectMaxBytes` that can hold the header plus an
 * omission line whose count uses seven decimal digits.
 */
export const SNAPSHOT_MIN_BYTES = Buffer.byteLength(
  `${SNAPSHOT_HEADER}\n${OMISSION_LINE_AT_MAX_COUNT}`,
  'utf8',
)

const TYPE_RANK = Object.fromEntries(MEMORY_TYPES.map((type, index) => [type, index])) as Record<MemoryType, number>

type SnapshotItem =
  | { readonly kind: 'block'; readonly text: string }
  | { readonly kind: 'index'; readonly text: string }

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function bySnapshotOrder(left: MemoryRecord, right: MemoryRecord): number {
  return TYPE_RANK[left.type] - TYPE_RANK[right.type]
    || compareStoredText(left.name, right.name)
    || (left.scope === 'global' ? 0 : 1) - (right.scope === 'global' ? 0 : 1)
}

function recallBlock(record: MemoryRecord): string {
  return `## ${record.name} [${record.type}, ${record.scope}]\n${record.description}\n\n${record.content}`
}

function indexLine(record: MemoryRecord): string {
  return `- [${record.type}, ${record.scope}] ${record.name} — ${record.description}`
}

function blockedIndexLine(record: MemoryRecord): string {
  return `- [${record.type}, ${record.scope}] ${record.name} — [blocked]`
}

function compose(items: readonly SnapshotItem[], omitted: number): string {
  const parts: string[] = [SNAPSHOT_HEADER]
  let previous: SnapshotItem['kind'] | undefined
  for (const item of items) {
    if (item.kind === 'block') {
      if (previous !== undefined) parts.push('')
      parts.push(item.text)
    } else {
      if (previous === 'block') parts.push('')
      parts.push(item.text)
    }
    previous = item.kind
  }
  if (omitted > 0) parts.push(`… ${omitted} more; use memory_recall`)
  return parts.join('\n')
}

function flattenVisible(visible: MemoryVisible): MemoryRecord[] {
  return [...visible.global, ...visible.project?.records ?? []]
}

/**
 * Render a snapshot of visible memories within a UTF-8 byte budget.
 * Records sort by type (user, feedback, project, reference), then name,
 * then global before project. A record whose description or content fails
 * `scan` is never inlined. Greedy fill emits a recall block when it fits,
 * otherwise an index line when that fits, otherwise omits the record.
 * When any record is omitted, an omission line is appended and trailing
 * index lines (then trailing entries) are dropped until the complete text
 * is within `maxBytes`. Content blocks are separated from each other and
 * from the index-line group by one blank line; consecutive index lines are
 * adjacent; the omission line follows the last entry with no extra blank line.
 * @param records - visible memories in any order; this function sorts them.
 * @param maxBytes - UTF-8 byte budget for the complete text.
 * @param scan - threat scan; a finding on description or content blocks the record.
 * @returns the snapshot text, or `undefined` when `records` is empty or the budget cannot hold the header.
 */
export function renderSnapshot(
  records: readonly MemoryRecord[],
  maxBytes: number,
  scan: (text: string) => MemoryScanFinding | undefined,
): string | undefined {
  const ordered = [...records].sort(bySnapshotOrder)
  if (ordered.length === 0) return undefined
  const items: SnapshotItem[] = []
  let omitted = 0
  for (const record of ordered) {
    const blocked = scan(record.description) !== undefined || scan(record.content) !== undefined
    if (!blocked) {
      const blockItem: SnapshotItem = { kind: 'block', text: recallBlock(record) }
      if (utf8Bytes(compose([...items, blockItem], 0)) <= maxBytes) {
        items.push(blockItem)
        continue
      }
    }
    const indexItem: SnapshotItem = {
      kind: 'index',
      text: blocked ? blockedIndexLine(record) : indexLine(record),
    }
    if (utf8Bytes(compose([...items, indexItem], 0)) <= maxBytes) {
      items.push(indexItem)
      continue
    }
    omitted += 1
  }
  if (omitted === 0) return compose(items, 0)
  for (;;) {
    const text = compose(items, omitted)
    if (utf8Bytes(text) <= maxBytes) return text
    const dropAt = items.findLastIndex(item => item.kind === 'index')
    if (dropAt === -1) {
      // An empty item list rendered `text` as header plus omission line, which did not fit.
      if (items.pop() === undefined) return undefined
      omitted += 1
      continue
    }
    items.splice(dropAt, 1)
    omitted += 1
  }
}

/**
 * Register the `memoryCatalog` projection and the prepended `agent/pre-step`
 * listener that injects the snapshot. Every snapshot message carries the
 * `tool-memory` source kind. `maxBytes === 0` keeps the projection but never injects.
 * @param ctx - plugin context carrying `memory` and `sessionProjections`; both registrations dispose with it.
 * @param maxBytes - snapshot byte budget; `0` keeps the projection but never injects.
 */
export function registerCatalogInjection(ctx: Context, maxBytes: number): void {
  ctx.sessionProjections.register({
    key: 'memoryCatalog',
    stateVersion: 3,
    stateSchema: memoryCatalogStateSchema,
    init: () => ({ taken: false, stepPending: false }),
    apply: (state, event) => {
      // `step/start` logs before `agent/request`/`prepareCall` resolve the
      // route; cancellation during that async phase commits neither the
      // system prompt nor the step's messages (docs/architecture.md, agent
      // loop section). Marking `taken` here, before any message is known to
      // have landed, would spend the opportunity on a step whose snapshot
      // was never durably logged.
      if (event.type === 'step/start') return state.taken ? state : { ...state, stepPending: true }
      if (event.type === 'step/end') return state.stepPending ? { ...state, stepPending: false } : state
      if (event.type === 'user/message') {
        const source = event.data.source
        // This plugin's own snapshot message marks the opportunity taken
        // regardless of `stepPending`: a fork child's seed can carry the
        // parent's snapshot message without the parent's `step/start` rows.
        if (source.kind === 'tool-memory' && source.form === 'snapshot') {
          return state.taken ? state : { taken: true, stepPending: false }
        }
        // Any other committed message (the claimed user message, runtime
        // context, …) proves the pending step's messages survived
        // cancellation, so the snapshot opportunity for this step is truly
        // spent now, whether or not it injected anything.
        if (state.stepPending) return { taken: true, stepPending: false }
        return state
      }
      if (event.type === 'compaction/summary') {
        return state.taken || state.stepPending ? { taken: false, stepPending: false } : state
      }
      return state
    },
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const state = ctx.sessionProjections.stateOf(agent.session, 'memoryCatalog')
    if (state === undefined || state.taken || maxBytes === 0) return decision
    const text = renderSnapshot(
      flattenVisible(await ctx.memory.visible(agent.session.header.cwd)),
      maxBytes,
      scanned => ctx.memory.scan(scanned),
    )
    if (text === undefined) return decision
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'tool-memory', form: 'snapshot', sections: [{ name: 'memory-catalog', text }] },
        }),
      ],
    }
  }, { prepend: true })
}
