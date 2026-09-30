/** Durable per-session state for the user-controlled model-selection opt-in. */

import { z as zod } from 'zod'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  assertAllowedModelRoutes, assertValidDefaultChildRoute, defaultChildRouteAllowed,
  type AllowedModelRoute, type DefaultChildRoute,
} from './model-selection.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records that this session's delegation tool exposes child provider,
     * model, and reasoning-effort selection. Appended before the first model
     * request; absence means the fixed-route definition. Log-only: it carries
     * no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Exact routes this Session may select explicitly for a child. */
      allowedModels: AllowedModelRoute[]
      /** Default child route applied when a call omits `provider` and `model`. */
      defaultModel?: DefaultChildRoute
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Authorized routes and optional default child route, or null when disabled. */
    subagentModelSelectionPolicy: SubagentModelSelectionDecision | null
  }
}

/** Durable per-session decision: authorized routes and an optional default child route. */
export interface SubagentModelSelectionDecision {
  /** Exact routes this Session may select explicitly for a child. */
  readonly allowedModels: readonly AllowedModelRoute[]
  /**
   * Default child route applied when a call omits `provider` and `model`.
   * `| undefined` (not a plain optional) matches the zod-inferred fold output
   * under `exactOptionalPropertyTypes`.
   */
  readonly defaultModel?: DefaultChildRoute | undefined
}

const modelSelectionPolicySchema: zod.ZodType<SubagentModelSelectionDecision | null> = zod.object({
  allowedModels: zod.array(zod.object({
    provider: zod.string().min(1),
    model: zod.string().min(1),
  }).strict()).min(1),
  // Persisted JSON carries a plain string; the transform restores the brand
  // this package's live merge logic (DefaultChildRoute) requires.
  defaultModel: zod.object({
    provider: zod.string().min(1),
    model: zod.string().min(1),
    reasoningEffort: zod.string().min(1).optional(),
  }).strict().transform((route): DefaultChildRoute => ({
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
  })).optional(),
}).strict().nullable()

/**
 * Host-only projection of the durable model-selection policy. `stateVersion`
 * bumped from 1 (bare route array) to 2 (`{ allowedModels, defaultModel? }`):
 * a persisted-cache row from the prior unit is discarded and refolded rather
 * than forward-applied as the new shape.
 */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  stateVersion: 2,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== 'subagent/model-selection-policy') return policy
    const { allowedModels } = event.data
    // Read as unknown: a committed event's declared type documents a
    // well-behaved writer, not a guarantee about the durable bytes this fold
    // replays, so `defaultModel` gets the same runtime validation as `allowedModels`.
    const rawDefaultModel: unknown = event.data.defaultModel
    assertAllowedModelRoutes(allowedModels)
    if (allowedModels.length === 0) {
      throw new Error('subagent/model-selection-policy requires at least one route')
    }
    if (rawDefaultModel !== undefined) {
      assertValidDefaultChildRoute(rawDefaultModel)
      if (rawDefaultModel === null) {
        throw new Error('subagent/model-selection-policy requires a route object when defaultModel is present')
      }
      if (!defaultChildRouteAllowed(rawDefaultModel, allowedModels)) {
        throw new Error(`subagent/model-selection-policy default route "${rawDefaultModel.provider}/${rawDefaultModel.model}" is not in allowedModels`)
      }
    }
    return {
      allowedModels: allowedModels.map(route => ({ ...route })),
      ...rawDefaultModel === undefined ? {} : { defaultModel: { ...rawDefaultModel } },
    }
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', SubagentModelSelectionDecision | null>

/**
 * Read the exact decision captured for a model-selectable definition.
 * @param projections - registry that owns the policy projection.
 * @param session - session whose durable decision is read.
 * @returns a detached decision, or undefined for the fixed-route definition.
 */
export function subagentModelSelectionPolicy(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): SubagentModelSelectionDecision | undefined {
  const state = projections.stateOf(session, 'subagentModelSelectionPolicy')
  if (state === null || state === undefined) return undefined
  return {
    allowedModels: state.allowedModels.map(route => ({ ...route })),
    ...state.defaultModel === undefined ? {} : { defaultModel: { ...state.defaultModel } },
  }
}

/**
 * Append the route decision once, before its definition can reach a model request.
 * @param projections - registry that owns the policy projection.
 * @param session - session receiving the model-selectable definition.
 * @param decision - exact routes and optional default the definition may use.
 */
export function recordSubagentModelSelection(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
  decision: SubagentModelSelectionDecision,
): void {
  if (subagentModelSelectionPolicy(projections, session) !== undefined) return
  session.append('subagent/model-selection-policy', {
    allowedModels: decision.allowedModels.map(route => ({ ...route })),
    ...decision.defaultModel === undefined ? {} : { defaultModel: { ...decision.defaultModel } },
  })
}
