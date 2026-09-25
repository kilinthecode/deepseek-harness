/**
 * Fork-owned coverage for the Portal client build profile.
 *
 * `client-build-environment.client.spec.ts` is upstream-owned and covers the
 * `official` profile only. This spec owns the fork's profile so an upstream
 * sync never has to merge the two, and so the fork's values are asserted
 * exactly where they are defined.
 */

import { describe, expect, it } from 'vitest'
import { resolveClientBuildEnvironment } from './client-build-environment.ts'

const COMMIT_HASH = '0123456789abcdef0123456789abcdef01234567'
const VERSION = '1.2.3'

describe('Portal client build profile', () => {
  it('pins the fork product title and its own profile name', () => {
    expect(resolveClientBuildEnvironment({
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH,
      DSH_CLIENT_VERSION: VERSION,
    }, 'portal')).toEqual({
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH,
      DSH_CLIENT_VERSION: VERSION,
      DSH_CLIENT_BUILD_PROFILE: 'portal',
      DSH_CLIENT_TITLE: 'Portal Harness',
    })
  })

  it('keeps the upstream official values untouched', () => {
    // The fork's identity lives in its own profile precisely so this stays
    // upstream's answer; if a sync overwrites it, this fails loudly.
    expect(resolveClientBuildEnvironment({
      DSH_CLIENT_COMMIT_HASH: COMMIT_HASH,
      DSH_CLIENT_VERSION: VERSION,
    }, 'official')).toMatchObject({
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
    })
  })

  it('requires the same completeness from the fork profile as the official one', () => {
    expect(() => { resolveClientBuildEnvironment({ DSH_CLIENT_VERSION: VERSION }, 'portal') })
      .toThrow(/DSH_CLIENT_COMMIT_HASH/u)
    expect(() => { resolveClientBuildEnvironment({ DSH_CLIENT_COMMIT_HASH: COMMIT_HASH }, 'portal') })
      .toThrow(/DSH_CLIENT_VERSION/u)
  })

  it('names both known profiles in the unknown-profile diagnostic', () => {
    expect(() => { resolveClientBuildEnvironment({}, 'other') })
      .toThrow(/expected "official" or "portal"/u)
  })
})
