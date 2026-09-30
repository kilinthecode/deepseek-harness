import { describe, expect, it } from 'vitest'
import { resolveDesktopEdition } from '../scripts/desktop-release-environment.mjs'

describe('Desktop edition', () => {
  it('defaults to Portal and derives its packaging and runtime identities', () => {
    expect(resolveDesktopEdition({})).toEqual({
      edition: 'portal',
      productName: 'Portal',
      artifactNamePrefix: 'deepseek-harness',
      updateChannel: 'nightly',
      defaultDshHomeDirectoryName: '.dsh',
      displayName: 'Portal Harness',
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
    })
  })

  it('rejects an unknown edition with the variable name', () => {
    expect(() => resolveDesktopEdition({ DSH_DESKTOP_EDITION: 'staging' }))
      .toThrow(/DSH_DESKTOP_EDITION.*portal.*portal-dev/u)
  })
})
