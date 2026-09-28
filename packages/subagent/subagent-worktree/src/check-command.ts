/**
 * Runs the configured check command in a review checkout. The command is not
 * git: its argv comes from `Config.testCommand` or operator (CLI) `--test`
 * input — never from model input — so, like every git command this service
 * issues, it runs with host privileges rather than a sandboxed confinement.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/check-command
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Milliseconds a check command gets to exit after termination starts; a fixed lifecycle constant. */
const CHECK_COMMAND_GRACE_MS = 2_000

/** In-memory cap per stream; only the combined tail is ever kept, so a generous but bounded ceiling is enough. */
const CHECK_COMMAND_STREAM_MAX_BYTES = 1024 * 1024

/** Settled check-command facts. */
export interface CheckCommandResult {
  /** Exit code; null when the process died from a signal, including this runner's own timeout. */
  readonly exitCode: number | null
  /** stdout followed by stderr — the two collected streams concatenated in that fixed order, not interleaved by time. */
  readonly combinedOutput: string
  /** True when `Config.checkTimeoutMs` elapsed and the command was terminated, rather than the caller's own `signal`. */
  readonly timedOut: boolean
}

/**
 * Run one non-empty check command argv to completion, terminating it if it
 * runs longer than `timeoutMs`.
 * @param subprocess - the host subprocess capability.
 * @param argv - non-empty executable and arguments; never shell-interpreted.
 * @param cwd - the review checkout to run the command in.
 * @param signal - cancellation for the whole accept operation.
 * @param timeoutMs - `Config.checkTimeoutMs`: milliseconds the command may run before it is terminated.
 * @returns the exit code, combined output, and whether the deadline (rather than `signal`) ended the command.
 */
export async function runCheckCommand(
  subprocess: SubprocessRuntime,
  argv: readonly string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CheckCommandResult> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: CHECK_COMMAND_STREAM_MAX_BYTES },
      stderr: { maxBytes: CHECK_COMMAND_STREAM_MAX_BYTES },
    },
    graceMs: CHECK_COMMAND_GRACE_MS,
    signal: AbortSignal.any([signal, timeoutSignal]),
  })
  const outcome = await handle.done
  /* v8 ignore start -- collect-mode stdio always yields both readers (seam contract). */
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  /* v8 ignore stop */
  return { exitCode: outcome.exitCode, combinedOutput: stdout + stderr, timedOut: timeoutSignal.aborted && !signal.aborted }
}
