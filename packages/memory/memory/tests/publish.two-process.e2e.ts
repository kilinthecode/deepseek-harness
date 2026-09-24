/**
 * Real two-process publication over one storage root: two child Node
 * processes running the built packages open the store, wait at a barrier,
 * then write distinct records and rewrite one shared record at the same
 * time. The test asserts that their write windows overlapped, that every
 * file is one complete publication with nothing quarantined, and that the
 * shared record holds the last complete publication of one writer. Keyless.
 */

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryStore from '@deepseek-ai/dsh-memory'

const WRITER = fileURLToPath(new URL('./fixtures/concurrent-writer.mjs', import.meta.url))
const COUNT = 25

type WriterProcess = ChildProcessByStdio<Writable, Readable, null>

/** Wall-clock window of one writer's write loop, in epoch milliseconds. */
interface WriteWindow {
  readonly start: number
  readonly end: number
}

interface Writer {
  readonly child: WriterProcess
  /** Resolves once the writer has opened the store and waits for `go`. */
  readonly ready: Promise<void>
  /** Resolves with the write window after a clean exit. */
  readonly finished: Promise<WriteWindow>
}

const dirs: string[] = []
const contexts: Context[] = []
const children = new Set<WriterProcess>()

afterEach(async () => {
  // A writer that hangs or outlives a failed assertion is killed here, so no
  // child survives the case.
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }))
  children.clear()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function startWriter(root: string, prefix: string): Writer {
  const child = spawn(process.execPath, [WRITER, root, prefix, String(COUNT)], { stdio: ['pipe', 'pipe', 'inherit'] })
  children.add(child)
  const lines: string[] = []
  const ready = new Promise<void>((resolve, reject) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      lines.push(line)
      if (line === 'ready') resolve()
    })
    child.once('close', (code) => { reject(new Error(`${prefix} writer exited with ${code} before ready`)) })
  })
  const finished = new Promise<WriteWindow>((resolve, reject) => {
    child.once('error', reject)
    // `close` fires after stdout ends, so every line has been read.
    child.once('close', (code) => {
      const last = lines.at(-1)
      if (code === 0 && last !== undefined && last.startsWith('{')) resolve(JSON.parse(last) as WriteWindow)
      else reject(new Error(`${prefix} writer exited with ${code}: ${lines.join('\n')}`))
    })
  })
  // The case awaits `finished` only after the barrier; this handler keeps an
  // earlier failure from surfacing as an unhandled rejection.
  finished.catch(() => {})
  return { child, ready, finished }
}

describe('two-process publication (built lib)', () => {
  it('keeps every record a complete publication while two processes write at once', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-2proc-'))
    dirs.push(root)

    const alpha = startWriter(root, 'alpha')
    const beta = startWriter(root, 'beta')
    await Promise.all([alpha.ready, beta.ready])
    alpha.child.stdin.end('go\n')
    beta.child.stdin.end('go\n')
    const [alphaWindow, betaWindow] = await Promise.all([alpha.finished, beta.finished])
    // The write loops overlapped in time, so the publications below raced.
    expect(Math.max(alphaWindow.start, betaWindow.start)).toBeLessThan(Math.min(alphaWindow.end, betaWindow.end))

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
