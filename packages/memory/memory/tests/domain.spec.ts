import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MEMORY_DESCRIPTION_MAX_CHARS,
  findProjectRoot,
  memoryDomainSpec,
  memoryRecord,
  projectMemoryKey,
  projectSlug,
} from '@deepseek-ai/dsh-memory'
import type { MemoryName } from '@deepseek-ai/dsh-memory'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-domain-'))
  roots.push(root)
  return root
}

const valid = {
  name: 'prefers-pnpm',
  type: 'user',
  scope: 'global',
  description: 'Uses pnpm, never npm',
  content: 'Run pnpm for every install and script.',
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
}

describe('memory record schema', () => {
  it('accepts a global record and a project record with its root', () => {
    expect(memoryRecord.safeParse(valid).success).toBe(true)
    expect(memoryRecord.safeParse({ ...valid, scope: 'project', projectRoot: '/repo' }).success).toBe(true)
  })

  it('ties projectRoot to the project scope in both directions', () => {
    expect(memoryRecord.safeParse({ ...valid, scope: 'project' }).success).toBe(false)
    expect(memoryRecord.safeParse({ ...valid, projectRoot: '/repo' }).success).toBe(false)
  })

  it('rejects names outside lowercase kebab-case, unknown types, and oversize descriptions', () => {
    expect(memoryRecord.safeParse({ ...valid, name: 'Prefers Pnpm' }).success).toBe(false)
    expect(memoryRecord.safeParse({ ...valid, name: 'a'.repeat(65) }).success).toBe(false)
    expect(memoryRecord.safeParse({ ...valid, type: 'note' }).success).toBe(false)
    expect(memoryRecord.safeParse({ ...valid, description: 'x'.repeat(MEMORY_DESCRIPTION_MAX_CHARS + 1) }).success).toBe(false)
    expect(memoryRecord.safeParse({ ...valid, content: '' }).success).toBe(false)
  })

  it('declares a per-record domain with backup-and-skip over two tables', () => {
    expect(memoryDomainSpec).toMatchObject({
      name: 'memory',
      version: 1,
      layout: 'per-record',
      invalidRecords: 'backup-and-skip',
    })
    expect(Object.keys(memoryDomainSpec.tables)).toEqual(['global', 'project'])
  })
})

describe('project identity', () => {
  it('slugs the sanitized basename plus eight hex characters of the root hash', () => {
    expect(projectSlug('/Users/me/dev/deepseek-harness')).toMatch(/^deepseek-harness-[0-9a-f]{8}$/)
    expect(projectSlug('/tmp/My Project!!')).toMatch(/^my-project-[0-9a-f]{8}$/)
    expect(projectSlug('/x/' + 'a'.repeat(60))).toMatch(new RegExp(`^${'a'.repeat(40)}-[0-9a-f]{8}$`))
    expect(projectSlug('/')).toMatch(/^root-[0-9a-f]{8}$/)
    expect(projectSlug('/a/b')).not.toBe(projectSlug('/a/c'))
  })

  it('builds path-safe project keys from the slug and the name', () => {
    const key = projectMemoryKey('/tmp/repo', 'build-cmd' as MemoryName)
    expect(key).toMatch(/^repo-[0-9a-f]{8}__build-cmd$/)
    expect(key).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('walks upward from the cwd to the first directory holding a marker', async () => {
    const root = await freshRoot()
    const project = join(root, 'repo')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, 'src', 'deep'), { recursive: true })
    expect(await findProjectRoot(join(project, 'src', 'deep'), ['.git'])).toBe(project)
    expect(await findProjectRoot(project, ['.git'])).toBe(project)
  })

  it('accepts a marker that is a file and treats a non-directory ancestor as marker-free', async () => {
    const root = await freshRoot()
    const worktree = join(root, 'wt')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), 'gitdir: elsewhere\n')
    expect(await findProjectRoot(worktree, ['.git'])).toBe(worktree)
    // A path whose ancestor is a regular file yields ENOTDIR on every probe.
    const file = join(root, 'plain.txt')
    await writeFile(file, 'x')
    const marker = '.dsh-memory-test-marker-that-never-exists'
    expect(await findProjectRoot(join(file, 'below'), [marker])).toBeUndefined()
  })

  it('returns undefined when no ancestor carries a marker', async () => {
    const root = await freshRoot()
    expect(await findProjectRoot(root, ['.dsh-memory-test-marker-that-never-exists'])).toBeUndefined()
  })
})
