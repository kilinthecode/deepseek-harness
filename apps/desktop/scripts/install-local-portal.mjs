/** Install or restore a staged local Portal interface while retaining the previous application. */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { stage: { type: 'string' }, rollback: { type: 'boolean', default: false } } })
if (process.platform !== 'darwin') throw new Error('local Portal installation requires macOS')
if (!values.stage) throw new Error('pass --stage with the completed staging directory')
const stage = realpathSync(resolve(values.stage))
const report = JSON.parse(readFileSync(join(stage, 'report.json'), 'utf8'))
if (report.schemaVersion !== 1 || typeof report.application !== 'string' || !isAbsolute(report.application)
  || typeof report.candidate !== 'string' || report.candidate !== join(stage, 'Portal.app')
  || !/^[a-f0-9]{64}$/u.test(report.originalArchiveSha256 ?? '')
  || !/^[a-f0-9]{64}$/u.test(report.candidateArchiveSha256 ?? '')) {
  throw new Error('invalid local Portal staging report')
}
const application = realpathSync(report.application)
if (application !== report.application || !application.endsWith('/Portal.app')) throw new Error('application path changed since staging')
const previous = join(stage, 'previous', 'Portal.app')
const candidate = values.rollback ? previous : report.candidate
const expectedInstalled = values.rollback ? report.candidateArchiveSha256 : report.originalArchiveSha256
const expectedCandidate = values.rollback ? report.originalArchiveSha256 : report.candidateArchiveSha256

/**
 * Compute the complete archive digest used to reject concurrent application updates.
 * @param {string} app - Absolute application directory.
 * @returns {string} SHA-256 of its ASAR bytes.
 */
function archiveHash(app) {
  return createHash('sha256').update(readFileSync(join(app, 'Contents', 'Resources', 'app.asar'))).digest('hex')
}

/**
 * Refuse replacement while any process executes from the target application.
 * @returns {void}
 */
function requireClosed() {
  const commands = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n')
  if (commands.some(command => command.trim().startsWith(`${application}/Contents/`))) {
    throw new Error('Portal is running; quit through its application menu before installing')
  }
}

/**
 * Verify the staged application's preserved local identity and complete signature.
 * @param {string} app - Application to inspect.
 * @param {boolean} priorThemePatch - Permit only the recorded original ASAR and theme-backup seal differences.
 * @returns {void}
 */
function verifyApplication(app, priorThemePatch = false) {
  const id = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
  if (id !== 'local.deepseek.harness') throw new Error('candidate is not the local Portal application')
  const result = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', app], { encoding: 'utf8' })
  if (result.status === 0) return
  const changes = `${result.stdout}\n${result.stderr}`.split('\n').filter(line => /^file (?:added|modified|missing): /u.test(line))
  const permitted = new Set([
    `file modified: ${app}/Contents/Resources/app.asar`,
    `file added: ${app}/Contents/Resources/app.asar.pre-theme-backup`,
  ])
  if (!priorThemePatch || !result.stderr.includes('a sealed resource is missing or invalid')
    || changes.length === 0 || changes.some(line => !permitted.has(line))) {
    throw new Error('application signature verification failed')
  }
}

/**
 * Restore valid signing metadata for the retained application with its earlier local theme patch.
 * @param {string} app - Previous application whose archive digest has already been checked.
 * @returns {void}
 */
function resealPreviousThemePatch(app) {
  const require = createRequire(new URL('../package.json', import.meta.url))
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
  const archive = join(app, 'Contents', 'Resources', 'app.asar')
  const plistPath = join(app, 'Contents', 'Info.plist')
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }))
  if (plist.CFBundleIdentifier !== 'local.deepseek.harness'
    || plist.ElectronAsarIntegrity?.['Resources/app.asar']?.algorithm !== 'SHA256') {
    throw new Error('previous application identity or archive integrity metadata differs')
  }
  plist.ElectronAsarIntegrity['Resources/app.asar'].hash = createHash('sha256')
    .update(builderRequire('@electron/asar').getRawHeader(archive).headerString).digest('hex')
  const restoredPlist = join(stage, 'rollback-info.json')
  writeFileSync(restoredPlist, JSON.stringify(plist))
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', plistPath, restoredPlist], { stdio: 'pipe' })
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-',
    '--preserve-metadata=identifier,entitlements,flags,requirements', app], { stdio: 'pipe' })
}

requireClosed()
if (archiveHash(application) !== expectedInstalled) throw new Error('installed Portal changed since staging; stage the update again')
if (archiveHash(candidate) !== expectedCandidate) throw new Error('candidate archive differs from the staging report')
const restoringThemePatch = values.rollback && report.preservedPriorThemePatch === true
verifyApplication(candidate, restoringThemePatch)
if (!values.rollback && existsSync(previous)) throw new Error('this stage already contains a previous application; use a new staging directory')
if (statSync(dirname(application)).dev !== statSync(stage).dev) throw new Error('stage and application must be on the same filesystem for atomic replacement')

const temporary = join(dirname(application), `.Portal-refresh-${process.pid}`)
const displaced = values.rollback ? join(stage, 'replaced', 'Portal.app') : previous
if (existsSync(displaced)) throw new Error('replacement backup already exists')
mkdirSync(dirname(displaced), { recursive: true })
mkdirSync(temporary)
const incoming = join(temporary, 'Portal.app')
try {
  execFileSync('/bin/cp', ['-cR', candidate, incoming], { stdio: 'pipe' })
  if (restoringThemePatch) resealPreviousThemePatch(incoming)
  verifyApplication(incoming)
  requireClosed()
  if (archiveHash(application) !== expectedInstalled) throw new Error('installed Portal changed during preparation')
  renameSync(application, displaced)
  try { renameSync(incoming, application) }
  catch (error) {
    renameSync(displaced, application)
    throw error
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
writeFileSync(join(stage, values.rollback ? 'rollback.json' : 'installation.json'), `${JSON.stringify({
  application, backup: displaced, archiveSha256: expectedCandidate, completedAt: new Date().toISOString(),
}, null, 2)}\n`)
console.log(`${values.rollback ? 'Restored' : 'Installed'} local Portal: ${application}`)
console.log(`Previous application retained: ${displaced}`)
