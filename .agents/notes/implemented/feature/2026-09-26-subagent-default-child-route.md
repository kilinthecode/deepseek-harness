# Agent Note: Subagent default child route

Status: implemented

English | [中文](2026-09-26-subagent-default-child-route.zh.md)

## Problem

The Web `subagent` tool's model-selection settings ([user-authorized subagent model routes](2026-08-24-user-authorized-subagent-model-routes.md)) let a user authorize an exact route allowlist, but every call that names no route still inherits the parent Agent's own route. A deployment that wants children to run on a cheaper or subscription route by default — while still letting the main agent choose a different authorized route per task — had no way to express that default without mounting `tool-subagent` inside a profile patch, which the Web preset rows do not expose to Settings.

## Decision

`SubagentModelSelectionConfig` gains an optional `defaultModel: { provider, model, reasoningEffort? }`, validated against `allowedModels` at every durable boundary: the fold always validates its shape and list membership; `current()` applies the same list check only while enabled and omits the field entirely while disabled, so a stale or now-unlisted default left over from turning the feature off never fails Session composition. The durable `subagent/model-selection-policy` event and its stateVersion-2 projection carry the default alongside the route list, so a fresh top-level Session samples it once and every child inherits the exact recorded decision, never re-sampling settings.

Route precedence, highest to lowest: an explicit model-facing request; the tool's own configured `agentOptions` route; the recorded default; a provider's own `agentRouteDefaults`; the parent Agent's route. `index.ts` computes this "effective default" once per tool instance — the recorded default only when the tool's configured `agentOptions` names no route — and reuses that single value for the model-visible text, the `list_subagent_models` mark, `requiresRoutePreflight`, and the merge passed to `requestedAgentOptions`, so wording and behavior cannot diverge. A provider's own `agentRouteDefaults` keeps its original standalone behavior exactly, merged into the tool's configured options in `index.ts`, but only when no effective default exists; `requestedAgentOptions` (`model-selection.ts`) then applies the effective default only when the tool's configured options name no route, supplying provider/model and, whenever the default itself names a reasoning effort, that effort unconditionally. Only when the default has no effort does a configured route-agnostic effort survive, and only when the default does not change the route relative to the parent — the same "route changed without an effort clears it" rule the explicit model-request layer already follows. `requiresRoutePreflight` triggers on the effective default alone, so a call with no request and no configured route still resolves and validates the effective route through the live LLM adapter before the child starts.

The tool description's selection sentence and the `provider`/`model`/`reasoning_effort` parameter descriptions name the effective default as a statement of effect ("Omit `provider` and `model` to run the child on `<provider>/<model>`[ at reasoning effort `<effort>`]") in place of the generic "use configured child defaults" wording, and `list_subagent_models` marks the default route with `(default)`. Absent an effective default, every one of these strings stays byte-identical to a composition with none recorded. The `reasoning_effort` description for a default with its own effort names that effort for the default route and states the two reachable outcomes for any other route (a compatible configured/parent effort, or that model's own default). An effort-less default reuses the no-default parent-inherit sentence verbatim: `resolveChildAgentOptions`' parent-effort inheritance, preflight's provider-`agentRouteDefaults` handling, and a configured route-agnostic effort surviving an unchanged route govern both cases identically, so the text does not distinguish them.

The Plugins settings card adds a default-route choice among the currently checked allowed routes, or "same as the calling agent" for none, plus an effort choice sourced from the same live model catalogue the route checkboxes already read; unchecking the default's own route clears it. All three fields save as one revision-fenced mutation.

## Alternatives considered

**Let the default's effort apply only when the route is unchanged.** Rejected: a Host administrator who records a default names it because they want that exact behavior, not a hidden dependency on whichever route the parent happens to run; treating the default's effort as always intended keeps one predictable rule instead of two paths that differ only when a configured route-agnostic effort happens to also be present.

**Let a provider's own `agentRouteDefaults` outrank the recorded default.** Rejected: a Host-level default exists precisely to steer delegation away from whatever a provider or parent would otherwise pick, including a provider's own static wiring (e.g., the DSH SDK backend's configured instance route); ranking the default below `agentRouteDefaults` would silently defeat the feature for exactly the providers most likely to declare them. `index.ts` therefore computes the effective default before deciding whether to merge `agentRouteDefaults` into the tool's configured options at all.

**Skip preflight when only a default supplies the route.** Rejected: the point of a Host-recorded default is to reach a route the user never typed, so skipping validation would let a stale or mistyped default reach `runtimeCtx.subagents.start()` unchecked — exactly the gap `preflightChildLlmRoute` exists to close for every other route source.

## Consequences

- A deployment can steer default delegation cost or capability without either the main agent naming a route on every call or the profile-patch escape hatch the Web presets do not reach.
- Model-visible text changes only when a default is actually recorded; every existing composition without one is unaffected byte-for-byte, pinned in `model-selection.spec.ts`.
- `stateVersion` bumped from 1 to 2 on the `subagentModelSelectionPolicy` projection: a persisted-cache row from the prior unit is discarded and refolded rather than forward-applied as the new `{ allowedModels, defaultModel? }` shape; a v1-written event (no `defaultModel` key) still folds to a policy without a default.
- Unit coverage pins the full precedence matrix (model request, configured route, configured effort-only, default with and without effort, parent), a default outranking a provider's own `agentRouteDefaults`, a configured tool route outranking a recorded default, preflight triggering for a default-only call, verbatim model-visible text with and without a default, settings/event validation (malformed, out-of-list, enabled-gated membership), inheritance at depth two, and the client controller/fields default-route and effort staging.

## Related decisions

Route allowlisting, Session sampling and inheritance, and the fixed `list_subagent_models` schema remain owned by [user-authorized subagent model routes](2026-08-24-user-authorized-subagent-model-routes.md); route arguments, adapter preflight, and the fork cache restriction remain owned by [model-selected subagent routes](2026-08-18-model-selected-subagent-routes.md).
