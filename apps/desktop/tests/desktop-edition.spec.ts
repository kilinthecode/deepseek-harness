import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveDesktopClientBuildProfile, resolveDesktopEdition } from '../scripts/desktop-release-environment.mjs'

describe('Desktop edition', () => {
  it('defaults to Portal and derives its packaging and runtime identities', () => {
    expect(resolveDesktopEdition({})).toEqual({
      edition: 'portal',
      productName: 'Portal',
      artifactNamePrefix: 'deepseek-harness',
      updateChannel: 'nightly',
      defaultDshHomeDirectoryName: '.dsh',
      displayName: 'Portal Harness',
      clientBuildProfile: 'portal',
    })
  })

  it('derives the distinct Portal Dev identities', () => {
    expect(resolveDesktopEdition({ DSH_DESKTOP_EDITION: 'portal-dev' })).toEqual({
      edition: 'portal-dev',
      productName: 'Portal Dev',
      artifactNamePrefix: 'portal-dev',
      updateChannel: 'dev',
      defaultDshHomeDirectoryName: '.dsh-dev',
      displayName: 'Portal Dev Harness',
      clientBuildProfile: 'portal-dev',
    })
  })

  it('rejects an unknown edition with the variable name', () => {
    expect(() => resolveDesktopEdition({ DSH_DESKTOP_EDITION: 'staging' }))
      .toThrow(/DSH_DESKTOP_EDITION.*portal.*portal-dev/u)
  })
})

describe('Desktop client build profile', () => {
  it('pairs each edition with the profile that renders its own brand', () => {
    expect(resolveDesktopClientBuildProfile({})).toBe('portal')
    expect(resolveDesktopClientBuildProfile({ DSH_DESKTOP_EDITION: 'portal-dev' })).toBe('portal-dev')
  })

  it('builds each selected profile through a repository script that names it', () => {
    // Packaging runs `build:<profile>`; a missing or differently named script
    // would only surface as a failed release stage.
    const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const edition of ['portal', 'portal-dev'] as const) {
      const profile = resolveDesktopClientBuildProfile({ DSH_DESKTOP_EDITION: edition })
      expect(manifest.scripts[`build:${profile}`]).toBe(`tsx scripts/build.ts --profile ${profile}`)
    }
  })

  it('accepts the edition’s own profile as an explicit selection', () => {
    expect(resolveDesktopClientBuildProfile({
      DSH_DESKTOP_EDITION: 'portal-dev',
      DSH_BUILD_CLIENT_PROFILE: 'portal-dev',
    })).toBe('portal-dev')
  })

  it('rejects a selection that contradicts the edition instead of shipping its brand', () => {
    expect(() => resolveDesktopClientBuildProfile({
      DSH_DESKTOP_EDITION: 'portal-dev',
      DSH_BUILD_CLIENT_PROFILE: 'portal',
    })).toThrow(/DSH_BUILD_CLIENT_PROFILE.*"portal".*"portal-dev".*"portal-dev"/u)
    expect(() => resolveDesktopClientBuildProfile({
      DSH_DESKTOP_EDITION: 'portal',
      DSH_BUILD_CLIENT_PROFILE: 'official',
    })).toThrow(/DSH_BUILD_CLIENT_PROFILE.*"official".*"portal".*"portal"/u)
  })
})
