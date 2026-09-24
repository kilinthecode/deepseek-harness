/**
 * Two-process publication e2e writer: opens the memory store over the given
 * storage root through the built packages under plain Node, prints `ready`,
 * waits for a `go` line on stdin, then writes `count` global records named
 * `<prefix>-<n>` and rewrites the shared record `shared` after each of them.
 * It finishes by printing one JSON line with the wall-clock window of its
 * writes, so the parent can observe that two writers overlapped.
 */

import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryStore from '@deepseek-ai/dsh-memory'

const [root, prefix, countArg] = process.argv.slice(2)
const count = Number(countArg)
const ctx = new Context()
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root })
await ctx.plugin(StorageDomain, { backend: 'json' })
await ctx.plugin(MemoryStore, { maxRecords: 1000, maxRecordBytes: 4096 })

const lines = createInterface({ input: process.stdin })
process.stdout.write('ready\n')
const [go] = await once(lines, 'line')
if (go !== 'go') throw new Error(`expected "go" on stdin, got ${JSON.stringify(go)}`)
lines.close()

const start = Date.now()
for (let index = 0; index < count; index += 1) {
  await ctx.memory.write({
    name: `${prefix}-${index}`,
    type: 'project',
    scope: 'global',
    description: `${prefix} ${index}`,
    content: `${prefix} record ${index}`,
  })
  await ctx.memory.write({
    name: 'shared',
    type: 'user',
    scope: 'global',
    description: 'written by both processes',
    content: `${prefix}-${index}`,
  })
}
const end = Date.now()
await ctx.fiber.dispose()
process.stdout.write(`${JSON.stringify({ done: true, start, end })}\n`)
