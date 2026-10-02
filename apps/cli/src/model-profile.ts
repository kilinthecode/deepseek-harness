/** Read saved model overrides from an existing profile without importing its application bundles. */

import { join } from 'node:path'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  loadOptionalPatches, readProfileManifest, PROFILE_PATCH_FILENAME, resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Shared base rows whose saved configuration is portable between product profiles. */
const MODEL_ROWS = new Map([
  ['agent-default-model', '@deepseek-ai/dsh-agent-default-model'],
  ['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai'],
  ['llm-deepseek', '@deepseek-ai/dsh-llm-deepseek-api-key'],
  ['llm-deepseek-account', '@deepseek-ai/dsh-llm-deepseek-account'],
  ['deepseek-llm-api-extensions', '@deepseek-ai/dsh-deepseek-llm-api-extensions'],
])

/**
 * Copy saved built-in model settings from an existing profile's user and home patches.
 * Portal supplies base defaults; the source's application bundles are not imported.
 * Credentials continue to resolve from the shared home.
 * @param source - exact existing profile name; no missing profile is initialized.
 * @param home - Harness home containing the source profile.
 * @returns invocation-local model overlays, before explicit --patch files.
 * @throws when the source is missing or inserts or replaces a shared model plugin.
 */
export function modelProfilePatches(source: string, home: string = resolveDshHome()): PatchOptions[] {
  const dir = resolveProfileDir(source, home)
  readProfileManifest('dsh portal --models-from', dir)
  const layers = [join(dir, PROFILE_PATCH_FILENAME), join(home, PROFILE_PATCH_FILENAME)]
  const patches: PatchOptions[] = []
  for (const file of layers) {
    for (const patch of loadOptionalPatches('portal', file) ?? []) {
      if (patch.insert?.some(row => MODEL_ROWS.has(row.id))) {
        throw new Error(`portal: profile "${source}" inserts a shared model row; configure that provider in the portal profile instead`)
      }
      if (patch.id === undefined || !MODEL_ROWS.has(patch.id)) continue
      if (patch.name !== undefined && patch.name !== MODEL_ROWS.get(patch.id)) {
        throw new Error(`portal: profile "${source}" replaces "${patch.id}"; configure that provider in the portal profile instead`)
      }
      const config: unknown = patch.config
      patches.push({
        id: patch.id,
        ...config === undefined ? {} : { config },
        ...patch.disabled === undefined ? {} : { disabled: patch.disabled },
      })
    }
  }
  return patches
}
