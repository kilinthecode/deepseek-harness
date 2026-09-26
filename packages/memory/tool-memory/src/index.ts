/**
 * Model-facing durable memory: `memory_write`, `memory_recall`, and
 * `memory_forget` over `ctx.memory`, the memory snapshot injected once per
 * conversation surface generation, and the prompt section that says when to remember. Named exports
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
import { SNAPSHOT_MIN_BYTES } from './catalog.ts'

export { SNAPSHOT_HEADER, SNAPSHOT_MIN_BYTES, renderSnapshot } from './catalog.ts'
export type { MemoryCatalogState } from './catalog.ts'
export { MEMORY_SECTION_TEXT } from './prompt.ts'

/** Cordis plugin name; also the `source.kind` of every injected snapshot. */
export const name = 'tool-memory'

/** Services the tools, the snapshot, and the prompt section register into. */
export const inject = ['memory', 'tools', 'sessionProjections', 'systemPrompt']

/** Model-facing memory configuration. Invalid values fail plugin load. */
export interface Config {
  /**
   * UTF-8 byte budget of the injected snapshot. `0` disables injection while
   * the tools stay available; a positive budget below {@link SNAPSHOT_MIN_BYTES}
   * fails load; a budget that cuts entries adds a line
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
 * Register the prompt section, the three tools, the snapshot projection, and
 * the snapshot injection for the lifetime of `ctx`.
 * @param ctx - registrant context; every registration disposes with it.
 * @param config - snapshot budget and recall cap.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.injectMaxBytes > 0 && config.injectMaxBytes < SNAPSHOT_MIN_BYTES) {
    throw new Error(
      `injectMaxBytes must be 0 or at least ${String(SNAPSHOT_MIN_BYTES)} (UTF-8 bytes of the snapshot header plus the omission line)`,
    )
  }
  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: ctx.systemPrompt.getSectionOrder('TOOL_MEMORY'),
    text: MEMORY_SECTION_TEXT,
  })
  registerMemoryTools(ctx, config.maxRecallResults)
  registerCatalogInjection(ctx, config.injectMaxBytes)
}
