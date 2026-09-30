import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../../../..')

function read(relative: string): string {
  return readFileSync(resolve(repo, relative), 'utf8')
}

describe('memory-review bundle rows', () => {
  it('enables the plugin on base immediately after tool-memory with the shipped interval and step cap', () => {
    const base = read('packages/bundle/base/cordis.patch.yml')
    const toolMemory = base.indexOf("name: '@deepseek-ai/dsh-tool-memory'")
    const review = base.indexOf("name: '@deepseek-ai/dsh-memory-review'")
    expect(toolMemory).toBeGreaterThan(-1)
    expect(review).toBeGreaterThan(toolMemory)
    expect(base.slice(review, review + 280)).toMatch(/reviewEveryUserTurns: 10/)
    expect(base.slice(review, review + 280)).toMatch(/maxReviewSteps: 8/)
    const disabled = base.indexOf('id: memory-review')
    expect(base.slice(disabled, disabled + 80)).not.toMatch(/disabled: true/)
  })

  it('enables the plugin on the Web standard, cordis, and ptc presets with both fields', () => {
    for (const relative of [
      'packages/bundle/web-app/presets/standard.patch.yml',
      'packages/bundle/web-app/presets/cordis.patch.yml',
      'packages/bundle/web-app/presets/ptc.patch.yml',
    ]) {
      const text = read(relative)
      expect(text).toMatch(
        /id: memory-review\n\s+name: '@deepseek-ai\/dsh-memory-review'\n\s+config:\n\s+reviewEveryUserTurns: 10\n\s+maxReviewSteps: 8/,
      )
    }
  })

  it('disables the plugin on headless, acp-app, sdk-app, and the web-app host plane', () => {
    for (const relative of [
      'packages/bundle/headless/cordis.patch.yml',
      'packages/bundle/acp-app/cordis.patch.yml',
      'packages/bundle/sdk-app/cordis.patch.yml',
      'packages/bundle/web-app/cordis.patch.yml',
    ]) {
      const text = read(relative)
      expect(text).toMatch(/- id: memory-review\n\s+disabled: true/)
    }
  })
})
