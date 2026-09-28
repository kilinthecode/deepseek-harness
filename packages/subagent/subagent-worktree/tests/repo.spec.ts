import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitRunner } from '../src/git.ts'
import type { GitCommandResult } from '../src/git.ts'
import { repoIdentityOf } from '../src/repo.ts'
import { git as sh, initFixtureRepo, removeFixture } from './harness.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function subprocess() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx.subprocess
}

async function runner(): Promise<GitRunner> {
  return new GitRunner(await subprocess())
}

/** A runner whose every command succeeds with the given stdout and a lossy capture flag. */
class CannedGit extends GitRunner {
  constructor(subprocessRuntime: Awaited<ReturnType<typeof subprocess>>, private readonly canned: GitCommandResult) {
    super(subprocessRuntime)
  }

  override run(): Promise<GitCommandResult> {
    return Promise.resolve(this.canned)
  }
}

describe('repoIdentityOf', () => {
  it('resolves the realpath top-level and the git common directory of a work tree', async () => {
    const dir = await initFixtureRepo('dsh-repo-id-')
    cleanups.push(() => removeFixture(dir))
    const identity = await repoIdentityOf(await runner(), dir)
    expect(identity).toEqual({ repoRoot: await realpath(dir), commonDir: await realpath(join(dir, '.git')) })
  })

  it('resolves from a subdirectory to the same identity', async () => {
    const dir = await initFixtureRepo('dsh-repo-id-sub-')
    cleanups.push(() => removeFixture(dir))
    const sub = join(dir, 'packages', 'foo')
    await mkdir(sub, { recursive: true })
    const identity = await repoIdentityOf(await runner(), sub)
    expect(identity).toEqual({ repoRoot: await realpath(dir), commonDir: await realpath(join(dir, '.git')) })
  })

  it('gives a linked worktree its own top-level but the common directory of the repository it links to', async () => {
    const dir = await initFixtureRepo('dsh-repo-id-linked-')
    cleanups.push(() => removeFixture(dir))
    sh(dir, 'commit', '--allow-empty', '-q', '-m', 'base')
    const linked = join(await mkdtemp(join(tmpdir(), 'dsh-repo-id-linked-wt-')), 'wt')
    cleanups.push(() => removeFixture(dirname(linked)))
    sh(dir, 'worktree', 'add', '-q', '-b', 'other', linked)

    const git = await runner()
    const main = await repoIdentityOf(git, dir)
    const other = await repoIdentityOf(git, linked)
    expect(other?.repoRoot).toBe(await realpath(linked))
    expect(main?.repoRoot).toBe(await realpath(dir))
    expect(other?.commonDir).toBe(main?.commonDir)
  })

  it('returns undefined outside any git work tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repo-id-none-'))
    cleanups.push(() => removeFixture(dir))
    expect(await repoIdentityOf(await runner(), dir)).toBeUndefined()
  })

  it('returns undefined when git prints fewer than the two requested paths', async () => {
    const git = new CannedGit(await subprocess(), { exitCode: 0, stdout: '/only-one-line\n', stderr: '', stdoutLossy: false })
    expect(await repoIdentityOf(git, process.cwd())).toBeUndefined()
  })

  it('returns undefined when git prints an empty top-level', async () => {
    const git = new CannedGit(await subprocess(), { exitCode: 0, stdout: '\n/x/.git\n', stderr: '', stdoutLossy: false })
    expect(await repoIdentityOf(git, process.cwd())).toBeUndefined()
  })

  it('refuses to parse output the capture limit cut short', async () => {
    const git = new CannedGit(await subprocess(), { exitCode: 0, stdout: '/partial\n/partial/.git\n', stderr: '', stdoutLossy: true })
    await expect(repoIdentityOf(git, process.cwd())).rejects.toThrow('output exceeded its capture limit; refusing to parse a partial result')
  })
})
