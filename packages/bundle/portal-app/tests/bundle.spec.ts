/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list whose rows mount this app's
 * command-line provider and the driver that consumes it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { PORTAL_STARTUP_SERVICE } from '../src/index.ts'

/** One loader row as the patch list declares it. */
interface PatchRow {
  id?: string
  name?: string
  inject?: string[]
  config?: Record<string, unknown>
  disabled?: boolean
}

describe('dsh-portal-app bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies?.['@deepseek-ai/dsh-headless']).toBe('workspace:*')
    const patchPath = resolve(root, manifest.dsh!.bundle!.patch!)
    expect(existsSync(patchPath)).toBe(true)
    const parsed = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)

    const rows = (parsed as { insert?: PatchRow[] }[]).flatMap(patch => patch.insert ?? [])
    expect(rows.map(row => row.id)).toEqual(['portal-startup', 'portal-runner'])

    const startup = rows.find(row => row.id === 'portal-startup')
    expect(startup?.name).toBe('@deepseek-ai/dsh-portal-app')

    // The driver row is the shared one-shot runner, fed by this app's provider.
    const runner = rows.find(row => row.id === 'portal-runner')
    expect(runner?.name).toBe('@deepseek-ai/dsh-portal-app/runner')
    expect(runner?.inject).toEqual([PORTAL_STARTUP_SERVICE])
    expect(runner?.config).toEqual({
      interactive: { __jsExpr: 'ctx.portalStartup.interactive' },
      discovery: { __jsExpr: 'ctx.portalStartup.discovery' },
      task: { __jsExpr: 'ctx.portalStartup.task' },
      sessionId: { __jsExpr: 'ctx.portalStartup.sessionId' },
      json: { __jsExpr: 'ctx.portalStartup.json' },
      images: { __jsExpr: 'ctx.portalStartup.images' },
      modelSelection: { __jsExpr: 'ctx.portalStartup.modelSelection' },
    })

    // This app runs headless-style one-shot work, so config reloads stay off.
    expect((parsed as { id?: string; disabled?: boolean }[]).find(row => row.id === 'hmr')).toMatchObject({ disabled: true })
  })
})
