/**
 * Report and check the identity, signature, and versions of the local Portal.app.
 *
 * The App must report `DSH_DESKTOP_BUILD_VERSION` in `CFBundleShortVersionString`, `CFBundleVersion`,
 * and its packaged manifest, while the bundled runtime descriptor and every bundled
 * `@deepseek-ai/dsh*` manifest keep the product version from `apps/desktop/package.json`. It must be
 * ad-hoc signed and declare both bundle localizations. The script prints what it read and exits non-zero
 * on the first failed check. Run it from `apps/desktop` with the build's target environment:
 * `pnpm exec tsx scripts/portal-local/inspect-portal-app.ts`.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from '../desktop-build-paths.mjs'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const asar = builderRequire('@electron/asar') as {
  listPackage: (archive: string, options: { isPack: boolean }) => string[]
  extractFile: (archive: string, filename: string) => Buffer
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`portal inspect: ${label} is not an object`)
  return value as Record<string, unknown>
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`portal inspect: ${message}`)
}

const target = resolveDesktopBuildTarget()
check(target !== 'win-x64', 'the local Portal build targets macOS only')
const app = join(resolveDesktopTargetBuildPaths().root, 'local-artifacts', target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'Portal.app')
const buildVersion = process.env.DSH_DESKTOP_BUILD_VERSION?.trim()
check(buildVersion !== undefined && buildVersion !== '', 'DSH_DESKTOP_BUILD_VERSION is required')
const productVersion = object(JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8')), 'apps/desktop/package.json').version
console.log(`App: ${app}\nbuild version ${String(buildVersion)}, product version ${String(productVersion)}`)

const plist = object(JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' })), 'Info.plist')
for (const key of ['CFBundleIdentifier', 'CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable', 'CFBundleShortVersionString',
  'CFBundleVersion', 'LSMinimumSystemVersion', 'CFBundleLocalizations', 'NSMicrophoneUsageDescription', 'CFBundleURLTypes']) {
  console.log(`Info.plist ${key}: ${JSON.stringify(plist[key])}`)
}
check(plist.CFBundleShortVersionString === buildVersion && plist.CFBundleVersion === buildVersion, 'bundle versions differ from the build version')
const localizations = plist.CFBundleLocalizations
check(Array.isArray(localizations) && localizations.includes('en') && localizations.includes('zh_CN'), 'CFBundleLocalizations lacks en or zh_CN')

const signature = spawnSync('/usr/bin/codesign', ['-dv', app], { encoding: 'utf8' })
const signatureLines = signature.stderr.split('\n').filter(line => /^(?:Identifier|Format|CodeDirectory|Signature|TeamIdentifier|Sealed Resources)/u.test(line))
console.log(`codesign -dv:\n  ${signatureLines.join('\n  ')}`)
check(signatureLines.includes('Signature=adhoc'), 'the App is not ad-hoc signed')
const verify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
check(verify.status === 0, `codesign --verify --deep --strict failed: ${verify.stderr.trim()}`)
console.log('codesign --verify --deep --strict: valid')

const archive = join(app, 'Contents', 'Resources', 'app.asar')
const json = (path: string): Record<string, unknown> => object(JSON.parse(asar.extractFile(archive, path).toString('utf8')), path)
const manifest = json('package.json')
console.log(`app.asar package.json: ${JSON.stringify({
  name: manifest.name, version: manifest.version, dshDesktopAppId: manifest.dshDesktopAppId,
  dshBuildCommit: manifest.dshBuildCommit, dshBuildDirty: manifest.dshBuildDirty,
  dshMandatoryUpdatePolicy: manifest.dshMandatoryUpdatePolicy === undefined ? 'absent' : 'present',
})}`)
check(manifest.version === buildVersion, 'the packaged manifest version differs from the build version')
const runtimeRelease = object(json('dsh/desktop-runtime.json').release, 'desktop-runtime.json release')
console.log(`dsh/desktop-runtime.json release: ${JSON.stringify(runtimeRelease)}`)
check(runtimeRelease.version === productVersion, 'the bundled runtime version differs from the product version')

const byVersion = new Map<string, Set<string>>()
for (const entry of asar.listPackage(archive, { isPack: false })) {
  if (!/\/node_modules\/@deepseek-ai\/[^/]+\/package\.json$/u.test(entry)) continue
  const bundled = json(entry.replace(/^\//u, ''))
  const version = String(bundled.version)
  byVersion.set(version, (byVersion.get(version) ?? new Set<string>()).add(String(bundled.name)))
}
for (const [version, packages] of byVersion) {
  const names = [...packages].sort()
  const dsh = names.filter(name => name.startsWith('@deepseek-ai/dsh'))
  console.log(`bundled @deepseek-ai manifests at ${version}: ${String(names.length)}${dsh.length === names.length ? '' : ` (${names.filter(name => !dsh.includes(name)).join(', ')})`}`)
  check(dsh.length === 0 || version === productVersion, `${dsh.join(', ')} declare ${version}, not product version ${String(productVersion)}`)
}
for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', '@deepseek-ai/dsh-web-frontend', '@deepseek-ai/dsh-client-portal-brand']) {
  console.log(`dsh/node_modules/${name}: ${String(json(`dsh/node_modules/${name}/package.json`).version)}`)
}

const html = asar.extractFile(archive, 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html').toString('utf8')
console.log(`frontend title: ${/<title>([^<]*)<\/title>/u.exec(html)?.[1] ?? 'missing'}`)
const portalBrand = asar.extractFile(archive, 'dsh/node_modules/@deepseek-ai/dsh-client-portal-brand/lib/client.js').toString('utf8')
console.log(`portal-brand lib/client.js mentions DSH_CLIENT_BUILD_PROFILE: ${String(portalBrand.includes('DSH_CLIENT_BUILD_PROFILE'))}`)
console.log('portal inspect: all checks passed')
