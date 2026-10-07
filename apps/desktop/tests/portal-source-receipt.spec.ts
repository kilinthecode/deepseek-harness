import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readPortalRefreshSource } from '../scripts/portal-source-receipt.mjs'
import { repositoryClientBuildEnvironment, resolveClientBuildEnvironment } from '../../../scripts/client-build-environment.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function source() {
  const root = await mkdtemp(join(tmpdir(), 'portal-source-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', packageManager: 'pnpm@11.7.0' }))
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git(['init', '-q'])
  git(['add', '.'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root, {}), 'portal')
  return { root, environment, commit: git(['rev-parse', 'HEAD']) }
}
it('records clean source, lock, package manager, and runtime without private configuration', async () => {
  const f = await source()
  const receipt = readPortalRefreshSource(f.root, f.environment)
  expect(receipt).toEqual({ commit: f.commit, lockSha256: expect.stringMatching(/^[a-f0-9]{64}$/), packageManager: 'pnpm@11.7.0', node: process.version, profile: 'portal' })
})
it('rejects uncommitted inputs', async () => {
  const f = await source()
  await writeFile(join(f.root, 'pnpm-lock.yaml'), 'changed\n')
  expect(() => readPortalRefreshSource(f.root, f.environment)).toThrow(/requires committed sources/)
})
it('rejects a stale source commit and a different client profile', async () => {
  const f = await source()
  expect(() => readPortalRefreshSource(f.root, { ...f.environment, DSH_CLIENT_COMMIT_HASH: '00000000' })).toThrow(/differs/)
  expect(() => readPortalRefreshSource(f.root, { ...f.environment, DSH_CLIENT_BUILD_PROFILE: 'official' })).toThrow(/differs/)
})
