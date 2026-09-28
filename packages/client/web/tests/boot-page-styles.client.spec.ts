/** Boot-page stylesheet rules whose effect jsdom does not compute. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sheet = readFileSync(fileURLToPath(new URL('../src/boot-page.module.css', import.meta.url)), 'utf8')
const normalized = sheet.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\s+/g, ' ')

describe('boot-page.module.css', () => {
  it('centres the status block without its reveal keyframe', () => {
    // The keyframe repeats the same transform with `both` fill, so a page whose
    // animations are suppressed keeps only the base rule to centre the block.
    expect(normalized).toMatch(/\.status \{[^}]*left: 50%;[^}]*transform: translateX\(-50%\);/)
  })

  it('consumes the per-stage tier the page sets, opaque when unset', () => {
    expect(normalized).toContain('.stage { position: absolute; inset: 0; opacity: var(--dsh-stage-opacity, 1); }')
  })
})
