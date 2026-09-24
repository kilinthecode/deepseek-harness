/**
 * Model-facing durable memory: `memory_write`, `memory_recall`, and
 * `memory_forget` over `ctx.memory`, the memory catalog injected into each
 * session, and the prompt section that says when to remember. Named exports
 * preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-memory'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { registerCatalogInjection } from './catalog.ts'
import { MEMORY_SECTION_TEXT } from './prompt.ts'
import { registerMemoryTools } from './tools.ts'

export { EMPTY_CATALOG_TEXT, renderCatalog } from './catalog.ts'
export type { MemoryCatalogState } from './catalog.ts'
export { MEMORY_SECTION_TEXT } from './prompt.ts'

/** Cordis plugin name; also the `source.kind` of every injected catalog. */
export const name = 'tool-memory'

/** Services the tools, the catalog, and the prompt section register into. */
export const inject = ['memory', 'tools', 'sessionProjections', 'systemPrompt']

/** Model-facing memory configuration. Invalid values fail plugin load. */
export interface Config {
  /**
   * UTF-8 byte budget of the injected catalog. `0` disables injection while
   * the tools stay available; a positive budget that cuts entries adds a line
   * saying how many were omitted.
   */
  injectMaxBytes: number
  /** Most records one `memory_recall` call returns. */
  maxRecallResults: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  injectMaxBytes: z.number().step(1).min(0).required(),
  maxRecallResults: z.number().step(1).min(1).required(),
})

/**
 * Register the prompt section, the three tools, the catalog projection, and
 * the catalog injection for the lifetime of `ctx`.
 * @param ctx - registrant context; every registration disposes with it.
 * @param config - catalog budget and recall cap.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: ctx.systemPrompt.getSectionOrder('TOOL_MEMORY'),
    text: MEMORY_SECTION_TEXT,
  })
  registerMemoryTools(ctx, config.maxRecallResults)
  registerCatalogInjection(ctx, config.injectMaxBytes)
}
