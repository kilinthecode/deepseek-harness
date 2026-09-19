/** Local ad-hoc build configuration: unsigned, unnotarized, dir target only. */

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopTargetBuildPaths } from './scripts/desktop-build-paths.mjs'
import { resolveDesktopPolicyEnvironment } from './scripts/desktop-policy-environment.mjs'

const APP_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)))
const buildPaths = desktopTargetBuildPaths('mac-arm64')
const appId = process.env.DSH_DESKTOP_APP_ID ?? 'local.deepseek.harness'
// Without an explicit policy origin this local build omits the mandatory-update
// policy entirely, so no test-login modal can ever block the packaged app.
const policy = process.env.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN === undefined && process.env.DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN === undefined
  ? undefined
  : resolveDesktopPolicyEnvironment(process.env)

export default {
  appId,
  extraMetadata: {
    dshDesktopAppId: appId,
    ...(policy === undefined ? {} : { dshMandatoryUpdatePolicy: policy }),
  },
  productName: 'Portal',
  directories: { output: join(buildPaths.root, 'local-artifacts') },
  asar: true,
  electronDist: buildPaths.electron,
  electronFuses: { runAsNode: true },
  npmRebuild: false,
  files: [
    'lib/main.js',
    'lib/preload-app.cjs',
    'lib/preload-mandatory.cjs',
    'lib/preload-update-dialog.cjs',
    'renderer/**/*',
    'package.json',
    { from: buildPaths.dsh, to: 'dsh', filter: ['**/*'] },
    { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },
  ],
  asarUnpack: [
    '**/*.{node,dylib,dll,so,exe}',
    '**/*.so.*',
    '**/spawn-helper',
    '**/@vscode/ripgrep/bin/rg',
  ],
  extraResources: [
    { from: buildPaths.runtime, to: 'runtime' },
    { from: join(APP_ROOT, 'resources/icon-windows.png'), to: 'icon.png' },
  ],
  mac: {
    icon: join(APP_ROOT, 'resources/icon-macos.png'),
    category: 'public.app-category.developer-tools',
    identity: null,
    forceCodeSigning: false,
    hardenedRuntime: false,
    notarize: false,
    target: ['dir'],
  },
  publish: null,
}
