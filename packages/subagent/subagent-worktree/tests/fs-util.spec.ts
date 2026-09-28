import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pathExists } from '../src/fs-util.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

describe('pathExists', () => {
  it('returns true for an existing path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-path-exists-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    expect(await pathExists(dir)).toBe(true)
  })

  it('returns false for a missing path (ENOENT)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-path-exists-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    expect(await pathExists(join(dir, 'never-created'))).toBe(false)
  })

  it('rethrows a non-ENOENT stat failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-path-exists-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'not-a-directory')
    await writeFile(file, '')
    // Treating a regular file as a path segment fails with ENOTDIR, not ENOENT.
    await expect(pathExists(join(file, 'child'))).rejects.toThrow()
  })
})
