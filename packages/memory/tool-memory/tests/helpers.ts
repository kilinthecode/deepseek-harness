// Shared mounting for the tool-memory suites: a real storage stack over a
// scenario-local root with the memory store on top.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryStore from '@deepseek-ai/dsh-memory'
import type { Config as StoreConfig } from '@deepseek-ai/dsh-memory'

const roots: string[] = []

/**
 * Create a scenario-local storage root; {@link cleanupRoots} removes it.
 * @returns the absolute root.
 */
export async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-memory-'))
  roots.push(root)
  return root
}

/** Remove every root created by {@link freshRoot}. */
export async function cleanupRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}

/**
 * Mount the storage hub, the json backend, the domain form, and the memory store.
 * @param ctx - context that owns the mounted services.
 * @param root - json backend root.
 * @param config - store configuration overrides.
 */
export async function mountStore(ctx: Context, root: string, config: Partial<StoreConfig> = {}): Promise<void> {
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryStore, { maxRecords: 20, maxRecordBytes: 4096, ...config })
}

/**
 * Create `<root>/<name>/.git` plus a nested working directory inside it.
 * @param root - parent directory.
 * @param name - project directory name.
 * @returns the project root and a working directory below it.
 */
export async function project(root: string, name: string): Promise<{ root: string; cwd: string }> {
  const projectRoot = join(root, name)
  await mkdir(join(projectRoot, '.git'), { recursive: true })
  const cwd = join(projectRoot, 'src')
  await mkdir(cwd, { recursive: true })
  return { root: projectRoot, cwd }
}
