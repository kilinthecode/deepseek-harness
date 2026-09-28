/**
 * The fix-round prompt: sent to a fresh worker in the same worktree after a
 * rejected review or a failing check command, when `--fix-rounds` leaves
 * rounds unspent.
 * @module @deepseek-ai/dsh-agents/fixer
 */

import type { AcceptOutcome } from '@deepseek-ai/dsh-subagent-worktree'

/** The accept outcomes a fix round may retry. */
export type FixableOutcome = Extract<AcceptOutcome, { kind: 'rejected' | 'checks-failed' }>

/** Render the problems section naming what the prior attempt got wrong. */
function problemsFor(outcome: FixableOutcome): string {
  if (outcome.kind === 'rejected') {
    return outcome.verdict.findings.length === 0
      ? outcome.verdict.summary
      : outcome.verdict.findings.map(finding => `- ${finding}`).join('\n')
  }
  return `\`${outcome.argv.join(' ')}\` exited ${String(outcome.exitCode)}:\n${outcome.output}`
}

/**
 * Render the prompt for a fixer child started in the worktree a review
 * rejected or whose check command failed.
 * @param task - the original task text given to `dsh agents run`.
 * @param outcome - the `rejected` or `checks-failed` outcome to fix.
 * @returns the fixer's prompt, ending with the original task for context.
 */
export function renderFixerPrompt(task: string, outcome: FixableOutcome): string {
  return `Fix these problems in this worktree:\n${problemsFor(outcome)}\n\nOriginal task:\n${task}\n`
}
