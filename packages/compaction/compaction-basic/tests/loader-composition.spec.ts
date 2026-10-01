import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '../../../llm/llm-deepseek/src/defaults.ts'
import { resolveCompactSpec, resolveTargetPolicy } from '../src/config.ts'

let root: string | undefined
let context: Context | undefined

async function disposeLoaded(): Promise<void> {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
}

afterEach(disposeLoaded)

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-token-meter-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-compaction-tool-result-pruner', ToolResultPruner],
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

describe('real Loader composition', () => {
  it('loads the shipped token-meter, pruning, and compaction-basic YAML order', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      '  config:',
      '    thresholdChars: 100',
      '    headChars: 20',
      '    tailChars: 10',
      "- name: '@deepseek-ai/dsh-compaction-basic'",
      '  config:',
      '    thresholdRatio: 0.5',
      '    headroomTokens: 4000',
      '    modelPolicies:',
      '      - provider: mock',
      '        model: small',
      '        headroomTokens: 0',
      '        maxTokens: 32',
      '    retainRatio: 0.125',
      '    auto: false',
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.get('toolResultPruner')).toBeInstanceOf(ToolResultPruner)
    expect(loaded.get('compaction')).toBeInstanceOf(BasicCompactionEngine)
    expect((loaded.compaction as BasicCompactionEngine).config).toMatchObject({
      thresholdRatio: 0.5,
      headroomTokens: 4000,
      modelPolicies: [{ provider: 'mock', model: 'small', headroomTokens: 0, maxTokens: 32 }],
      retainRatio: 0.125,
      auto: false,
    })
  })

  it('rejects stale token-meter config after Schemastery normalization', async () => {
    context = new Context()
    await context.plugin(SessionProjectionRegistry)
    await expect(context.plugin(TokenMeter, {
      contextWindow: 4096,
    } as never)).rejects.toThrow(/TokenMeterConfig: unknown key "contextWindow"/)
  })

  it('rejects stale compaction-basic config after Schemastery normalization', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      models: { legacy: { thresholdRatio: 0.5 } },
    } as never)).rejects.toThrow(/BasicCompactionConfig: unknown key "models"/)
  })

  it('rejects a capacity-independent merged ratio conflict during plugin load', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      retainRatio: 0.2,
      modelPolicies: [{
        provider: 'test-provider',
        model: 'test-model',
        thresholdRatio: 0.1,
      }],
    })).rejects.toThrow(/modelPolicies\[0\]: retainRatio \(0.2\).*thresholdRatio \(0.1\)/)
  })

  it('rejects an incomplete model-policy summarization pair during plugin load', async () => {
    context = new Context()
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(BasicCompactionEngine, {
      summarizationProvider: 'default-provider',
      summarizationModel: 'default-model',
      modelPolicies: [{
        provider: 'test-provider',
        model: 'test-model',
        summarizationModel: '',
      }],
    })).rejects.toThrow(/modelPolicies\[0\].*must be set together/)
  })
})

const WEB_PRESETS_DIR = resolve(import.meta.dirname, '../../../bundle/web-app/presets')
const WEB_PRESET_FILES = ['standard.patch.yml', 'ptc.patch.yml', 'cordis.patch.yml'] as const
const DEEPSEEK_PROVIDERS = ['deepseek-official', 'deepseek-account'] as const
// Pressure and retained tail the Web presets ship for each DeepSeek model, in
// tokens at the catalog's 1M window.
const DEEPSEEK_SHIPPED = [
  { model: 'deepseek-flash', thresholdTokens: 250_000, retainTokens: 64_000 },
  { model: 'deepseek-v4-pro', thresholdTokens: 190_000, retainTokens: 48_000 },
] as const

/**
 * Slice the compaction-basic row out of one shipped Web preset as a top-level list item.
 * @param file - preset patch file name.
 * @returns the row's lines dedented to column zero.
 */
function presetCompactionRow(file: string): string[] {
  const lines = readFileSync(resolve(WEB_PRESETS_DIR, file), 'utf8').split('\n')
  const starts = lines.flatMap((line, index) => (/^\s*- id: compaction-basic$/.test(line) ? [index] : []))
  expect(starts, `${file} mounts exactly one compaction-basic row`).toHaveLength(1)
  const start = starts[0]!
  const indent = lines[start]!.indexOf('-')
  const row = [lines[start]!]
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= indent) break
    row.push(line)
  }
  return row.map(line => line.slice(indent))
}

/**
 * Load one shipped preset's compaction-basic row through the real Loader.
 * @param file - preset patch file name.
 * @returns the mounted engine.
 */
async function loadPresetCompaction(file: string): Promise<BasicCompactionEngine> {
  const loaded = await loadYaml([
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    ...presetCompactionRow(file),
  ])
  const unloaded = [...loaded.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  return loaded.compaction as BasicCompactionEngine
}

describe('shipped Web preset compaction rows', () => {
  it.each(WEB_PRESET_FILES)('%s condenses every DeepSeek route at its measured optimum', async (file) => {
    const engine = await loadPresetCompaction(file)
    for (const provider of DEEPSEEK_PROVIDERS) {
      for (const { model, thresholdTokens, retainTokens } of DEEPSEEK_SHIPPED) {
        const spec = resolveCompactSpec(
          resolveTargetPolicy(engine.config, { provider, model }),
          DEFAULT_CONTEXT_WINDOW,
          DEFAULT_MAX_TOKENS,
        )
        expect(spec, `${file}: ${provider}/${model}`).toMatchObject({ thresholdTokens, retainTokens })
      }
    }
  })

  it('leaves routes without a policy on the 80% default', async () => {
    const engine = await loadPresetCompaction('standard.patch.yml')
    expect(resolveTargetPolicy(engine.config, { provider: 'xiaomi', model: 'mimo-v2.6-pro' }))
      .toMatchObject({ thresholdRatio: 0.8, retainRatio: 0.16 })
  })

  it('carries an identical policy table in every Web preset', async () => {
    const tables: unknown[] = []
    for (const file of WEB_PRESET_FILES) {
      tables.push(structuredClone((await loadPresetCompaction(file)).config.modelPolicies))
      await disposeLoaded()
    }
    expect(tables[1]).toEqual(tables[0])
    expect(tables[2]).toEqual(tables[0])
  })
})
