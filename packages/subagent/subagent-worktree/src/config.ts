/**
 * Resolves and validates the flat `Config` fields that stand in for two
 * optional struct-shaped values — the reviewer route and the commit author —
 * once at load, so every later read uses a pre-validated value instead of
 * re-deriving it from raw config fields. `Config` itself is declared in
 * `./index.ts` (the generated config catalog only resolves a service's schema
 * from its own module or another workspace package, not a sibling file in the
 * same package).
 *
 * @module @deepseek-ai/dsh-subagent-worktree/config
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Config } from './index.ts'
import type { WorktreeRoute } from './types.ts'

/** A resolved, validated commit author identity. */
export interface CommitAuthor {
  readonly name: string
  readonly email: string
}

/**
 * Resolve and validate the configured reviewer route: an explicit resolve
 * step run once at load, so every later `resolveReviewer` call reads a
 * pre-validated value instead of re-deriving it from raw config fields.
 * @param config - the plugin's validated configuration.
 * @returns the configured reviewer route, or `undefined` when none is configured.
 * @throws when `reviewerProvider`/`reviewerModel` are half-set, or `reviewerReasoningEffort`
 *   is set without both.
 */
export function resolveConfiguredReviewer(config: Config): WorktreeRoute | undefined {
  const { reviewerProvider, reviewerModel, reviewerReasoningEffort } = config
  if ((reviewerProvider === undefined) !== (reviewerModel === undefined)) {
    throw new Error('subagent-worktree: configured reviewerProvider and reviewerModel must be set together')
  }
  if (reviewerProvider === undefined || reviewerModel === undefined) {
    if (reviewerReasoningEffort !== undefined) {
      throw new Error('subagent-worktree: configured reviewerReasoningEffort requires reviewerProvider and reviewerModel')
    }
    return undefined
  }
  return {
    provider: reviewerProvider,
    model: reviewerModel,
    ...reviewerReasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reviewerReasoningEffort) },
  }
}

/**
 * Resolve and validate the configured commit author identity.
 * @param config - the plugin's validated configuration.
 * @returns the configured commit author, or `undefined` when none is configured (git's own identity applies).
 * @throws when `commitAuthorName`/`commitAuthorEmail` are half-set.
 */
export function resolveConfiguredCommitAuthor(config: Config): CommitAuthor | undefined {
  const { commitAuthorName, commitAuthorEmail } = config
  if ((commitAuthorName === undefined) !== (commitAuthorEmail === undefined)) {
    throw new Error('subagent-worktree: configured commitAuthorName and commitAuthorEmail must be set together')
  }
  if (commitAuthorName === undefined || commitAuthorEmail === undefined) return undefined
  return { name: commitAuthorName, email: commitAuthorEmail }
}
