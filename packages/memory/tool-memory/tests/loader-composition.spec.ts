// Boots the full stack from a cordis.yml through the real Loader: both
// packages compose from configuration, and a missing or invalid tool-memory
// field fails load instead of silently defaulting.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import MemoryStore from '@deepseek-ai/dsh-memory'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import ToolRuntime from '@deepseek-ai/dsh-tools'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the given tool-memory config block.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: cordis:agents',
    '- name: cordis:systemPrompt',
    '- name: cordis:tools',
    '- name: cordis:sessionProjections',
    '- name: cordis:storage',
    '- name: cordis:storage-json',
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storages'))}`,
    '- name: cordis:storage-domain',
    '  config:',
    '    backend: json',
    '- name: cordis:memory',
    '  config:',
    '    maxRecords: 5',
    '    maxRecordBytes: 256',
    '- name: cordis:tool-memory',
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Object.assign(ctx.loader.builtins, {
    agents: AgentRegistry,
    systemPrompt: SystemPrompt,
    tools: ToolRuntime,
    sessionProjections: SessionProjectionRegistry,
    storage: Storage,
    'storage-json': StorageJson,
    'storage-domain': StorageDomain,
    memory: MemoryStore,
    'tool-memory': ToolMemory,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('dsh-tool-memory real Loader composition through cordis.yml', () => {
  it('registers the three tools and the prompt section over the composed store', async () => {
    const ctx = await boot(['    injectMaxBytes: 2048', '    maxRecallResults: 3'])
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(['memory_write', 'memory_recall', 'memory_forget']))
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'tool:memory')
    expect(section?.text).toContain('memory_write')
    expect(ctx.memory).toBeDefined()
  }, 30_000)

  it.each([
    { label: 'injectMaxBytes is omitted', configLines: ['    maxRecallResults: 3'], failure: /injectMaxBytes/ },
    { label: 'maxRecallResults is omitted', configLines: ['    injectMaxBytes: 2048'], failure: /maxRecallResults/ },
    { label: 'maxRecallResults is zero', configLines: ['    injectMaxBytes: 2048', '    maxRecallResults: 0'], failure: /maxRecallResults/ },
    { label: 'injectMaxBytes is negative', configLines: ['    injectMaxBytes: -1', '    maxRecallResults: 3'], failure: /injectMaxBytes/ },
  ])('fails loading when $label', async ({ configLines, failure }) => {
    await expect(boot(configLines)).rejects.toThrow(failure)
  }, 30_000)
})
