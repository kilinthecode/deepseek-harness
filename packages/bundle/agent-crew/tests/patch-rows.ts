/**
 * Rows read from the shipped patch files, so the composition specs follow the
 * YAML instead of a hand-copied literal: the agent-crew patch, the `dsh-base`
 * patch, and the `standard` Web preset whose nested `tool-subagent` row an
 * id-targeted patch cannot reach.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import SubagentWorktrees from '@deepseek-ai/dsh-subagent-worktree'
import type { Config as WorktreesConfig } from '@deepseek-ai/dsh-subagent-worktree'
import type * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'

const PATCH_FILES = {
  agentCrew: '../cordis.patch.yml',
  base: '../../base/cordis.patch.yml',
  standardPreset: '../../web-app/presets/standard.patch.yml',
} as const

/** A patch or loader row as far as these specs read it. */
interface PatchRow {
  id?: string
  config?: unknown
}

/** The first row with this id in a parsed patch list, searching insert lists, group configs, and preset plugin lists. */
function search(node: unknown, id: string): PatchRow | undefined {
  if (Array.isArray(node)) return node.map(item => search(item, id)).find(hit => hit !== undefined)
  if (typeof node !== 'object' || node === null) return undefined
  const row = node as PatchRow & { insert?: unknown }
  if (row.id === id) return row
  const nested = typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
    ? (row.config as { plugins?: unknown }).plugins
    : row.config
  return search(row.insert, id) ?? search(nested, id)
}

/**
 * Read one row from a shipped patch file.
 * @param file - which patch file to read.
 * @param id - the row id to find.
 * @returns the row, with its config exactly as written in the YAML.
 */
function patchRow(file: keyof typeof PATCH_FILES, id: string): PatchRow {
  const parsed = yaml.load(readFileSync(fileURLToPath(new URL(PATCH_FILES[file], import.meta.url)), 'utf8'), {
    schema: entryListSchema,
  })
  const row = search(parsed, id)
  if (row === undefined) throw new Error(`the ${file} patch file has no "${id}" row`)
  return row
}

/** The `tool-subagent` config `dsh-base` mounts at the Host level, which the agent-crew bundle leaves untouched. */
export function hostToolSubagentConfig(): ToolSubagent.Config {
  return patchRow('base', 'tool-subagent').config as ToolSubagent.Config
}

/** The `tool-subagent` config the `standard` Web preset mounts inside each agent's scope. */
export function presetToolSubagentConfig(): ToolSubagent.Config {
  return patchRow('standardPreset', 'tool-subagent').config as ToolSubagent.Config
}

/**
 * The `subagent-worktree` service config the agent-crew patch sets, completed by the schema's defaults as the
 * Loader completes it.
 * @param overrides - fields a test replaces, such as a temporary `root`.
 * @returns the complete service config.
 */
export function crewWorktreesConfig(overrides: Partial<WorktreesConfig> = {}): WorktreesConfig {
  const patched = patchRow('agentCrew', 'subagent-worktree').config as Partial<WorktreesConfig>
  return SubagentWorktrees.Config({ ...patched, ...overrides } as WorktreesConfig)
}

/** The `subagent-worktree` service config of a profile without the bundle: the base row carries none, so every default. */
export function shippedWorktreesConfig(): WorktreesConfig {
  return SubagentWorktrees.Config()
}
