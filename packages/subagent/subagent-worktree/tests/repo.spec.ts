import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitRunner } from '../src/git.ts'
import { repoRootOf } from '../src/repo.ts'
import { initFixtureRepo, removeFixture } from './harness.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function git(): Promise<GitRunner> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return new GitRunner(ctx.subprocess)
}

describe('repoRootOf', () => {
  it('resolves the realpath top-level of a git work tree', async () => {
    const dir = await initFixtureRepo('dsh-repo-root-')
    cleanups.push(() => removeFixture(dir))
    const root = await repoRootOf(await git(), dir)
    expect(root).toBe(await realpath(dir))
  })

  it('resolves from a subdirectory to the same top-level', async () => {
    const dir = await initFixtureRepo('dsh-repo-root-sub-')
    cleanups.push(() => removeFixture(dir))
    const sub = join(dir, 'packages', 'foo')
    await mkdir(sub, { recursive: true })
    const root = await repoRootOf(await git(), sub)
    expect(root).toBe(await realpath(dir))
  })

  it('returns undefined outside any git work tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repo-root-none-'))
    cleanups.push(() => removeFixture(dir))
    expect(await repoRootOf(await git(), dir)).toBeUndefined()
  })
})
