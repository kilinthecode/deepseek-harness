// Boots a real preset-mounted composition through the Loader: `tool-memory`
// and `memory-review` mount in the AGENT'S own scope through a real
// `@deepseek-ai/dsh-agent-preset` row (the mechanism the Web standard/cordis/ptc
// presets use — `packages/bundle/web-app/presets/standard.patch.yml`),
// not the process-global scope every `loader-composition.spec.ts` row uses.
// One scripted parent turn must start a review child: this is the
// REAL-composition regression `packages/AGENTS.md` requires for a
// product-visible plugin, alongside the mounting-mechanism unit coverage in
// `review.spec.ts`. Row resolution uses `ctx.loader.builtins` (`cordis:`
// names), matching `loader-composition.spec.ts` in this same directory: a
// bare package specifier resolves relative to the Loader package's own
// location, not `ctx.baseUrl` (`vendor/loader/src/config/tree.ts`), so a real
// name would only work by chance of hoisting.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import MemoryStore from '@deepseek-ai/dsh-memory'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as MemoryReview from '../src/index.ts'
import { REVIEW_LABEL, REVIEW_PROMPT } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const PRESET_ID = 'preset-under-test'

/**
 * Boot a real preset-mounted composition: sessions/tools/agents/storage/memory/
 * subagents/the fork provider/llm/agent-loop on the host plane, plus a real
 * `@deepseek-ai/dsh-agent-preset-registry` and one `@deepseek-ai/dsh-agent-preset`
 * row declaring `tool-memory` and `memory-review` — the same two rows
 * `standard.patch.yml` lists inside its own preset, not on the host plane.
 * @returns the booted context.
 */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-review-preset-loader-'))
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
    '    maxRecords: 20',
    '    maxRecordBytes: 4096',
    '- name: cordis:subagents',
    '- name: cordis:subagent-fork-in-process',
    '  config:',
    '    providerName: fork',
    '- name: cordis:llm',
    '- name: cordis:agent-loop',
    '  config:',
    '    agents: []',
    '- name: cordis:agent-preset-registry',
    '  config:',
    `    default: ${PRESET_ID}`,
    '- name: cordis:agent-preset',
    '  config:',
    `    id: ${PRESET_ID}`,
    '    order: 1',
    '    plugins:',
    '      - id: tool-memory',
    '        name: cordis:tool-memory',
    '        config:',
    '          injectMaxBytes: 2048',
    '          maxRecallResults: 4',
    '      - id: memory-review',
    '        name: cordis:memory-review',
    '        config:',
    '          reviewEveryUserTurns: 1',
    '          maxReviewSteps: 8',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
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
    llm: LlmRuntime,
    'agent-loop': AgentLoop,
    'agent-preset-registry': AgentPresetRegistry,
    'agent-preset': AgentPreset,
    'tool-memory': ToolMemory,
    'memory-review': MemoryReview,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('dsh-memory-review real Loader composition through a preset row', () => {
  it('starts a review child from a preset-mounted tool-memory/memory-review after one scripted parent turn', async () => {
    const ctx = await boot()
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok'), textResponse('Nothing to save.')]))

    const parentId = SessionId('preset-loader-parent')
    const childStarted = new Promise<SessionId>((resolve) => {
      const dispose = ctx.on('subagent/start', (info) => {
        if (info.provider !== 'fork') return
        dispose()
        resolve(info.id)
      })
    })

    const handle = await ctx.agents.create({
      sessionId: parentId,
      agentOptions: { provider: 'mock', model: 'mock' },
      // The same binding point `@deepseek-ai/dsh-agent-preset`'s managed
      // Agents use in production: `AgentPresetRegistry.mount()` before the
      // agent's first turn can run (`packages/preset/agent-preset-registry/src/index.ts`).
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, PRESET_ID) },
    })
    const parent = handle.agent

    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    const childId = await childStarted
    const child = ctx.agents.get(childId)
    // A child session actually started, and is still live.
    expect(child).toBeDefined()
    await child?.whenIdle()

    // The parent log carries this plugin's `subagent/catalog` row.
    const catalog = parent.session.snapshotEvents()
      .filter(event => event.type === 'subagent/catalog' && event.data.label === REVIEW_LABEL)
    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.type === 'subagent/catalog' && catalog[0].data.childId).toBe(childId)

    // The child's seed carries the review task as its first new user message.
    const live = child?.session.snapshotEvents().filter(event => event.seq >= (child.session.inheritedEventCount)) ?? []
    const firstUser = live.find(event => event.type === 'user/message')
    expect(firstUser?.type === 'user/message'
      && firstUser.data.content.some(block => block.type === 'text' && block.text === REVIEW_PROMPT)).toBe(true)
  }, 30_000)
})
