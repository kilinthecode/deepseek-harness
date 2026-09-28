/**
 * Failure tests for the shared durable-record helpers.
 *
 * Readers distinguish absence from an unreadable file, and the empty-shard
 * removal propagates everything except the two codes that already mean "the
 * desired end state".
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readRecord, removeEmptyDirectory } from '../src/record.ts'

const trees: string[] = []

afterEach(async () => {
  for (const tree of trees.splice(0)) await rm(tree, { recursive: true, force: true })
})

/** One fresh temp tree this test owns. */
async function freshTree(): Promise<string> {
  const tree = await mkdtemp(join(tmpdir(), 'peer-records-'))
  trees.push(tree)
  return tree
}

describe('durable peer records', () => {
  it('reports absence, a valid record, and a malformed one', async () => {
    const tree = await freshTree()
    const schema = z.object({ version: z.literal(1) })
    expect(await readRecord(schema, join(tree, 'absent.json'))).toEqual({ kind: 'missing' })
    const file = join(tree, 'record.json')
    await writeFile(file, '{"version":1}\n')
    expect(await readRecord(schema, file)).toEqual({ kind: 'ok', record: { version: 1 } })
    await writeFile(file, '{"version":2}\n')
    expect(await readRecord(schema, file)).toEqual({ kind: 'invalid' })
  })

  it('propagates a read failure that is not absence', async () => {
    const tree = await freshTree()
    const file = join(tree, 'record.json')
    await writeFile(file, '{"version":1}\n')
    // Only a missing file is a missing record; every other filesystem failure
    // has to reach the caller instead of reading as an absent record.
    await expect(readRecord(z.object({ version: z.literal(1) }), join(file, 'nested.json'))).rejects.toThrow()
  })

  it('removes an empty directory, tolerates the two end states, and propagates the rest', async () => {
    const tree = await freshTree()
    await removeEmptyDirectory(join(tree, 'absent'))
    const empty = join(tree, 'empty')
    await mkdir(empty)
    await removeEmptyDirectory(empty)
    await expect(stat(empty)).rejects.toMatchObject({ code: 'ENOENT' })
    const full = join(tree, 'full')
    await mkdir(full)
    await writeFile(join(full, 'entry'), 'kept')
    await removeEmptyDirectory(full)
    expect((await stat(full)).isDirectory()).toBe(true)
    const file = join(tree, 'record.json')
    await writeFile(file, '{}\n')
    await expect(removeEmptyDirectory(file)).rejects.toThrow()
  })
})
