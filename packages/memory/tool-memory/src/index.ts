/**
 * Model-facing durable memory: `memory_write`, `memory_recall`, and
 * `memory_forget` over `ctx.memory`, the memory snapshot injected once per
 * conversation surface generation, and the prompt section that says when to remember. Named exports
 * preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { MEMORY_DESCRIPTION_MAX_CHARS } from '@deepseek-ai/dsh-memory'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-memory'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { registerCatalogInjection, SNAPSHOT_MIN_BYTES } from './catalog.ts'
import { MEMORY_SECTION_TEXT } from './prompt.ts'
import { registerMemoryTools } from './tools.ts'

export { SNAPSHOT_HEADER, SNAPSHOT_MIN_BYTES, renderSnapshot } from './catalog.ts'
export type { MemoryCatalogState } from './catalog.ts'
export { MEMORY_SECTION_TEXT } from './prompt.ts'
export { createMemoryWriteTool } from './tools.ts'
export type { MemoryWriteToolOptions } from './tools.ts'

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
  /**
   * UTF-8 byte cap for complete `memory_recall` text, including separators and
   * the omission hint. Must fit one `ctx.memory.maxRecordBytes` body with the
   * largest name, type, scope, and description; smaller values fail plugin load.
   */
  maxRecallBytes: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  injectMaxBytes: z.number().step(1).min(0).required(),
  maxRecallResults: z.number().step(1).min(1).required(),
  maxRecallBytes: z.number().step(1).min(1).required(),
})

/** Maximum rendered bytes outside one memory body, including a possible omission hint. */
function recallOverheadBytes(): number {
  const heading = `## ${'n'.repeat(64)} [reference, project]\n`
  // U+20AC uses three UTF-8 bytes for each allowed UTF-16 code unit.
  const description = '€'.repeat(MEMORY_DESCRIPTION_MAX_CHARS)
  return Buffer.byteLength(`${heading}${description}\n\n\n\nMore matches; narrow query or scope.`, 'utf8')
}

/**
 * Register the prompt section, the three tools, the snapshot projection, and
 * the snapshot injection for the lifetime of `ctx`.
 * @param ctx - registrant context; every registration disposes with it.
 * @param config - snapshot budget and recall result and byte caps.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.injectMaxBytes > 0 && config.injectMaxBytes < SNAPSHOT_MIN_BYTES) {
    throw new Error(
      `injectMaxBytes must be 0 or at least ${String(SNAPSHOT_MIN_BYTES)} (UTF-8 bytes of the snapshot header plus the omission line)`,
    )
  }
  const minRecallBytes = ctx.memory.maxRecordBytes + recallOverheadBytes()
  if (config.maxRecallBytes < minRecallBytes) {
    throw new Error(`maxRecallBytes must be at least ${String(minRecallBytes)} UTF-8 bytes (one maximum-size memory with heading, description, separators, and omission hint)`)
  }
  ctx.systemPrompt.section({
    name: 'tool:memory',
    order: ctx.systemPrompt.getSectionOrder('TOOL_MEMORY'),
    text: MEMORY_SECTION_TEXT,
  })
  registerMemoryTools(ctx, config.maxRecallResults, config.maxRecallBytes)
  registerCatalogInjection(ctx, config.injectMaxBytes)
}
