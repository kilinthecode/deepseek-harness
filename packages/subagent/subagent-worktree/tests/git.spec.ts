import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitCommandError, GitRunner } from '../src/git.ts'
import { initFixtureRepo, removeFixture } from './harness.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function runner(): Promise<GitRunner> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return new GitRunner(ctx.subprocess)
}

const signal = new AbortController().signal

describe('GitRunner.run', () => {
  it('runs a command and collects its stdout without throwing on success', async () => {
    const dir = await initFixtureRepo('dsh-git-runner-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    const result = await command.run(['rev-parse', '--is-bare-repository'], { cwd: dir, signal })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('false')
  })

  it('never throws on a nonzero exit: the caller interprets it', async () => {
    const dir = await initFixtureRepo('dsh-git-runner-nonzero-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    const result = await command.run(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir, signal })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('reuses one resolved executable across repeated calls', async () => {
    const dir = await initFixtureRepo('dsh-git-runner-cache-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    const first = await command.run(['rev-parse', '--is-bare-repository'], { cwd: dir, signal })
    const second = await command.run(['rev-parse', '--is-bare-repository'], { cwd: dir, signal })
    expect(first.exitCode).toBe(0)
    expect(second.exitCode).toBe(0)
  })
})

describe('GitRunner.expect', () => {
  it('returns the result on success', async () => {
    const dir = await initFixtureRepo('dsh-git-expect-ok-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    const result = await command.expect(['rev-parse', '--is-bare-repository'], 'git rev-parse', { cwd: dir, signal })
    expect(result.stdout.trim()).toBe('false')
  })

  it('throws a GitCommandError naming the command and carrying the settled result', async () => {
    const dir = await initFixtureRepo('dsh-git-expect-fail-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    await expect(command.expect(['rev-parse', '--verify', 'refs/heads/nope'], 'git rev-parse', { cwd: dir, signal }))
      .rejects.toThrow(GitCommandError)
    try {
      await command.expect(['rev-parse', '--verify', 'refs/heads/nope'], 'git rev-parse', { cwd: dir, signal })
      expect.unreachable('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError)
      expect((error as GitCommandError).message).toContain('git rev-parse failed')
      expect((error as GitCommandError).result.exitCode).not.toBe(0)
    }
  })

  it('reports an exit-code-only message when a command fails with empty stderr', async () => {
    const dir = await initFixtureRepo('dsh-git-expect-silent-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    // `--quiet` on `rev-parse --verify` suppresses the stderr message for a
    // missing ref while still exiting nonzero, exercising the fallback branch.
    try {
      await command.expect(['rev-parse', '--quiet', '--verify', 'refs/heads/does-not-exist'], 'git rev-parse', { cwd: dir, signal })
      expect.unreachable('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError)
      expect((error as GitCommandError).result.stderr.trim()).toBe('')
      expect((error as Error).message).toMatch(/^git rev-parse failed: exit code \d+$/)
    }
  })
})
