/**
 * The memory catalog: one line per visible memory, injected as durable
 * user-role context at the first step that has memories to show, at a later
 * turn's first step when the rendered catalog changed or the store emptied,
 * and at the next step after compaction shadowed the previous catalog. Whether
 * a step injects depends on the `memoryCatalog` projection of the session log
 * and on the store's current visible records; each injected catalog is an
 * ordinary logged message, so replay rebuilds every model request from the log.
 * @module @deepseek-ai/dsh-tool-memory/src/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { MEMORY_TYPES, compareStoredText } from '@deepseek-ai/dsh-memory'
import type { MemoryRecord, MemoryType, MemoryVisible } from '@deepseek-ai/dsh-memory'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Memory catalog attribution; readers preserve the content without this producer.
     * Its projection uses the kind to find the last injected catalog.
     * @persistenceAttribution
     */
    'tool-memory': { kind: 'tool-memory' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The catalog text this plugin last injected, or `null` before the first injection and after compaction. */
    memoryCatalog: MemoryCatalogState
  }
}

const memoryCatalogStateSchema = zod.object({
  lastCatalog: zod.string().nullable(),
})

/** Folded catalog-injection state. */
export type MemoryCatalogState = zod.infer<typeof memoryCatalogStateSchema>

const CATALOG_HEADER = 'Saved memories (catalog; call memory_recall to read one):'

/**
 * Catalog text injected when every memory a session had seen has been
 * forgotten: it supersedes the earlier catalog so the model stops relying on
 * entries that no longer exist. A store that was empty all along injects
 * nothing.
 */
export const EMPTY_CATALOG_TEXT = `${CATALOG_HEADER}\nNo saved memories.`

const TYPE_RANK = Object.fromEntries(MEMORY_TYPES.map((type, index) => [type, index])) as Record<MemoryType, number>

/** Catalog order within one section: type rank, then name. */
function byTypeThenName(left: MemoryRecord, right: MemoryRecord): number {
  return TYPE_RANK[left.type] - TYPE_RANK[right.type] || compareStoredText(left.name, right.name)
}

function catalogLines(records: readonly MemoryRecord[]): string[] {
  return [...records].sort(byTypeThenName).map(record => `- [${record.type}] ${record.name} — ${record.description}`)
}

function compose(globalLines: readonly string[], projectLines: readonly string[], omitted: number): string {
  const parts = [CATALOG_HEADER]
  if (globalLines.length > 0) parts.push('Global:', ...globalLines)
  if (projectLines.length > 0) parts.push('Project:', ...projectLines)
  if (omitted > 0) parts.push(`… ${omitted} more; use memory_recall`)
  return parts.join('\n')
}

/**
 * Render the catalog of visible memories within a UTF-8 byte budget. Global
 * entries precede project entries; within a section, entries sort by type
 * (user, feedback, project, reference) then name. When the budget cuts
 * entries, a final line states how many were omitted.
 * @param visible - the records visible from the session's working directory.
 * @param maxBytes - UTF-8 byte budget for the whole text.
 * @returns the catalog text, or `undefined` when no memory is visible.
 */
export function renderCatalog(visible: MemoryVisible, maxBytes: number): string | undefined {
  const globalLines = catalogLines(visible.global)
  const projectLines = catalogLines(visible.project?.records ?? [])
  const total = globalLines.length + projectLines.length
  if (total === 0) return undefined
  for (let kept = total; kept >= 0; kept -= 1) {
    const text = compose(
      globalLines.slice(0, kept),
      projectLines.slice(0, Math.max(0, kept - globalLines.length)),
      total - kept,
    )
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  }
  // Even the header plus the omission line exceeds the budget: tell the model
  // memories exist rather than hide them.
  return compose([], [], total)
}

/**
 * Register the `memoryCatalog` projection and, when `maxBytes` is positive,
 * the prepended `agent/pre-step` listener that injects the catalog.
 * Every catalog message carries the `tool-memory` source kind.
 * @param ctx - plugin context carrying `memory` and `sessionProjections`; both registrations dispose with it.
 * @param maxBytes - catalog byte budget; `0` keeps the projection but never injects.
 */
export function registerCatalogInjection(ctx: Context, maxBytes: number): void {
  ctx.sessionProjections.register({
    key: 'memoryCatalog',
    stateVersion: 1,
    stateSchema: memoryCatalogStateSchema,
    init: () => ({ lastCatalog: null }),
    apply: (state, event) => {
      if (event.type === 'user/message') {
        const source = event.data.source
        if (source.kind !== 'tool-memory' || source.form !== 'snapshot') return state
        return { lastCatalog: source.sections.map(section => section.text).join('') }
      }
      if (event.type === 'compaction/summary') {
        return state.lastCatalog === null ? state : { lastCatalog: null }
      }
      return state
    },
  })
  if (maxBytes <= 0) return

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const state = ctx.sessionProjections.stateOf(agent.session, 'memoryCatalog') as MemoryCatalogState
    // A catalog is on the surface: only a turn's first step re-checks the store.
    if (state.lastCatalog !== null && step !== 1) return decision
    const rendered = renderCatalog(await ctx.memory.visible(agent.session.header.cwd), maxBytes)
    const text = rendered ?? (state.lastCatalog === null ? undefined : EMPTY_CATALOG_TEXT)
    if (text === undefined || text === state.lastCatalog) return decision
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
