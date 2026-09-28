/**
 * Argv git invocations through `ctx.subprocess`: explicit executable
 * resolution, a scrubbed non-interactive environment, and bounded collected
 * output. Every command here runs in the host realm (never a sandboxed
 * confinement) with argv built only from durable records, `Config`, or
 * operator (CLI) input — never from model input.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/git
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Milliseconds a git child gets to exit after termination starts; a fixed lifecycle constant, not a deployment tunable. */
const GIT_TERMINATE_GRACE_MS = 2_000

/**
 * Default in-memory stdout cap for an ordinary git command (status, rev-parse,
 * commit, merge, worktree, branch, add, `diff --name-only`). Every one of
 * these produces output far smaller than this ceiling under real use; it
 * exists only to bound a pathological repository, not to shape normal output.
 */
const DEFAULT_GIT_STDOUT_MAX_BYTES = 1024 * 1024

/** In-memory stderr cap for every git command; diagnostics are inherently short. */
const GIT_STDERR_MAX_BYTES = 64 * 1024

/** Settled git command facts; a nonzero exit is a result, not an exception — callers interpret it. */
export interface GitCommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Per-command spawn facts. */
export interface GitRunOptions {
  /** Working directory for the command. */
  readonly cwd: string
  /** Cancellation forwarded to the spawned process; omitted for callers with no signal to offer (for example `list`). */
  readonly signal?: AbortSignal | undefined
  /** In-memory stdout cap for this command, replacing {@link DEFAULT_GIT_STDOUT_MAX_BYTES}. */
  readonly maxBytes?: number | undefined
}

/** A failed git command, carrying the settled result for callers that want more than the message. */
export class GitCommandError extends Error {
  constructor(what: string, public readonly result: GitCommandResult) {
    super(`${what} failed: ${result.stderr.trim() || `exit code ${String(result.exitCode)}`}`)
    this.name = 'GitCommandError'
  }
}

/**
 * Runs one resolved git executable with a scrubbed, non-interactive
 * environment and bounded collected output. The executable is resolved once
 * and cached for the life of this runner.
 */
export class GitRunner {
  private executable: Promise<string> | undefined

  constructor(private readonly subprocess: SubprocessRuntime) {}

  /** Resolve and cache the `git` executable for this runner's lifetime. */
  private resolveExecutable(signal: AbortSignal | undefined): Promise<string> {
    this.executable ??= this.subprocess.resolveExecutable('git', undefined, signal)
    return this.executable
  }

  /**
   * Run `git <args>` to completion. Never throws on a nonzero exit: several
   * callers (`merge`, `diff --cached --quiet`) interpret specific nonzero
   * codes as meaningful outcomes rather than failures.
   * @param args - git arguments; never shell-interpreted.
   * @param options - working directory, output cap, and cancellation.
   * @returns exit facts and collected output.
   */
  async run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    const executable = await this.resolveExecutable(options.signal)
    const handle = this.subprocess.spawn({
      argv: [executable, ...args],
      cwd: options.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: options.maxBytes ?? DEFAULT_GIT_STDOUT_MAX_BYTES },
        stderr: { maxBytes: GIT_STDERR_MAX_BYTES },
      },
      graceMs: GIT_TERMINATE_GRACE_MS,
      signal: options.signal,
      // GIT_CONFIG_COUNT=0 defeats ambient GIT_CONFIG_KEY_n/VALUE_n overrides (the
      // subprocess credential scrub removes them from `env`, not from indexed
      // config keys); GIT_TERMINAL_PROMPT=0 refuses an interactive credential
      // prompt instead of hanging; GIT_OPTIONAL_LOCKS=0 skips opportunistic
      // background index updates that could contend with a concurrent worktree
      // operation; LC_ALL=C keeps porcelain output stable for parsing.
      env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    })
    const outcome = await handle.done
    /* v8 ignore start -- collect-mode stdio always yields both readers (seam contract). */
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    /* v8 ignore stop */
    return { exitCode: outcome.exitCode, stdout, stderr }
  }

  /**
   * Run `git <args>` and throw with its stderr when it exits nonzero.
   * @param args - git arguments; never shell-interpreted.
   * @param what - short command description for the thrown message.
   * @param options - working directory, output cap, and cancellation.
   * @returns the successful result.
   * @throws {GitCommandError} when the command exits nonzero.
   */
  async expect(args: readonly string[], what: string, options: GitRunOptions): Promise<GitCommandResult> {
    const result = await this.run(args, options)
    if (result.exitCode !== 0) throw new GitCommandError(what, result)
    return result
  }
}
