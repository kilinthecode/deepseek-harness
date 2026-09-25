/**
 * Run the `scripts/smoke-packaged-runtime.ts` checks against the local Portal.app.
 *
 * `electron-builder.config.local.mjs` writes the App under the target's `local-artifacts` directory
 * rather than `artifacts`, which is the only difference from the release smoke. The target comes from
 * `DSH_DESKTOP_TARGET_PLATFORM` and `DSH_DESKTOP_TARGET_ARCH`, as in the build. Run it from `apps/desktop`:
 * `pnpm exec tsx scripts/portal-local/smoke-portal.ts`.
 */

import { join } from 'node:path'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from '../desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../../src/runtime-tree.ts'
import { smokePreparedRuntime } from '../smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from '../package-target.ts'

const target = resolveDesktopBuildTarget()
if (target === 'win-x64') throw new Error('portal smoke: the local Portal build targets macOS only')
const paths = resolveDesktopTargetBuildPaths()
const contents = join(paths.root, 'local-artifacts', target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'Portal.app', 'Contents')
const resources = join(contents, 'Resources')
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), join(contents, 'MacOS', 'Portal'), join(resources, 'runtime'), descriptor)
console.log(`portal smoke: packaged runtime smoke passed for ${join(contents, '..')}`)
