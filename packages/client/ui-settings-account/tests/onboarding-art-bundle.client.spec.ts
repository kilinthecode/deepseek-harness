import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const libDir = join(packageRoot, 'lib')
const assetsDir = join(packageRoot, 'src/client/assets')
const entryPath = join(libDir, 'client.js')

/** Every package-local chunk emitted beside the startup entry. */
function chunkNames(): string[] {
  return readdirSync(libDir).filter(name => /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u.test(name)).sort()
}

describe('onboarding artwork client artifacts', () => {
  it.skipIf(!existsSync(entryPath))('keeps every illustration PNG in the lazily requested chunk', () => {
    const entry = readFileSync(entryPath, 'utf8')
    const chunks = chunkNames()
    const artwork = readdirSync(assetsDir).filter(name => name.endsWith('.png')).sort()
    expect(artwork).toHaveLength(8)
    expect(chunks.length).toBeGreaterThan(0)
    for (const name of artwork) {
      const encoded = readFileSync(join(assetsDir, name)).toString('base64')
      expect(entry, `${name} must not be inlined in the always-loaded bundle`).not.toContain(encoded)
      expect(chunks.some(chunk => readFileSync(join(libDir, chunk), 'utf8').includes(encoded)),
        `${name} must ship inside a package-local chunk`).toBe(true)
    }
    // The chunk is reached only through the loader's asynchronous operation.
    const requested = [...entry.matchAll(/require\.async\("(\.\/client\.[^"/]+\.js)"\)/gu)].map(match => match[1]!)
    expect(requested).not.toHaveLength(0)
    for (const specifier of requested) expect(existsSync(join(libDir, specifier.slice(2)))).toBe(true)
    // A chunk factory resolves require() against the module table, never against a sibling chunk.
    expect(entry).not.toMatch(/\brequire\("\.\/client\.[^"/]+\.js"\)/u)
    for (const chunk of chunks) {
      expect(readFileSync(join(libDir, chunk), 'utf8'), `${chunk} must not require a sibling chunk`)
        .not.toMatch(/\brequire\("\.\/client\.[^"/]+\.js"\)/u)
    }
  })
})
