/**
 * Real two-process publication over one storage root: two child Node
 * processes running the built packages write distinct records and rewrite one
 * shared record at the same time. Afterwards every file is one complete
 * publication, nothing is quarantined, and the shared record holds the last
 * complete publication of one writer. Keyless.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryStore from '@deepseek-ai/dsh-memory'

const WRITER = fileURLToPath(new URL('./fixtures/concurrent-writer.mjs', import.meta.url))
const COUNT = 25

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function runWriter(root: string, prefix: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, root, prefix, String(COUNT)], { stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0 && stdout.includes('done')) resolve()
      else reject(new Error(`${prefix} writer exited with ${code}: ${stdout}`))
    })
  })
}

describe('two-process publication (built lib)', () => {
  it('keeps every record a complete publication while two processes write at once', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-2proc-'))
    dirs.push(root)

    await Promise.all([runWriter(root, 'alpha'), runWriter(root, 'beta')])

    const dir = join(root, 'memory', 'global')
    const names = (await readdir(dir)).sort()
    // No quarantined `.bak` and no leftover temp file: every publication completed.
    expect(names.filter(name => !name.endsWith('.json'))).toEqual([])
    expect(names).toHaveLength(COUNT * 2 + 1)
    for (const name of names) {
      const document = JSON.parse(await readFile(join(dir, name), 'utf8')) as { version: number; record: { name: string; content: string } }
      expect(document.version).toBe(1)
      expect(document.record.name).toBe(name.replace(/\.json$/, ''))
    }
    const shared = JSON.parse(await readFile(join(dir, 'shared.json'), 'utf8')) as { record: { content: string } }
    // Each writer publishes sequentially, so the surviving file is the final
    // write of whichever process renamed last, never a mix of both.
    expect(shared.record.content).toMatch(new RegExp(`^(alpha|beta)-${COUNT - 1}$`))

    // A third store over the same root reads everything back without quarantine.
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(MemoryStore, { maxRecords: 1000, maxRecordBytes: 4096 })
    const visible = await ctx.memory.visible(undefined)
    expect(visible.global).toHaveLength(COUNT * 2 + 1)
    expect((await readdir(dir)).filter(name => !name.endsWith('.json'))).toEqual([])
  })
})
