/**
 * Two-process publication e2e writer: opens the memory store over the given
 * storage root through the built packages under plain Node, writes `count`
 * global records named `<prefix>-<n>`, rewrites the shared record `shared`
 * after each of them, and exits. Two of these run at once against one root.
 */

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
await ctx.fiber.dispose()
process.stdout.write('done\n')
