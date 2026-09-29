/**
 * Test control over the signals cleanup commands run on. `cleanupSignal` bounds each cleanup command with a fixed
 * 30-second timeout, which a test cannot wait for, so a spec mocks `../src/git.ts` with
 * {@link withExpirableCleanupSignals} and then makes a command's signal run out on demand with {@link expireSignal}.
 */

import type * as Git from '../src/git.ts'

/** Every signal `cleanupSignal` issued, with the controller that can expire it. */
const issued = new Map<AbortSignal, AbortController>()

/**
 * The git module with `cleanupSignal` replaced by a source of signals that never expire on their own.
 * @param actual - the real git module.
 * @returns the module a spec's `vi.mock('../src/git.ts', ...)` factory returns.
 */
export function withExpirableCleanupSignals(actual: typeof Git): typeof Git {
  return {
    ...actual,
    cleanupSignal: () => {
      const controller = new AbortController()
      issued.set(controller.signal, controller)
      return controller.signal
    },
  }
}

/**
 * Make a command's signal run out, the way its bound would. A signal that `cleanupSignal` did not issue (a
 * caller's own signal) is left alone.
 * @param signal - the signal the command was started on.
 */
export function expireSignal(signal: AbortSignal | undefined): void {
  if (signal !== undefined) issued.get(signal)?.abort()
}

/**
 * What a command reports when its signal ran out while it was running: the real subprocess runtime kills the command
 * and settles it with no exit code, and production code reads that as "cancelled". A command whose signal had
 * already run out before it started never runs either, but the real runtime refuses to spawn it (rejecting with
 * `aborted before spawn`) instead of settling like this; every command this package starts after a point of no
 * return runs on a fresh cleanup signal, so no caller reads a settlement there.
 * @see tests/git.spec.ts, which pins both settlements against the real runtime.
 */
export const KILLED_RESULT: Git.GitCommandResult = { exitCode: null, stdout: '', stderr: '', stdoutLossy: false }
