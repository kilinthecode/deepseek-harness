/**
 * Pack the dsh release family from a Portal client build.
 *
 * `release:pack --family dsh` requires the official client build record, so it refuses the output of
 * `DSH_BUILD_CLIENT_PROFILE=portal pnpm run build`. This script packs the same members in the same
 * publish order and applies the same version and payload checks, but requires the record to match the
 * Portal profile at the current commit and product version. Run it from the repository root:
 * `pnpm exec tsx apps/desktop/scripts/portal-local/pack-dsh-portal.ts <out-dir>`.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  readClientBuildRecord,
  repositoryCommitHash,
  repositoryVersion,
  resolveClientBuildEnvironment,
} from '../../../../scripts/client-build-environment.ts'
import { releaseFamily, tarballName } from '../../../../scripts/release/families.ts'
import { pnpmCommand, runConcurrent } from '../../../../scripts/release/process.ts'
import { PUBLISH_ORDER_FILE, tarballFiles } from '../../../../scripts/release/tarball.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const [output] = process.argv.slice(2)
if (output === undefined) throw new Error('usage: pack-dsh-portal.ts <out-dir>')
const destination = resolve(output)

const expected = resolveClientBuildEnvironment({
  DSH_CLIENT_COMMIT_HASH: repositoryCommitHash(REPOSITORY_ROOT),
  DSH_CLIENT_VERSION: repositoryVersion(REPOSITORY_ROOT),
}, 'portal')
const record = readClientBuildRecord(REPOSITORY_ROOT, expected)
console.log(`portal pack: client build record matches ${JSON.stringify(record.environment)}`)

const family = releaseFamily('dsh')
const members = family.publishOrder(family.members(REPOSITORY_ROOT)).order
family.verifyVersions(members)
rmSync(destination, { recursive: true, force: true })
mkdirSync(destination, { recursive: true })
const [pnpm, ...pnpmPrefix] = pnpmCommand()
const order: string[] = []
for (const member of members) {
  await runConcurrent(pnpm, [...pnpmPrefix, '--dir', member.directory, 'pack', '--pack-destination', destination], { cwd: REPOSITORY_ROOT })
  const filename = tarballName(member)
  const tarball = join(destination, filename)
  if (!existsSync(tarball)) throw new Error(`portal pack: ${member.name} produced no tarball at ${tarball}`)
  family.validatePayload(member, tarballFiles(tarball))
  order.push(filename)
}
writeFileSync(join(destination, PUBLISH_ORDER_FILE), `${order.join('\n')}\n`)
console.log(`portal pack: family dsh, ${String(order.length)} tarball(s) in ${destination}`)
