/** Model reuse reads saved configuration while leaving the source profile untouched. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { modelProfilePatches } from '../src/model-profile.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(patch = ''): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), 'portal-model-profile-'))
  roots.push(home)
  const dir = join(home, 'profiles', 'desktop')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, patch || `- id: llm-pi-ai
  config:
    providers:
      example:
        apiKeyEnv: EXAMPLE_API_KEY
        models: [{id: example-model}]
- id: agent-default-model
  config: {provider: example, model: example-model}
- id: web-startup
  config: {port: 9999}
`)
  return { home, file }
}

it('reuses only the shared model rows and applies home overrides', () => {
  const { home, file } = fixture()
  const before = readFileSync(file, 'utf8')
  writeFileSync(join(home, 'cordis.patch.yml'), '- id: agent-default-model\n  config: {provider: example, model: home-model}\n')
  const patches = modelProfilePatches('desktop', home)
  expect(patches.map(patch => patch.id)).toEqual([
    'llm-pi-ai', 'agent-default-model', 'agent-default-model',
  ])
  expect(patches[2]?.config).toEqual({ provider: 'example', model: 'home-model' })
  expect(patches[0]?.config).toMatchObject({ providers: { example: { apiKeyEnv: 'EXAMPLE_API_KEY' } } })
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('refuses a missing source instead of creating it', () => {
  const { home } = fixture()
  expect(() => modelProfilePatches('missing', home)).toThrow()
})

it('refuses inserted shared model rows', () => {
  const { home } = fixture('- insert:\n    - id: llm-pi-ai\n      name: custom-provider\n')
  expect(() => modelProfilePatches('desktop', home)).toThrow('inserts a shared model row')
})

it('reads model settings without importing source application bundles', () => {
  const { home, file } = fixture()
  writeFileSync(join(file, '..', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['uninstalled-ui-bundle'] } } }))
  expect(modelProfilePatches('desktop', home)).toHaveLength(2)
})

it('refuses a shared row targeting a replacement adapter', () => {
  const { home } = fixture('- id: llm-pi-ai\n  name: custom-provider\n  config: {}\n')
  expect(() => modelProfilePatches('desktop', home)).toThrow('replaces "llm-pi-ai"')
})
