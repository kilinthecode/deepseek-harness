/** Bind a local Portal refresh to committed sources, the dependency lock, and its public client build. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDesktopBuildCommit } from './desktop-build-commit.mjs'
import { assertClientBuildEnvironment, repositoryClientBuildEnvironment, resolveClientBuildEnvironment } from '../../../scripts/client-build-environment.ts'

/**
 * Require a clean source revision and a Portal build from that revision.
 * @param {string} root - Git checkout containing the source and dependency lock.
 * @param {Record<string, string>} environment - Public environment recorded by the client build.
 * @returns {{commit: string, lockSha256: string, packageManager: string, node: string, profile: string}} Rebuild inputs without private environment values.
 */
export function readPortalRefreshSource(root, environment) {
  const source = readDesktopBuildCommit(root)
  if (source.dirty) throw new Error('Portal refresh requires committed sources; commit the intended changes before staging')
  assertClientBuildEnvironment(environment, resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root, {}), 'portal'))
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return {
    commit: source.commit,
    lockSha256: createHash('sha256').update(readFileSync(join(root, 'pnpm-lock.yaml'))).digest('hex'),
    packageManager: manifest.packageManager,
    node: process.version,
    profile: 'portal',
  }
}
