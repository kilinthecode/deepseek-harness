/** Stage a local Portal presentation refresh without installing or starting the application. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { clientBuildProcessEnvironment, readClientBuildRecord, repositoryClientBuildEnvironment, resolveClientBuildEnvironment, writeClientBuildRecord } from '../../../scripts/client-build-environment.ts'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const require = createRequire(new URL('../package.json', import.meta.url))
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const asar = builderRequire('@electron/asar')
const ts = require('typescript')
const MODULES = [
  ['ui-sidebar', ['SidebarRoot']],
  ['ui-workspace', ['Rows', 'WorkspaceBrowser']],
  ['ui-conversation', ['ConversationRoot', 'InputBar', 'HeroShell']],
]
const printer = ts.createPrinter({ removeComments: true })

/** @param value Bytes or text. @returns Lowercase SHA-256 digest. */
function digest(value) { return createHash('sha256').update(value).digest('hex') }

/** @param condition Required fact. @param message Failure description. */
function insist(condition, message) { if (!condition) throw new Error(`Portal refresh: ${message}`) }

/** @param program Local executable. @param args Argument array. @returns Captured output. */
function command(program, args) {
  return execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** @param source Compiled JavaScript. @returns Parsed declarations without executing the bundle. */
function declarations(source) {
  const file = ts.createSourceFile('client.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  insist(file.parseDiagnostics.length === 0, 'a client bundle does not parse')
  const found = []
  const visit = node => {
    if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { file, found }
}

/** @param parsed Parsed bundle. @param name Declaration name. @returns Exactly one declaration. */
function declaration(parsed, name) {
  const matches = parsed.found.filter(node => node.name?.getText(parsed.file) === name)
  insist(matches.length === 1, `expected one ${name} declaration`)
  return matches[0]
}

/** @param source Compiled bundle. @param packageName Owning plugin. @param moduleName CSS module. @returns CSS literal and exported class names. */
function styleModule(source, packageName, moduleName) {
  const parsed = declarations(source)
  const id = `@deepseek-ai/dsh-client-${packageName}/${moduleName}.module.css`
  const tags = parsed.found.filter(node => ts.isVariableDeclaration(node) && node.initializer !== undefined
    && ts.isStringLiteral(node.initializer) && node.initializer.text === id)
  insist(tags.length === 1, `expected one stylesheet ${id}`)
  const statement = tags[0].parent.parent
  const statements = statement.parent.statements
  const previous = statements[statements.indexOf(statement) - 1]
  insist(ts.isVariableStatement(previous), `stylesheet ${id} has no adjacent literal`)
  const css = previous.declarationList.declarations[0].initializer
  insist(ts.isStringLiteral(css), `stylesheet ${id} is not a string literal`)
  const object = declaration(parsed, `${moduleName}_module_css_default`).initializer
  insist(ts.isObjectLiteralExpression(object), `stylesheet ${id} has no class map`)
  const classes = Object.fromEntries(object.properties.map(property => {
    insist(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer), `invalid class map in ${id}`)
    return [ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(parsed.file), property.initializer.text]
  }))
  return { css: css.text, classes, start: css.getStart(parsed.file), end: css.end }
}

/** @param installed Installed bundle. @param current Rebuilt bundle. @param packageName Plugin. @param moduleName Stylesheet. @returns Installed JavaScript with only its CSS literal refreshed. */
function transplantStyle(installed, current, packageName, moduleName) {
  const before = styleModule(installed, packageName, moduleName)
  const after = styleModule(current, packageName, moduleName)
  insist(JSON.stringify(Object.keys(before.classes).sort()) === JSON.stringify(Object.keys(after.classes).sort()), `${moduleName} class names differ from the installed release`)
  const prefixes = new Map()
  for (const [name, value] of Object.entries(after.classes)) {
    const old = before.classes[name]
    insist(value.endsWith(`_${name}`) && old.endsWith(`_${name}`), `${moduleName} class naming is unsupported`)
    prefixes.set(value.slice(0, -name.length), old.slice(0, -name.length))
  }
  insist(prefixes.size === 1, `${moduleName} has multiple class prefixes`)
  const [currentPrefix, installedPrefix] = [...prefixes][0]
  const css = after.css.split(currentPrefix).join(installedPrefix)
  return installed.slice(0, before.start) + JSON.stringify(css) + installed.slice(before.end)
}

/** @param installed Installed brand bundle. @param current Rebuilt brand bundle. @returns Only the PortalMark function replaced. */
function transplantMark(installed, current) {
  const old = declarations(installed)
  const fresh = declarations(current)
  for (const name of ['PORTAL_MARK_VIEWBOX', 'CENTER', 'OUTER_VERTICES', 'INNER_VERTICES', 'LIFT_EDGES', 'Cell']) {
    const render = parsed => printer.printNode(ts.EmitHint.Unspecified, declaration(parsed, name), parsed.file)
    insist(render(old) === render(fresh), `${name} artwork dependency differs from the installed release`)
  }
  const from = declaration(fresh, 'PortalMark')
  const to = declaration(old, 'PortalMark')
  const body = from.getText(fresh.file)
  insist(body.includes('stroke: "currentColor"') && !body.includes('fill: "#fff"'), 'rebuild PortalMark before staging its theme-adaptive artwork')
  return installed.slice(0, to.getStart(old.file)) + body + installed.slice(to.end)
}

/** @param header Original ASAR header. @returns Preorder entries with original directory, link, and unpack metadata. */
function entries(header) {
  const result = []
  const visit = (node, parent = '') => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      insist(!['.', '..'].includes(name) && !/[\\/\0]/.test(name), 'unsafe archive entry')
      const path = parent === '' ? name : `${parent}/${name}`
      result.push({ path, node: child })
      if (child.files !== undefined) visit(child, path)
    }
  }
  visit(header)
  return result
}

