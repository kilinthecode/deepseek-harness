/**
 * The fix-round prompt: sent to a fresh worker in the same worktree after a
 * rejected review or a failing check command, when `--fix-rounds` leaves
 * rounds unspent.
 * @module @deepseek-ai/dsh-agents/fixer
 */

import type { AcceptOutcome } from '@deepseek-ai/dsh-subagent-worktree'

/** The accept outcomes a fix round may retry. */
export type FixableOutcome = Extract<AcceptOutcome, { kind: 'rejected' | 'checks-failed' }>

/**
 * Render the problems section naming what the prior attempt got wrong: the
 * reviewer's summary together with its findings for a rejection, or the
 * failing check's command and output for a `checks-failed` outcome.
 */
function problemsFor(outcome: FixableOutcome): string {
  if (outcome.kind === 'rejected') {
    const findings = outcome.verdict.findings.map(finding => `- ${finding}`).join('\n')
    return findings === '' ? outcome.verdict.summary : `${outcome.verdict.summary}\n${findings}`
  }
  return `\`${outcome.argv.join(' ')}\` exited ${String(outcome.exitCode)}:\n${outcome.output}`
}

/**
 * Render the fix-round instruction for a fixer child started in the worktree
 * a review rejected or whose check command failed. The caller prepends the
 * same `renderWorkerBrief(...)` text given to the first worker: without it a
 * fixer does not know its worktree, branch, base commit, or that git write
 * commands fail there.
 * @param task - the original task text given to `dsh agents run`.
 * @param outcome - the `rejected` or `checks-failed` outcome to fix.
 * @returns the fix-round instruction, ending with the original task for context.
 */
export function renderFixerPrompt(task: string, outcome: FixableOutcome): string {
  return `Fix these problems in this worktree:\n${problemsFor(outcome)}\n\nOriginal task:\n${task}\n`
}
