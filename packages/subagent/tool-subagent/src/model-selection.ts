/** Child LLM route selection for the subagent tool. */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'

/** One exact child LLM route authorized by a user setting. */
export interface AllowedModelRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
}

/** Schema shared by the Host setting and its deployment base. */
export const AllowedModelRouteSchema: z<AllowedModelRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/**
 * Default child route a Session policy supplies when a call omits `provider`
 * and `model`. Distinct from {@link AllowedModelRoute}: it additionally
 * carries the reasoning effort applied on that route.
 */
export interface DefaultChildRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
  /** Adapter-owned reasoning effort applied on the default route. */
  readonly reasoningEffort?: ReasoningEffortId
}

/** Schema shared by the Host setting and its deployment base. */
export const DefaultChildRouteSchema: z<DefaultChildRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  reasoningEffort: z.string().min(1) as z<ReasoningEffortId>,
})

/** Route-selection authority captured by one delegation definition. */
export interface ModelSelectionPolicy {
  /** Exact provider/model routes authorized for explicit selection. */
  readonly routes: readonly AllowedModelRoute[]
  /** Default child route applied when a call omits `provider` and `model`. */
  readonly defaultRoute?: DefaultChildRoute
}

/**
 * Stable identity for one provider/model pair.
 * @param route - Exact provider/model route.
 * @returns Opaque key for equality checks.
 */
export function modelRouteKey(route: AllowedModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Reject malformed or duplicate route policy entries at a durable or configuration boundary.
 * @param routes - Candidate exact routes to validate.
 * @returns an assertion that the candidate is a validated exact-route array.
 */
export function assertAllowedModelRoutes(routes: unknown): asserts routes is readonly AllowedModelRoute[] {
  if (!Array.isArray(routes)) {
    throw new Error('subagent model selection requires an array of routes')
  }
  const seen = new Set<string>()
  const candidates: readonly unknown[] = routes
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('provider' in candidate) || typeof candidate.provider !== 'string'
      || !('model' in candidate) || typeof candidate.model !== 'string'
      || candidate.provider.length === 0 || candidate.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const route = { provider: candidate.provider, model: candidate.model }
    const key = modelRouteKey(route)
    if (seen.has(key)) {
      throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`)
    }
    seen.add(key)
  }
}

/**
 * Reject a malformed default child route at a durable or configuration boundary.
 * @param value - Candidate default route, or null for no default.
 * @returns an assertion that the candidate is a validated default route or null.
 */
export function assertValidDefaultChildRoute(value: unknown): asserts value is DefaultChildRoute | null {
  if (value === null) return
  if (typeof value !== 'object' || Array.isArray(value)
    || !('provider' in value) || typeof value.provider !== 'string'
    || !('model' in value) || typeof value.model !== 'string'
    || value.provider.length === 0 || value.model.length === 0) {
    throw new Error('subagent default child route requires non-empty provider and model ids')
  }
  if ('reasoningEffort' in value && value.reasoningEffort !== undefined
    && (typeof value.reasoningEffort !== 'string' || value.reasoningEffort.length === 0)) {
    throw new Error('subagent default child route requires a non-empty reasoning effort when set')
  }
}

/**
 * Whether a default child route's provider/model pair is one of the allowed routes.
 * @param defaultRoute - Candidate default route.
 * @param allowedModels - Exact routes authorized for explicit selection.
 * @returns Whether the default route's provider/model pair is in `allowedModels`.
 */
export function defaultChildRouteAllowed(
  defaultRoute: DefaultChildRoute,
  allowedModels: readonly AllowedModelRoute[],
): boolean {
  const key = modelRouteKey(defaultRoute)
  return allowedModels.some(route => modelRouteKey(route) === key)
}

/** Model-facing child LLM route fields. */
export interface DelegationModelRequest {
  readonly provider?: string
  readonly model?: string
  readonly reasoning_effort?: string
}

/**
 * Whether a call explicitly selects any child LLM value.
 * @param request - Model-facing route fields from the tool call.
 * @returns Whether at least one route or effort field is present.
 */
export function hasDelegationModelRequest(request: DelegationModelRequest): boolean {
  return request.provider !== undefined
    || request.model !== undefined
    || request.reasoning_effort !== undefined
}

/** Reject an empty model-facing route value at the tool JSON boundary. */
function assertNonEmpty(value: string | undefined, field: keyof DelegationModelRequest): void {
  if (value !== undefined && value.length === 0) {
    throw new Error(`child LLM \`${field}\` must be non-empty`)
  }
}

/**
 * Overlay a Session policy's default child route below the tool's configured
 * options and above the parent route. A configured route (`provider` set)
 * wins outright and the default contributes nothing. Otherwise the default
 * supplies `provider`/`model` and, unconditionally when set, its own
 * `reasoningEffort`; when the default has no effort, a configured
 * route-agnostic effort is dropped exactly when the default changes the
 * child's route relative to the parent (otherwise it is preserved), mirroring
 * how an explicit route change without a named effort clears a configured effort.
 * @param parentOptions - Current parent values that supply the route-changed comparison.
 * @param configured - Tool-instance child defaults, with any provider-owned route already merged in.
 * @param defaultRoute - Session-recorded default child route, when one exists.
 * @returns `configured` unchanged when no default applies, otherwise `configured` overlaid with the default route.
 */
