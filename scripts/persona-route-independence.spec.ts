/**
 * No shipped bundle's persona prefix or suffix interpolates a route variable
 * (`{{model}}`, `{{provider}}`): doing so would change the rendered system
 * prompt — surface node 0 — on every model switch (see
 * packages/core/system-prompt/README.md#kv-cache-effect and
 * .agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md).
 * This complements the real-composition assertion in
 * apps/cli/tests/web-agent-presets.e2e.ts (Web-only) by reading every shipped
 * bundle's own patch rows directly, including headless/sdk-app/acp-app, which
 * that Loader boot does not mount.
 */

import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOverlayPatches } from '../packages/boot/app-boot/src/index.ts'
import { bundlePatchPaths } from '../packages/boot/app-boot/src/profile.ts'
import type { DshBundleManifest } from '../packages/util/package-manifest/src/types.ts'

const root = resolve(import.meta.dirname, '..')

interface Manifest {
  name: string
  dsh?: { bundle?: DshBundleManifest }
}

/** Every workspace package that declares a Cordis bundle patch. */
const shippedBundles = globSync('packages/*/*/package.json', { cwd: root })
  .map((path) => {
    const dir = dirname(resolve(root, path))
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Manifest
    return { dir, manifest }
  })
  .filter(entry => entry.manifest.dsh?.bundle !== undefined)

/**
 * Persona prefix/suffix strings a bundle's patch rows declare, at any nesting
 * depth: a base `system-prompt` row override (`personaPrefix`/`personaSuffix`)
 * and a preset's `@deepseek-ai/dsh-persona` plugin row (`prefix`/`suffix`).
 * `PatchOptions`/`EntryOptions` config is untyped (`any`) at this file-loading
 * boundary, so the walk narrows with `typeof` rather than trusting a static shape.
 */
function personaTexts(patches: readonly unknown[]): string[] {
  const texts: string[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node === null || typeof node !== 'object') return
    const row = node as { id?: unknown; name?: unknown; config?: unknown }
    if (typeof row.config === 'object' && row.config !== null) {
      const config = row.config as Record<string, unknown>
      if (row.name === '@deepseek-ai/dsh-persona') {
        if (typeof config.prefix === 'string') texts.push(config.prefix)
        if (typeof config.suffix === 'string') texts.push(config.suffix)
      }
      if (row.id === 'system-prompt' || row.name === '@deepseek-ai/dsh-system-prompt') {
        if (typeof config.personaPrefix === 'string') texts.push(config.personaPrefix)
        if (typeof config.personaSuffix === 'string') texts.push(config.personaSuffix)
      }
    }
    for (const value of Object.values(row)) visit(value)
  }
  visit(patches)
  return texts
}

describe('shipped persona text names no route', () => {
  it.each(shippedBundles)('$manifest.name declares no persona prefix/suffix that interpolates a route variable', ({ dir, manifest }) => {
    const bundle = manifest.dsh?.bundle
    if (bundle === undefined) throw new Error(`${manifest.name} lost its bundle manifest between discovery and the test body`)
    const patches = bundlePatchPaths(dir, bundle).flatMap(file => loadOverlayPatches('test', file))
    for (const text of personaTexts(patches)) {
      expect(text).not.toContain('{{model}}')
      expect(text).not.toContain('{{provider}}')
    }
  })

  it('inspects at least one real persona declaration (the check above is not vacuous)', () => {
    const allTexts = shippedBundles.flatMap(({ dir, manifest }) => {
      const bundle = manifest.dsh?.bundle
      if (bundle === undefined) return []
      const patches = bundlePatchPaths(dir, bundle).flatMap(file => loadOverlayPatches('test', file))
      return personaTexts(patches)
    })
    expect(allTexts).toContain('You are a coding agent.')
  })
})
