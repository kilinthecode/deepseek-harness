/** Host-owned opt-in setting for model-selectable subagent delegation. */
import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  AllowedModelRouteSchema,
  DefaultChildRouteSchema,
  assertAllowedModelRoutes,
  assertValidDefaultChildRoute,
  defaultChildRouteAllowed,
  type AllowedModelRoute,
  type DefaultChildRoute,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled when a new Session receives delegation tools. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** Stored user preference; the shipped composition defaults it off. */
export interface SubagentModelSelectionSettings {
  /** Whether newly composed top-level Sessions receive model selection. */
  enabled: boolean
  /** Exact child LLM routes offered to newly composed top-level Sessions. */
  allowedModels: AllowedModelRoute[]
  /** Default child route applied when a call omits `provider` and `model`. */
  defaultModel?: DefaultChildRoute
}

/** Optional deployment base for the preference. */
export interface Config {
  /** Initial enabled state inherited when the user document does not override it. */
  enabled: Volatile<boolean>
  /** Initial route list inherited when the user document does not override it. */
  allowedModels: Volatile<AllowedModelRoute[]>
  /** Initial default child route inherited when the user document does not override it. */
  defaultModel: Volatile<DefaultChildRoute | null>
}

/** Singleton settings owner read when delegation tools are composed for a Session. */
export class SubagentModelSelectionConfig extends Service {
  static Config = z.object({
    enabled: z.boolean().default(false).volatile(),
    allowedModels: z.array(AllowedModelRouteSchema).default([]).volatile(),
    defaultModel: z.union([DefaultChildRouteSchema, z.const(null)]).default(null).volatile(),
  })

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagentModelSelection')
  }

  /**
   * Read a detached selection preference for the next eligible Session composition.
   * @returns the enabled state, exact allowed routes, and, while enabled, a
   *   default child route when one is set.
   * @throws when the allowed routes are malformed or duplicated, or the
   *   default route is malformed; while enabled, also throws when the
   *   default's provider/model pair is not one of the allowed routes.
   */
  current(): SubagentModelSelectionSettings {
    const enabled = this.config.enabled.get()
    const allowedModels = this.config.allowedModels.get()
    assertAllowedModelRoutes(allowedModels)
    if (enabled && allowedModels.length === 0) {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    }
    // A nullable `.default(null)` is not itself a distinct fallback to schemastery's
    // resolver (both are "nullable"), so an omitted volatile value resolves to
    // `undefined` rather than the declared `null`; normalize both to `null` here.
    const defaultModel = this.config.defaultModel.get() ?? null
    assertValidDefaultChildRoute(defaultModel)
    // A stale or now-unlisted default only matters while the feature is
    // enabled: selectForSession never reads allowedModels or defaultModel
    // from a disabled current(), so enforcing list membership regardless
    // of enabled would fail every new Session for a user who turned the
    // feature off without first clearing an old default.
    if (enabled && defaultModel !== null && !defaultChildRouteAllowed(defaultModel, allowedModels)) {
      throw new Error(`subagent model selection default route "${defaultModel.provider}/${defaultModel.model}" is not in allowedModels`)
    }
    return {
      enabled,
      allowedModels: allowedModels.map(route => ({ ...route })),
      ...enabled && defaultModel !== null ? { defaultModel: { ...defaultModel } } : {},
    }
  }

}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