function applyDefaultRoute(
  parentOptions: AgentOptions,
  configured: AgentOptions | undefined,
  defaultRoute: DefaultChildRoute | undefined,
): AgentOptions | undefined {
  if (defaultRoute === undefined || configured?.provider !== undefined) return configured
  const changesRoute = defaultRoute.provider !== parentOptions.provider || defaultRoute.model !== parentOptions.model
  const { reasoningEffort: configuredEffort, ...configuredWithoutReasoning } = configured ?? {}
  const reasoningEffort = defaultRoute.reasoningEffort ?? (changesRoute ? undefined : configuredEffort)
  return {
    ...configuredWithoutReasoning,
    provider: defaultRoute.provider,
    model: defaultRoute.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

/**
 * Merge model-supplied selection fields over configured child defaults and a
 * Session policy's default child route. Provider and model form one route
 * and must be supplied together. Changing that route without an effort clears
 * the configured route-owned effort.
 * @param parentOptions - Current parent values that supply missing child values.
 * @param configured - Tool-instance child defaults.
 * @param request - Model-facing route override.
 * @param enabled - Whether this tool instance permits model-facing selection.
 * @param defaultRoute - Session-recorded default child route applied when
 *   `configured` names no route; see {@link applyDefaultRoute}.
 * @returns Child Agent options, preserving omission when no layer contributes one.
 */
export function requestedAgentOptions(
  parentOptions: AgentOptions,
  configured: AgentOptions | undefined,
  request: DelegationModelRequest,
  enabled: boolean,
  defaultRoute?: DefaultChildRoute,
): AgentOptions | undefined {
  const defaulted = applyDefaultRoute(parentOptions, configured, defaultRoute)
  if (!hasDelegationModelRequest(request)) return defaulted
  if (!enabled) {
    throw new Error('child model selection is disabled for this tool instance')
  }
  assertNonEmpty(request.provider, 'provider')
  assertNonEmpty(request.model, 'model')
  assertNonEmpty(request.reasoning_effort, 'reasoning_effort')
  if ((request.provider === undefined) !== (request.model === undefined)) {
    throw new Error('child LLM `provider` and `model` must be supplied together')
  }

  const baselineProvider = defaulted?.provider ?? parentOptions.provider
  const baselineModel = defaulted?.model ?? parentOptions.model
  const routeChanged = request.provider !== undefined
    && (request.provider !== baselineProvider || request.model !== baselineModel)
  const { reasoningEffort: _defaultedReasoningEffort, ...defaultedWithoutReasoning } = defaulted ?? {}
  return {
    ...routeChanged && request.reasoning_effort === undefined ? defaultedWithoutReasoning : defaulted,
    ...request.provider === undefined ? {} : { provider: request.provider, model: request.model },
    ...request.reasoning_effort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(request.reasoning_effort) },
  }
}

/**
 * Enforce a settings-owned route list at the operation that creates the child.
 * Pure inheritance remains outside this policy because no model-facing choice
 * occurred; any explicit route or effort field must resolve to an allowed route.
 * @param policy - Selection authority captured for this Session.
 * @param parentOptions - Current parent values that supply missing child values.
 * @param requested - Effective child options after request/config merging.
 * @param request - Model-facing selection fields from the tool call.
 */
export function assertAllowedModelSelection(
  policy: ModelSelectionPolicy | undefined,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  request: DelegationModelRequest,
): void {
  if (policy === undefined || !hasDelegationModelRequest(request)) return
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  if (policy.routes.some(route => route.provider === provider && route.model === model)) return
  throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`)
}

/**
 * Whether configured Agent options require route validation before delegation.
 * @param options - Tool-instance child defaults.
 * @returns Whether configured provider, model, or effort values must be resolved.
 */
export function hasConfiguredLlmSelection(options: AgentOptions | undefined): boolean {
  return options?.provider !== undefined
    || options?.model !== undefined
    || options?.reasoningEffort !== undefined
}

/**
 * Resolve an effective child route through its live adapter before the child is
 * created. The LLM runtime owns provider lookup, exact-model metadata, effort
 * validation, and adapter defaults.
 * @param llm - Live LLM runtime.
 * @param parentOptions - Current parent values whose compatible fields the child inherits.
 * @param requested - Per-child options after request/config merging.
 * @param signal - Tool-call cancellation signal.
 * @param inheritParentReasoningEffort - Whether an omitted effort may inherit from the parent route.
 */
export async function preflightChildLlmRoute(
  llm: LlmRuntime,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  signal: AbortSignal,
  inheritParentReasoningEffort = true,
): Promise<void> {
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model
  const reasoningEffort = requested?.reasoningEffort
    ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : undefined)
  await llm.resolveCallConfig({
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }, signal)
}