/** @param application Source application. @returns Public identity and preserved root entitlements. */
function inspectApplication(application) {
  const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(application, 'Contents/Info.plist')]))
  insist(plist.CFBundleIdentifier === 'local.deepseek.harness' && plist.CFBundleName === 'Portal' && plist.CFBundleExecutable === 'Portal', 'requires the existing local.deepseek.harness Portal application')
  insist(command('/usr/bin/lipo', ['-archs', join(application, 'Contents/MacOS/Portal')]).trim() === 'arm64', 'requires an arm64 application')
  insist(!existsSync(join(application, 'Contents/Resources/app-update.yml')), 'release-feed applications cannot use this local refresh')
  const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', application], { encoding: 'utf8' })
  insist(signature.status === 0 && signature.stderr.includes('Signature=adhoc'), 'requires an ad-hoc signed application')
  const verification = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', application], { encoding: 'utf8' })
  const priorThemePatch = verification.status !== 0
  if (priorThemePatch) {
    const changes = `${verification.stdout}\n${verification.stderr}`.split('\n').filter(line => /^file (?:added|modified|missing): /u.test(line))
    const permitted = new Set([
      `file modified: ${application}/Contents/Resources/app.asar`,
      `file added: ${application}/Contents/Resources/app.asar.pre-theme-backup`,
    ])
    insist(verification.stderr.includes('a sealed resource is missing or invalid')
      && changes.length > 0 && changes.every(line => permitted.has(line)), 'source signature differs beyond the existing local theme patch')
  }
  const entitlements = command('/usr/bin/codesign', ['-d', '--entitlements', ':-', application])
  insist(entitlements.includes('<plist'), 'root entitlements could not be read')
  return { plist, entitlements, priorThemePatch }
}

