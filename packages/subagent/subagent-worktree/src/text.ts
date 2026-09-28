/**
 * Model-visible text owned by the worktree service: the brief every worker
 * receives, the reviewer prompt, and the reviewer's structured verdict schema.
 * Consumers import these so the in-app tool and the `dsh agents` runner send
 * identical text.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/text
 */

import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** Facts the worker brief names. */
export interface WorkerBriefFacts {
  /** Absolute directory the worker works in. */
  readonly workDir: string
  /** Branch checked out in the worktree. */
  readonly branch: string
  /** Full commit id the branch was created from. */
  readonly baseCommit: string
  /** Canonical top-level directory of the base repository. */
  readonly repoRoot: string
}

/**
 * Render the brief prepended to a worker's first message.
 * @param facts - worktree facts named in the brief.
 * @returns the brief text, ending with a blank line before the task.
 */
export function renderWorkerBrief(facts: WorkerBriefFacts): string {
  return `You work in your own git worktree at ${facts.workDir} on branch ${facts.branch}, created from commit `
    + `${facts.baseCommit} of the repository at ${facts.repoRoot}. Other agents cannot see or change your files, `
    + 'and your parent sees your work only after it accepts the worktree: the harness then commits your changes, '
    + 'an independent reviewer checks them, and a passing change is merged. Do not run git commands that write '
    + '(commit, add, checkout, switch, reset, stash, rebase, merge, worktree); this worktree\'s git metadata is '
    + 'outside your write scope. If the project\'s dependencies are missing, install them from the local cache '
    + 'first (for example `pnpm install --offline --frozen-lockfile --ignore-scripts`). Run the checks that cover '
    + 'your change, and end with the commands you ran, their results, and anything you did not verify.\n\n'
}

/** Facts the reviewer prompt names. */
export interface ReviewerPromptFacts {
  /** Absolute directory of the disposable review checkout. */
  readonly reviewDir: string
  /** Full commit id under review. */
  readonly commit: string
  /** Full commit id the change was branched from. */
  readonly baseCommit: string
  /** Task text the change must satisfy. */
  readonly task: string
  /** `git diff <base>..<commit>` text, already bounded by the caller. */
  readonly diff: string
  /** Whether {@link diff} was cut at the configured byte bound. */
  readonly diffTruncated: boolean
}

/**
 * Render the reviewer child's prompt.
 * @param facts - review checkout, commits, task, and bounded diff.
 * @returns the complete reviewer prompt.
 */
export function renderReviewerPrompt(facts: ReviewerPromptFacts): string {
  const truncation = facts.diffTruncated
    ? `\n[diff truncated; read the remaining changes with \`git diff ${facts.baseCommit}..${facts.commit}\`]`
    : ''
  return 'You are an independent reviewer. Another agent made the change below in a separate checkout; you did not '
    + `write it. This checkout at ${facts.reviewDir} holds exactly that change as commit ${facts.commit}, branched `
    + `from ${facts.baseCommit}.\n\n`
    + `The task the change must satisfy:\n${facts.task}\n\n`
    + 'Check it yourself and report only what you observed:\n'
    + '1. Does the change do what the task asks, and nothing beyond it?\n'
    + '2. Does it follow the conventions the repository documents (for example AGENTS.md, CLAUDE.md, contributing '
    + 'guides, and package READMEs)?\n'
    + '3. Run the checks that cover the change: tests, type checks, linters, and builds. If dependencies are '
    + 'missing, install them from the local cache first (for example `pnpm install --offline --frozen-lockfile '
    + '--ignore-scripts`). Record each command and whether it passed.\n'
    + '4. For a behavior change, confirm that a covering test fails without it: replace each changed implementation '
    + `file with its base version (\`git show ${facts.baseCommit}:<path> > <path>\`, or delete a file the change `
    + `added), rerun the test, then restore the file (\`git show ${facts.commit}:<path> > <path>\`).\n`
    + '5. Does the change claim anything it does not do, in code, comments, or docs?\n\n'
    + 'This checkout is discarded after your review, so edits here change nothing; do not try to fix the change. '
    + 'Git commands that write (commit, add, checkout, reset, stash) fail here; read with git and change files '
    + 'directly. Return the verdict "pass" only when the change is correct, verified, and honest; otherwise return '
    + '"fail" with one finding per problem, each naming the file, what is wrong, and the observation that shows it.\n\n'
    + `The change (git diff ${facts.baseCommit}..${facts.commit}):\n${facts.diff}${truncation}`
}

/**
 * Structured verdict the reviewer child must return, within the enforced
 * `assertObjectJsonSchema` subset.
 */
export const VERDICT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'checks', 'findings'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'fail'],
      description: '"pass" only when the change is correct, verified, and honest.',
    },
    summary: {
      type: 'string',
      description: 'One or two sentences on what you verified and concluded.',
    },
    checks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Each check you ran: the exact command and whether it passed.',
    },
    findings: {
      type: 'array',
      items: { type: 'string' },
      description: 'One entry per problem: the file, what is wrong, and the observation that shows it. Empty on a pass.',
    },
  },
}
