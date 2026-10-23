/**
 * The search order of `locateRecord`. File systems list a directory in name
 * order (APFS) or in hash order (ext4), so the order is pinned here by a
 * `readdir` that lists a directory in reverse name order.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { layoutFor, worktreeDirFor } from '../src/paths.ts'
import { createRecord, locateRecord } from '../src/records.ts'
import type { WorktreeId } from '../src/types.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readdir: async (path: string) => (await actual.readdir(path)).sort().reverse(),
  }
})

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

describe('locateRecord search order', () => {
  it('searches repository directories in name order, however the file system lists them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wt-order-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    // The listing is reversed, so it names "repo-b" before ".DS_Store"; the search must still reach the stray file first.
    await writeFile(join(root, '.DS_Store'), '')
    const layout = layoutFor(root, 'repo-b')
    const id = 'wt-11111111' as WorktreeId
    await createRecord(layout, {
      id,
      repoRoot: '/repo',
      path: worktreeDirFor(layout, id),
      branch: `dsh/worktree/${id}`,
      baseCommit: 'a'.repeat(40),
      owner: { kind: 'operator' },
      label: 'x',
      task: 'x',
      state: 'open',
      createdAt: 1,
      workerSessionIds: [],
      workerRoute: { provider: 'p', model: 'm' },
    })
    const warnings: string[] = []

    const found = await locateRecord(root, id, (message) => { warnings.push(message) })

    expect(found?.record.id).toBe(id)
    expect(warnings).toEqual([expect.stringContaining(join(root, '.DS_Store'))])
  })
})