/** @param archive Original archive. @param listing Original entries. @param openingArchive Optional compatible application archive supplying the opening animation. @returns A bounded map of presentation replacements. */
function replacements(archive, listing, openingArchive) {
  const changed = new Map()
  const paths = new Map(listing.map(entry => [entry.path, entry.node]))
  const extract = path => {
    const node = paths.get(path)
    insist(node && node.files === undefined && node.link === undefined && !node.unpacked && !node.executable, `${path} must be an existing packed presentation file`)
    return asar.extractFile(archive, path)
  }
  for (const [packageName, modules] of MODULES) {
    const path = `dsh/node_modules/@deepseek-ai/dsh-client-${packageName}/lib/client.js`
    const current = readFileSync(join(ROOT, `packages/client/${packageName}/lib/client.js`), 'utf8')
    let installed = extract(path).toString()
    for (const moduleName of modules) installed = transplantStyle(installed, current, packageName, moduleName)
    changed.set(path, Buffer.from(installed))
  }
  const brand = 'dsh/node_modules/@deepseek-ai/dsh-client-portal-brand/lib/client.js'
  changed.set(brand, Buffer.from(transplantMark(extract(brand).toString(), readFileSync(join(ROOT, 'packages/client/portal-brand/lib/client.js'), 'utf8'))))
  if (openingArchive !== undefined) {
    const boot = listing.filter(({ path }) => /^dsh\/node_modules\/@deepseek-ai\/dsh-web-frontend\/dist\/assets\/index-[^/]+\.css$/.test(path))
    insist(boot.length === 1, 'requires the installed opening CSS asset')
    const bootPath = boot[0].path
    const original = extract(bootPath).toString()
    const restored = asar.extractFile(openingArchive, bootPath).toString()
    const markRule = /(\._mark_[A-Za-z0-9_]+)\{([^}]*)\}/g
    const currentMarks = [...original.matchAll(markRule)]
    const previousMarks = [...restored.matchAll(markRule)]
    insist(currentMarks.length === 1 && previousMarks.length === 1
      && currentMarks[0][1] === previousMarks[0][1]
      && original.replace(currentMarks[0][0], '') === restored.replace(previousMarks[0][0], ''),
    'opening styles differ beyond the logo foreground and background')
    changed.set(bootPath, Buffer.from(restored))
  }
  for (const filename of ['favicon.svg', 'favicon-dark.svg']) {
    const path = `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/${filename}`
    extract(path)
    changed.set(path, readFileSync(join(ROOT, 'apps/web/dist', filename)))
  }
  const descriptorPath = 'dsh/desktop-runtime.json'
  const runtime = JSON.parse(extract(descriptorPath))
  insist(runtime.arch === 'arm64' && runtime.platform === 'darwin', 'runtime descriptor differs from the application')
  for (const [path, body] of changed) {
    const records = runtime.files.filter(file => file.path === path.slice(4))
    insist(records.length === 1, `${path} is absent from the runtime inventory`)
    Object.assign(records[0], { bytes: body.length, sha256: digest(body), executable: false })
  }
  changed.set(descriptorPath, Buffer.from(`${JSON.stringify(runtime, null, 2)}\n`))
  return changed
}

/** @param archive Original archive. @param listing Original entries. @param changed Presentation replacements. @param destination New ASAR. */
async function repack(archive, listing, changed, destination) {
  const streams = listing.map(({ path, node }) => {
    if (node.files !== undefined) return { path, type: 'directory', unpacked: node.unpacked }
    if (node.link !== undefined) return { path, type: 'link', unpacked: node.unpacked, symlink: posix.relative(posix.dirname(path), node.link), stat: { mode: 0o755 } }
    const body = changed.get(path)
    const unpacked = node.unpacked === true
    const physical = `${archive}.unpacked/${path}`
    const mode = unpacked ? lstatSync(physical).mode : node.executable ? 0o755 : 0o644
    return { path, type: 'file', unpacked: node.unpacked, stat: { mode, size: body?.length ?? node.size }, streamGenerator: () => body ? Readable.from([body]) : unpacked ? createReadStream(physical) : Readable.from([asar.extractFile(archive, path)]) }
  })
  await asar.createPackageFromStreams(destination, streams)
  // This ASAR version resolves before its output stream finishes closing.
  const payloadBytes = listing.reduce((sum, { path, node }) => sum + (node.files === undefined && node.link === undefined && !node.unpacked ? (changed.get(path)?.length ?? node.size) : 0), 0)
  const deadline = Date.now() + 30_000
  while (lstatSync(destination).size < 8 + asar.getRawHeader(destination).headerSize + payloadBytes) {
    insist(Date.now() < deadline, 'archive output did not finish within 30 seconds')
    await new Promise(done => setTimeout(done, 25))
  }
}

