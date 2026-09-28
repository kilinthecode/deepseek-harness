import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitCommandError, GitRunner } from '../src/git.ts'
import { initFixtureRepo, removeFixture } from './harness.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
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

const signal = new AbortController().signal

describe('GitRunner.run', () => {
  it('runs a command and collects its stdout without throwing on success', async () => {
    const dir = await initFixtureRepo('dsh-git-runner-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    const result = await command.run(['rev-parse', '--is-bare-repository'], { cwd: dir, signal })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('false')
    expect(result.stdoutLossy).toBe(false)
  })

  it('never throws on a nonzero exit: the caller interprets it', async () => {
    const dir = await initFixtureRepo('dsh-git-runner-nonzero-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    const result = await command.run(['rev-parse', '--verify', 'refs/heads/does-not-exist'], { cwd: dir, signal })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('reports stdoutLossy, keeping only the tail, when stdout outgrows the byte cap', async () => {
    const dir = await initFixtureRepo('dsh-git-runner-lossy-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    const whole = await command.run(['rev-parse', '--show-toplevel'], { cwd: dir, signal })
    const capped = await command.run(['rev-parse', '--show-toplevel'], { cwd: dir, signal, maxBytes: 8 })
    expect(whole.stdoutLossy).toBe(false)
    expect(capped.stdoutLossy).toBe(true)
    expect(capped.stdout.length).toBeLessThan(whole.stdout.length)
    expect(whole.stdout.endsWith(capped.stdout)).toBe(true)
  })

  it('reuses one resolved executable across repeated calls', async () => {
    const dir = await initFixtureRepo('dsh-git-runner-cache-')
    cleanups.push(() => removeFixture(dir))
    const sp = await subprocess()
    const lookups = vi.spyOn(sp, 'resolveExecutable')
    const command = new GitRunner(sp)
    const first = await command.run(['rev-parse', '--is-bare-repository'], { cwd: dir, signal })
    const second = await command.run(['rev-parse', '--is-bare-repository'], { cwd: dir, signal })
    expect(first.exitCode).toBe(0)
    expect(second.exitCode).toBe(0)
    expect(lookups).toHaveBeenCalledTimes(1)
  })

  it('does not cache a rejected executable lookup: the next command resolves fresh and succeeds', async () => {
    const dir = await initFixtureRepo('dsh-git-runner-poison-')
    cleanups.push(() => removeFixture(dir))
    const sp = await subprocess()
    const lookups = vi.spyOn(sp, 'resolveExecutable').mockRejectedValueOnce(new Error('transient lookup failure'))
    const command = new GitRunner(sp)

    await expect(command.run(['rev-parse', '--is-bare-repository'], { cwd: dir, signal })).rejects.toThrow('transient lookup failure')
    const retried = await command.run(['rev-parse', '--is-bare-repository'], { cwd: dir, signal })
    const cached = await command.run(['rev-parse', '--is-bare-repository'], { cwd: dir, signal })

    expect(retried.exitCode).toBe(0)
    expect(cached.exitCode).toBe(0)
    // One failed lookup, one fulfilled lookup that every later command reuses.
    expect(lookups).toHaveBeenCalledTimes(2)
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

  it('does not look at stdoutLossy: a command whose output is not parsed may lose its tail', async () => {
    const dir = await initFixtureRepo('dsh-git-expect-lossy-ok-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    const result = await command.expect(['rev-parse', '--show-toplevel'], 'git rev-parse', { cwd: dir, signal, maxBytes: 8 })
    expect(result.stdoutLossy).toBe(true)
  })
})

describe('GitRunner.expectComplete', () => {
  it('returns the whole result when stdout fit the byte cap', async () => {
    const dir = await initFixtureRepo('dsh-git-complete-ok-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    const result = await command.expectComplete(['rev-parse', '--is-bare-repository'], 'git rev-parse', { cwd: dir, signal })
    expect(result.stdout.trim()).toBe('false')
    expect(result.stdoutLossy).toBe(false)
  })

  it('fails loud instead of returning a partial stdout the caller would parse', async () => {
    const dir = await initFixtureRepo('dsh-git-complete-lossy-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    await expect(command.expectComplete(['rev-parse', '--show-toplevel'], 'git rev-parse', { cwd: dir, signal, maxBytes: 8 }))
      .rejects.toThrow('subagent-worktree: git rev-parse output exceeded its capture limit; refusing to parse a partial result')
  })

  it('still fails with the GitCommandError of a nonzero exit', async () => {
    const dir = await initFixtureRepo('dsh-git-complete-fail-')
    cleanups.push(() => removeFixture(dir))
    const command = await runner()
    await expect(command.expectComplete(['rev-parse', '--verify', 'refs/heads/nope'], 'git rev-parse', { cwd: dir, signal }))
      .rejects.toThrow(GitCommandError)
  })
})
