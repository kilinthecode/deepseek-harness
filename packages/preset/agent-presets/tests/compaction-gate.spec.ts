/**
 * The shipped presets resolve the DeepSeek pressure gate at its tuned windows:
 * `deepseek-flash` condenses at 25% of its routed context window and
 * `deepseek-v4-pro` at 19%, each keeping the newest history verbatim. The
 * capacity comes from the shipped DeepSeek catalog through the llm service, so
 * one assertion covers the preset policy, the catalog, and the resolution
 * together.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig, ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import { resolveCompactSpec, resolveTargetPolicy } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'

/** Shipped presets whose agents mount the compaction backend. */
const PRESETS = ['standard', 'cordis', 'ptc'] as const

/** DeepSeek routes and the budgets the shipped policy must resolve for them. */
const ROUTES = [
  {
    provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1_000_000, thresholdTokens: 250_000, retainTokens: 64_000,
  },
  {
    provider: 'deepseek-official', model: 'deepseek-v4-pro', contextWindow: 1_000_000, thresholdTokens: 190_000, retainTokens: 48_000,
  },
] as const

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** One composition row of a preset file. */
interface PresetRow {
  id?: unknown
  config?: unknown
}

/** The `compaction-basic` configuration one shipped preset composition declares. */
async function shippedCompactionConfig(
  preset: (typeof PRESETS)[number],
): Promise<BasicCompactionConfig> {
  const source = await readFile(join(SHIPPED_PRESET_ROOT, preset, 'agent.cordis.yml'), 'utf8')
  const rows = yaml.load(source, { schema: entryListSchema }) as PresetRow[]
  const group = rows.find(row => row.id === 'compaction')
  const inner = Array.isArray(group?.config)
    ? (group.config as PresetRow[]).find(row => row.id === 'compaction-basic')
    : undefined
  if (inner === undefined || inner.config === null || typeof inner.config !== 'object') {
    throw new Error(`${preset} preset: no compaction-basic configuration`)
  }
  return inner.config
}

/**
 * Compose the shipped DeepSeek catalog beside one preset's compaction config
 * through the Loader, the way a profile mounts both.
 */
async function compose(config: BasicCompactionConfig): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-compaction-gate-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, yaml.dump([
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-llm-deepseek' },
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-session-projection' },
    { name: '@deepseek-ai/dsh-token-meter' },
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config },
  ]))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-llm-deepseek', DeepSeek],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-compaction-basic', BasicCompactionEngine],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('the shipped compaction gate', () => {
  for (const preset of PRESETS) {
    it(`resolves the tuned DeepSeek thresholds in the ${preset} preset`, async () => {
      const ctx = await compose(await shippedCompactionConfig(preset))
      const engine = ctx.get('compaction') as BasicCompactionEngine
      const config: ResolvedConfig = engine.config

      for (const route of ROUTES) {
        const { context: capacity } = await ctx.llm.resolveModelInfo(route.provider, route.model)
        expect(capacity?.contextWindow).toBe(route.contextWindow)
        const spec = resolveCompactSpec(
          resolveTargetPolicy(config, route),
          capacity!.contextWindow,
        )
        expect(spec.thresholdTokens).toBe(route.thresholdTokens)
        expect(spec.retainTokens).toBe(route.retainTokens)
      }
    })
  }
})