/** @param before Original ASAR. @param after Staged ASAR. @param listing Original entries. @param changed Allowed presentation changes. @returns Digest observations for the allowed changes. */
function verifyArchive(before, after, listing, changed) {
  const staged = entries(asar.getRawHeader(after).header)
  insist(JSON.stringify(staged.map(entry => entry.path)) === JSON.stringify(listing.map(entry => entry.path)), 'archive entry order or membership changed')
  const report = []
  for (const [index, { path, node }] of listing.entries()) {
    const next = staged[index].node
    for (const field of ['unpacked', 'executable', 'link']) insist(node[field] === next[field], `${path} ${field} metadata changed`)
    insist((node.files !== undefined) === (next.files !== undefined), `${path} entry type changed`)
    if (node.files !== undefined || node.link !== undefined) continue
    const original = asar.extractFile(before, path)
    const candidate = asar.extractFile(after, path)
    if (changed.has(path)) {
      insist(candidate.equals(changed.get(path)), `${path} differs from the planned presentation bytes`)
      report.push({ path, before: digest(original), after: digest(candidate), bytes: candidate.length })
    } else insist(candidate.equals(original), `${path} changed outside the presentation allowlist`)
  }
  return report
}

/** @param output Staging directory. @param supplied Explicit ICNS, when supplied. @returns Candidate icon path. */
async function applicationIcon(output, supplied) {
  if (supplied !== undefined) return realpathSync(resolve(supplied))
  const sharp = require('sharp')
  const folder = join(output, 'Portal.iconset')
  mkdirSync(folder)
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) await sharp(join(ROOT, 'apps/desktop/resources/icon-macos.png')).resize(size * scale, size * scale).png().toFile(join(folder, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`))
  }
  const icon = join(output, 'icon.icns')
  command('/usr/bin/iconutil', ['-c', 'icns', folder, '-o', icon])
  return icon
}

/** Build optional client inputs, then stage and verify an isolated candidate. */
async function main() {
  const { values } = parseArgs({ options: { application: { type: 'string' }, output: { type: 'string' }, icon: { type: 'string' }, 'opening-from': { type: 'string' }, build: { type: 'boolean', default: false } } })
  insist(process.platform === 'darwin' && values.application && values.output, 'requires macOS and explicit --application and --output paths')
  const application = realpathSync(resolve(values.application))
  const output = join(realpathSync(dirname(resolve(values.output))), basename(resolve(values.output)))
  insist(isAbsolute(values.application) && isAbsolute(values.output), 'application and output paths must be absolute')
  insist(!existsSync(output) && basename(application) === 'Portal.app', 'output must be a new directory and source must be Portal.app')
  const parent = realpathSync(dirname(output))
  const fromApplication = relative(application, parent)
  insist(parent !== '/Applications' && !parent.startsWith('/Applications/')
    && (fromApplication === '..' || fromApplication.startsWith('../') || isAbsolute(fromApplication)), 'output must be outside Applications and the source app')
  const inspected = inspectApplication(application)
  if (values.build) {
    const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(ROOT, process.env), 'portal')
    for (const script of ['build:lib:client', 'build:web']) execFileSync('pnpm', ['run', script], { cwd: ROOT, env: clientBuildProcessEnvironment(process.env, environment), stdio: 'inherit' })
    writeClientBuildRecord(ROOT, environment)
  }
  const build = readClientBuildRecord(ROOT)
  insist(build.environment.DSH_CLIENT_BUILD_PROFILE === 'portal', 'requires a recorded portal client build')
  const archive = join(application, 'Contents/Resources/app.asar')
  const originalHash = digest(readFileSync(archive))
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json'))
  insist(metadata.dshDesktopEdition === 'portal' && metadata.dshDesktopAppId === inspected.plist.CFBundleIdentifier, 'archive application identity differs')
  insist(metadata.version === inspected.plist.CFBundleShortVersionString, 'shell and runtime release versions differ')
  let openingApplication
  let openingArchive
  if (values['opening-from'] !== undefined) {
    insist(isAbsolute(values['opening-from']), 'opening source must be an absolute application path')
    openingApplication = realpathSync(values['opening-from'])
    const opening = inspectApplication(openingApplication)
    openingArchive = join(openingApplication, 'Contents/Resources/app.asar')
    const openingMetadata = JSON.parse(asar.extractFile(openingArchive, 'package.json'))
    insist(openingMetadata.version === metadata.version
      && openingMetadata.version === opening.plist.CFBundleShortVersionString
      && openingMetadata.dshDesktopEdition === metadata.dshDesktopEdition
      && openingMetadata.dshDesktopAppId === metadata.dshDesktopAppId, 'opening source is a different application release')
  }
  const listing = entries(asar.getRawHeader(archive).header)
  const changed = replacements(archive, listing, openingArchive)
  mkdirSync(output)
  const candidate = join(output, 'Portal.app')
  command('/usr/bin/ditto', [application, candidate])
  const packed = join(output, 'refreshed.asar')
  await repack(archive, listing, changed, packed)
  const report = verifyArchive(archive, packed, listing, changed)
  const stagedArchive = join(candidate, 'Contents/Resources/app.asar')
  renameSync(packed, stagedArchive)
  rmSync(`${packed}.unpacked`, { recursive: true, force: true })
  command('/usr/bin/ditto', [await applicationIcon(output, values.icon), join(candidate, 'Contents/Resources/icon.icns')])
  command('/usr/bin/ditto', [join(ROOT, 'apps/desktop/resources/icon-windows.png'), join(candidate, 'Contents/Resources/icon.png')])
  const headerHash = digest(asar.getRawHeader(stagedArchive).headerString)
  insist(inspected.plist.ElectronAsarIntegrity?.['Resources/app.asar']?.algorithm === 'SHA256', 'requires the installed Electron ASAR integrity record')
  inspected.plist.ElectronAsarIntegrity['Resources/app.asar'].hash = headerHash
  const plist = join(output, 'Info.json')
  writeFileSync(plist, JSON.stringify(inspected.plist))
  command('/usr/bin/plutil', ['-convert', 'xml1', '-o', join(candidate, 'Contents/Info.plist'), plist])
  const entitlements = join(output, 'entitlements.plist')
  writeFileSync(entitlements, inspected.entitlements)
  command('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=identifier,flags,requirements', '--entitlements', entitlements, candidate])
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate])
  insist(digest(readFileSync(archive)) === originalHash, 'source archive changed while staging')
  writeFileSync(join(output, 'report.json'), `${JSON.stringify({ schemaVersion: 1, application, candidate,
    originalArchiveSha256: originalHash, candidateArchiveSha256: digest(readFileSync(stagedArchive)),
    sourceVersion: metadata.version, appId: metadata.dshDesktopAppId, installed: false,
    preservedPriorThemePatch: inspected.priorThemePatch, openingApplication,
    build, headerSha256: headerHash, changedPaths: report.map(entry => entry.path), changed: report,
  }, null, 2)}\n`)
  console.log(`Portal candidate staged: ${candidate}\nPresentation report: ${join(output, 'report.json')}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
