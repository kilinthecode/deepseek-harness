/**
 * Process facts this app's command-line provider reads. Tests substitute the
 * fields to pin each invocation case; the default reads the real process.
 *
 * @module @deepseek-ai/dsh-portal-app/internals
 */

/** The process facts the command-line provider consults. */
export const internals: {
  /** Output for model discovery and structured argument errors. */
  stdout: { write(chunk: string): unknown; isTTY?: boolean; columns?: number }
  /**
   * Whether this invocation's stdin is a terminal, so no pipe can supply a task.
   * @returns true when stdin is interactive.
   */
  stdinIsTty(): boolean
} = {
  stdout: process.stdout,
  stdinIsTty: () => process.stdin.isTTY,
}
