// Boots the store through the real Loader from a cordis.yml so the schemastery
// Config is exercised as configuration: a valid composition opens the domain
// under the configured storage root, and a missing or invalid cap fails load.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryStore from '@deepseek-ai/dsh-memory'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the given memory config block over a json
 * backend rooted in the scenario directory.
 * @param configLines - YAML lines nested under the store's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
  const storageRoot = join(root, 'storages')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: cordis:storage',
    '- name: cordis:storage-json',
    '  config:',
    `    root: ${JSON.stringify(storageRoot)}`,
    '- name: cordis:storage-domain',
    '  config:',
    '    backend: json',
    '- name: cordis:memory',
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Object.assign(ctx.loader.builtins, {
    storage: Storage, 'storage-json': StorageJson, 'storage-domain': StorageDomain, memory: MemoryStore,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('dsh-memory real Loader composition through cordis.yml', () => {
  it('opens the memory domain under the configured storage root and enforces the configured caps', async () => {
    const ctx = await boot(['    maxRecords: 1', '    maxRecordBytes: 16'])
    await ctx.memory.write({ name: 'only', type: 'user', scope: 'global', description: 'd', content: 'short' })
    expect(await readdir(join(root!, 'storages', 'memory', 'global'))).toEqual(['only.json'])
    await expect(ctx.memory.write({ name: 'second', type: 'user', scope: 'global', description: 'd', content: 'short' }))
      .rejects.toMatchObject({ code: 'over-cap' })
    await expect(ctx.memory.write({ name: 'only', type: 'user', scope: 'global', description: 'd', content: 'x'.repeat(17) }))
      .rejects.toMatchObject({ code: 'invalid-content' })
  }, 30_000)

  it('resolves omitted projectRootMarkers to .git through the schemastery default', async () => {
    const ctx = await boot(['    maxRecords: 2', '    maxRecordBytes: 64'])
    const projectRoot = join(root!, 'repo')
    await mkdir(join(projectRoot, '.git'), { recursive: true })
    const result = await ctx.memory.write({
      name: 'build', type: 'project', scope: 'project', description: 'How to build', content: 'pnpm', cwd: projectRoot,
    })
    expect(result.record.projectRoot).toBe(projectRoot)
  }, 30_000)

  it.each([
    { label: 'maxRecords is omitted', configLines: ['    maxRecordBytes: 16'], failure: /maxRecords/ },
    { label: 'maxRecordBytes is omitted', configLines: ['    maxRecords: 1'], failure: /maxRecordBytes/ },
    { label: 'maxRecords is zero', configLines: ['    maxRecords: 0', '    maxRecordBytes: 16'], failure: /maxRecords/ },
  ])('fails loading when $label', async ({ configLines, failure }) => {
    await expect(boot(configLines)).rejects.toThrow(failure)
  }, 30_000)
})
