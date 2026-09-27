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
import { dirname, join, resolve } from 'node:path'
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

/** Absolute path of every patch file every shipped bundle declares, in bundle then file order. */
const scannedFiles = shippedBundles.flatMap(({ dir, manifest }) => {
  const bundle = manifest.dsh?.bundle
  return bundle === undefined ? [] : bundlePatchPaths(dir, bundle)
})

/**
 * The checkable text of one persona field's value: a plain string, or the
 * source text of a `!!js` expression (parsed by the Loader's YAML schema into
 * `{ __jsExpr: string }`). A deployment-provided runtime value inside such an
 * expression (an env var, a config lookup) cannot be known statically, but a
 * literal `{{model}}`/`{{provider}}` authored directly in the expression
 * source — for example a fallback string like `env ?? 'powered by {{model}}'`
 * — still appears in that source text, so checking it catches that case too.
 */
function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string') {
    return (value as { __jsExpr: string }).__jsExpr
  }
  return undefined
}

/**
 * Persona prefix/suffix strings a patch file's rows declare, at any nesting
 * depth: a base `system-prompt` row override (`personaPrefix`/`personaSuffix`)
 * and a preset's `@deepseek-ai/dsh-persona` plugin row (`prefix`/`suffix`).
 * `PatchOptions`/`EntryOptions` config is untyped (`any`) at this file-loading
 * boundary, so the walk narrows with `typeof` rather than trusting a static shape.
 */
function personaTexts(file: string): string[] {
  const texts: string[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node === null || typeof node !== 'object') return
    const row = node as { id?: unknown; name?: unknown; config?: unknown }
    if (typeof row.config === 'object' && row.config !== null) {
      const config = row.config as Record<string, unknown>
      if (row.name === '@deepseek-ai/dsh-persona') {
        const prefix = textValue(config.prefix)
        const suffix = textValue(config.suffix)
        if (prefix !== undefined) texts.push(prefix)
        if (suffix !== undefined) texts.push(suffix)
      }
      if (row.id === 'system-prompt' || row.name === '@deepseek-ai/dsh-system-prompt') {
        const personaPrefix = textValue(config.personaPrefix)
        const personaSuffix = textValue(config.personaSuffix)
        if (personaPrefix !== undefined) texts.push(personaPrefix)
        if (personaSuffix !== undefined) texts.push(personaSuffix)
      }
    }
    for (const value of Object.values(row)) visit(value)
  }
  visit(loadOverlayPatches('test', file))
  return texts
}

/** Raw-YAML marker for "this file declares a persona row", independent of the structural walk above. */
const PERSONA_MARKERS = ['personaPrefix', 'personaSuffix', 'dsh-persona']

describe('shipped persona text names no route', () => {
  it.each(scannedFiles)('%s declares no persona prefix/suffix that interpolates a route variable', (file) => {
    for (const text of personaTexts(file)) {
      expect(text).not.toContain('{{model}}')
      expect(text).not.toContain('{{provider}}')
    }
  })

  it('walks every shipped patch file, and every persona-bearing file contributes a checked string', () => {
    expect(scannedFiles.length).toBeGreaterThan(0)

    // Independent cross-check: a raw-text marker scan (not the structural walk
    // `personaTexts` performs) names every file that SHOULD declare a persona
    // row. The walk must have actually extracted a string from each one, or it
    // silently missed a nesting shape (a `group: true` row, a differently
    // spelled key, an `insert` this walk doesn't descend into, ...) and the
    // per-file check above would pass vacuously on an empty text list.
    const personaBearingFiles = scannedFiles.filter(file =>
      PERSONA_MARKERS.some(marker => readFileSync(file, 'utf8').includes(marker)))
    expect(personaBearingFiles.length).toBeGreaterThan(0)
    for (const file of personaBearingFiles) {
      expect(personaTexts(file).length, `${file} declares a persona marker but the walk found no text`).toBeGreaterThan(0)
    }

    // The three edited Web presets are the change this test exists to guard:
    // name them explicitly so a future rename or a manifest edit that silently
    // drops one of them from `dsh.bundle.patch` turns this test red instead of
    // just leaving it quieter.
    const webApp = shippedBundles.find(entry => entry.manifest.name === '@deepseek-ai/dsh-web-app')
    if (webApp === undefined) throw new Error('the @deepseek-ai/dsh-web-app bundle was not discovered')
    const editedPresets = ['standard', 'ptc', 'cordis'].map(name => join(webApp.dir, 'presets', `${name}.patch.yml`))
    for (const file of editedPresets) {
      expect(scannedFiles, `${file} must be a scanned file`).toContain(file)
      expect(personaTexts(file).length, `${file} must contribute at least one checked persona string`).toBeGreaterThan(0)
    }
  })

  it('inspects at least one real persona declaration (the check above is not vacuous)', () => {
    const allTexts = scannedFiles.flatMap(personaTexts)
    expect(allTexts).toContain('You are a coding agent.')
  })
})
