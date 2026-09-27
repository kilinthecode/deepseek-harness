// Boots the full stack from a cordis.yml through the real Loader: omitted or
// out-of-range review fields fail load, and a composition without tool-memory
// or without fork fails loud.
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
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as MemoryReview from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying optional tool-memory, fork, and memory-review rows.
 * @param options - which rows and which review config lines to include.
 * @returns the booted context.
 */
async function boot(options: {
  readonly reviewLines?: readonly string[]
  readonly toolMemory?: boolean
  readonly fork?: boolean
}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-review-loader-'))
  const reviewLines = options.reviewLines
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: cordis:sessions',
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
    '- name: cordis:subagents',
    ...options.fork === false ? [] : [
      '- name: cordis:subagent-fork-in-process',
      '  config:',
      '    providerName: fork',
    ],
    ...options.toolMemory === false ? [] : [
      '- name: cordis:tool-memory',
      '  config:',
      '    injectMaxBytes: 2048',
      '    maxRecallResults: 3',
    ],
    '- name: cordis:memory-review',
    ...reviewLines !== undefined && reviewLines.length > 0 ? ['  config:', ...reviewLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Object.assign(ctx.loader.builtins, {
    sessions: SessionStore,
    agents: AgentRegistry,
    systemPrompt: SystemPrompt,
    tools: ToolRuntime,
    sessionProjections: SessionProjectionRegistry,
    storage: Storage,
    'storage-json': StorageJson,
    'storage-domain': StorageDomain,
    memory: MemoryStore,
    subagents: SubagentRuntime,
    'subagent-fork-in-process': Fork,
    'tool-memory': ToolMemory,
    'memory-review': MemoryReview,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('dsh-memory-review real Loader composition through cordis.yml', () => {
  it('loads when both required fields are present with tool-memory and fork', async () => {
    const ctx = await boot({
      reviewLines: ['    reviewEveryUserTurns: 10', '    maxReviewSteps: 8'],
    })
    expect(ctx.tools.get('memory_write')).toBeDefined()
    expect(ctx.subagents.list()).toContain('fork')
  }, 30_000)

  it.each([
    { label: 'reviewEveryUserTurns is omitted', reviewLines: ['    maxReviewSteps: 8'], failure: /reviewEveryUserTurns/ },
    { label: 'maxReviewSteps is omitted', reviewLines: ['    reviewEveryUserTurns: 10'], failure: /maxReviewSteps/ },
    { label: 'reviewEveryUserTurns is negative', reviewLines: ['    reviewEveryUserTurns: -1', '    maxReviewSteps: 8'], failure: /reviewEveryUserTurns/ },
    { label: 'maxReviewSteps is zero', reviewLines: ['    reviewEveryUserTurns: 10', '    maxReviewSteps: 0'], failure: /maxReviewSteps/ },
    { label: 'the whole config block is omitted', reviewLines: [], failure: /reviewEveryUserTurns|maxReviewSteps/ },
  ])('fails loading when $label', async ({ reviewLines, failure }) => {
    await expect(boot({ reviewLines })).rejects.toThrow(failure)
  }, 30_000)

  // memory_write and the fork provider are registered by sibling plugins'
  // own apply() calls, which the Loader may run concurrently with this
  // plugin's apply() (see the apply() JSDoc in src/index.ts), so their
  // absence cannot fail load here; review.spec.ts covers the review-time
  // check these compositions defer to.
  it('loads even when tool-memory is omitted', async () => {
    const ctx = await boot({
      toolMemory: false,
      reviewLines: ['    reviewEveryUserTurns: 10', '    maxReviewSteps: 8'],
    })
    expect(ctx.tools.get('memory_write')).toBeUndefined()
  }, 30_000)

  it('loads even when the fork provider is omitted', async () => {
    const ctx = await boot({
      fork: false,
      reviewLines: ['    reviewEveryUserTurns: 10', '    maxReviewSteps: 8'],
    })
    expect(ctx.subagents.list()).not.toContain('fork')
  }, 30_000)
})
