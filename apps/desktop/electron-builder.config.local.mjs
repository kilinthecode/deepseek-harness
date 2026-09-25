/**
 * Local ad-hoc Portal build for a macOS host without Apple release credentials.
 *
 * The release factory supplies the packaged files, ASAR unpack rules, resources, fuses, and Office
 * unpack hook. This configuration replaces only its release obligations: electron-builder signs the
 * App ad-hoc, nothing is notarized, no update feed is embedded, the mandatory-update policy is omitted
 * unless a policy origin is set, the target is an unpacked directory, and output goes to
 * `.desktop-build/targets/<target>/local-artifacts`. The application ID is `local.deepseek.harness`
 * unless `DSH_DESKTOP_APP_ID` is set.
 *
 * `DSH_DESKTOP_BUILD_VERSION` is required and must extend the manifests' product version as the
 * README release versions table gives it. The factory applies it as `package-target.ts --build-version`
 * does: the packaged manifest, the App's `CFBundleShortVersionString` and `CFBundleVersion`, and
 * `app.getVersion()` report the build version, while the bundled runtime, Desktop Host, and client keep
 * the product version.
 *
 * The prepared inputs under `.desktop-build/targets/<target>/` must come from the same commit with
 * `DSH_ADHOC_SIGN=1` and the same `DSH_DESKTOP_APP_ID`, so native runtime files carry ad-hoc
 * signatures that `signIgnore` keeps. `scripts/portal-local/run.sh` runs the whole sequence; this file
 * is its electron-builder step, invoked from `apps/desktop`:
 * `pnpm exec electron-builder --config electron-builder.config.local.mjs --mac --<arch> --dir --publish never`.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronBuilderConfig } from './scripts/electron-builder-config.mjs'
import { desktopBuildCommitEnvironment, readDesktopBuildCommit } from './scripts/desktop-build-commit.mjs'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './scripts/desktop-build-paths.mjs'
import { DESKTOP_BUILD_VERSION_ENV, validateDesktopBuildVersion } from './scripts/desktop-build-version.mjs'
import { resolveDesktopPolicyEnvironment } from './scripts/desktop-policy-environment.mjs'

const APP_ROOT = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')

if (process.platform !== 'darwin') throw new Error('local desktop build: requires a macOS build host')
const target = resolveDesktopBuildTarget({
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: process.env.DSH_DESKTOP_TARGET_ARCH ?? process.arch,
})
const arch = target === 'mac-arm64' ? 'arm64' : 'x64'
const buildPaths = desktopTargetBuildPaths(target)
const appId = process.env.DSH_DESKTOP_APP_ID ?? 'local.deepseek.harness'
const productVersion = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')).version
const policy = process.env.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN === undefined
  && process.env.DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN === undefined
  ? undefined
  : resolveDesktopPolicyEnvironment(process.env)

// The factory validates notarization, update, and policy settings while it builds the configuration.
// These values satisfy that validation only: every field and hook that reads them is replaced below,
// and they never reach electron-builder's process environment.
const RELEASE_VALIDATION_PLACEHOLDERS = {
  APPLE_KEYCHAIN_PROFILE: 'local-adhoc-build-without-notarization',
  DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
  DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://mandatory-update.invalid',
}
const requestedBuildVersion = process.env[DESKTOP_BUILD_VERSION_ENV]?.trim()
if (requestedBuildVersion === undefined || requestedBuildVersion === '') {
  throw new Error(`local desktop build: ${DESKTOP_BUILD_VERSION_ENV} is required; set it to the confirmed version`)
}
if (!requestedBuildVersion.startsWith(productVersion)) {
  throw new Error(`local desktop build: ${DESKTOP_BUILD_VERSION_ENV}=${requestedBuildVersion} must start with product version ${productVersion}`)
}
const buildVersion = validateDesktopBuildVersion(requestedBuildVersion, productVersion)
const release = createElectronBuilderConfig({
  ...RELEASE_VALIDATION_PLACEHOLDERS,
  DSH_ADHOC_SIGN: '1',
  DSH_DESKTOP_APP_ID: appId,
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: arch,
  [DESKTOP_BUILD_VERSION_ENV]: buildVersion,
  ...desktopBuildCommitEnvironment(readDesktopBuildCommit(REPOSITORY_ROOT)),
}, 'darwin', arch)
const metadata = Object.fromEntries(Object.entries(release.extraMetadata)
  .filter(([name]) => name !== 'dshMandatoryUpdatePolicy'))

export default {
  ...release,
  extraMetadata: { ...metadata, ...policy === undefined ? {} : { dshMandatoryUpdatePolicy: policy } },
  directories: { output: join(buildPaths.root, 'local-artifacts') },
  beforePack: async (context) => {
    await release.beforePack(context)
    if (policy === undefined) return
    const { resolveDesktopPolicyConfig } = await import('./lib/types/mandatory-update-policy.js')
    resolveDesktopPolicyConfig(policy)
  },
  // The release hook also writes the update feed; the runtime verification is the part a local App keeps.
  afterPack: async () => {
    const { verifyDesktopRuntime } = await import('./lib/types/runtime-tree.js')
    await verifyDesktopRuntime(buildPaths.dsh, productVersion, { platform: 'darwin', arch })
  },
  afterSign: async (context) => {
    const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    const verify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { encoding: 'utf8' })
    if (verify.status !== 0) throw new Error(`local desktop build: codesign verification failed: ${verify.stderr.trim()}`)
    const details = spawnSync('/usr/bin/codesign', ['-dv', appPath], { encoding: 'utf8' })
    if (!/^Signature=adhoc$/mu.test(details.stderr)) {
      throw new Error(`local desktop build: ${appPath} is not ad-hoc signed`)
    }
  },
  artifactBuildCompleted: undefined,
  mac: {
    ...release.mac,
    // The factory's mac object declares `extendInfo` twice, so its CFBundleLocalizations entry is lost;
    // this object carries both keys.
    extendInfo: {
      CFBundleLocalizations: ['en', 'zh_CN'],
      NSMicrophoneUsageDescription: 'Portal uses your microphone to transcribe speech into message drafts.',
    },
    identity: '-',
    forceCodeSigning: true,
    // Hardened runtime would require disabling library validation for ad-hoc signatures.
    hardenedRuntime: false,
    notarize: false,
    target: ['dir'],
  },
  publish: null,
}
