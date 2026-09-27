# Agent Note: Subagent default child route

Status: implemented

English | [中文](2026-09-26-subagent-default-child-route.zh.md)

## Problem

The Web `subagent` tool's model-selection settings ([user-authorized subagent model routes](2026-08-24-user-authorized-subagent-model-routes.md)) let a user authorize an exact route allowlist, but every call that names no route still inherits the parent Agent's own route. A deployment that wants children to run on a cheaper or subscription route by default — while still letting the main agent choose a different authorized route per task — had no way to express that default without mounting `tool-subagent` inside a profile patch, which the Web preset rows do not expose to Settings.

## Decision

`SubagentModelSelectionConfig` gains an optional `defaultModel: { provider, model, reasoningEffort? }`, validated against `allowedModels` at every durable boundary (settings read, event fold). The durable `subagent/model-selection-policy` event and its stateVersion-2 projection carry the default alongside the route list, so a fresh top-level Session samples it once and every child inherits the exact recorded decision, never re-sampling settings.

`requestedAgentOptions` (`model-selection.ts`) adds the default as a layer strictly below the tool's configured `agentOptions` (including a provider's own `agentRouteDefaults`, merged in first) and above the parent: a configured route wins outright; otherwise the default supplies provider/model and, whenever the default itself names a reasoning effort, that effort — unconditionally, so a Host-recorded default is a deliberate, specific choice that overrides a route-agnostic configured effort left over from before this feature existed. Only when the default has no effort does a configured route-agnostic effort survive, and only when the default does not change the route relative to the parent — the same "route changed without an effort clears it" rule the explicit model-request layer already followed. `requiresRoutePreflight` triggers on a default alone, so a call with no request and no configured route still resolves and validates the effective route through the live LLM adapter before the child starts.

The tool description's selection sentence and the `provider`/`model`/`reasoning_effort` parameter descriptions name the recorded default as a statement of effect ("Omit `provider` and `model` to run the child on `<provider>/<model>`[ at reasoning effort `<effort>`]") in place of the generic "use configured child defaults" wording, and `list_subagent_models` marks the default route with `(default)`. Absent a recorded default, every one of these strings stays byte-identical to before this feature.

The Plugins settings card adds a default-route choice among the currently checked allowed routes, or "same as the calling agent" for none, plus an effort choice sourced from the same live model catalogue the route checkboxes already read; unchecking the default's own route clears it. All three fields save as one revision-fenced mutation.

## Alternatives considered

**Let the default's effort apply only when the route is unchanged.** Rejected: a Host administrator who records a default names it because they want that exact behavior, not a hidden dependency on whichever route the parent happens to run; treating the default's effort as always intended keeps one predictable rule instead of two paths that differ only when a configured route-agnostic effort happens to also be present.

**Apply the default ahead of a provider's own `agentRouteDefaults`.** Rejected: a provider that declares its own route defaults already commits to a specific in-process wiring (e.g., the DSH SDK backend's configured instance route); a Host-level user preference should not override a capability the provider itself asserts, and the existing configured-options merge in `index.ts` already treats `agentRouteDefaults` as part of "configured", so no additional precedence code was needed.

**Skip preflight when only a default supplies the route.** Rejected: the point of a Host-recorded default is to reach a route the user never typed, so skipping validation would let a stale or mistyped default reach `runtimeCtx.subagents.start()` unchecked — exactly the gap `preflightChildLlmRoute` exists to close for every other route source.

## Consequences

- A deployment can steer default delegation cost or capability without either the main agent naming a route on every call or the profile-patch escape hatch the Web presets do not reach.
- Model-visible text changes only when a default is actually recorded; every existing composition without one is unaffected byte-for-byte, pinned in `model-selection.spec.ts`.
- `stateVersion` bumped from 1 to 2 on the `subagentModelSelectionPolicy` projection: a persisted-cache row from the prior unit is discarded and refolded rather than forward-applied as the new `{ allowedModels, defaultModel? }` shape; a v1-written event (no `defaultModel` key) still folds to a policy without a default.
- Unit coverage pins the full precedence matrix (model request, configured route, configured effort-only, default with and without effort, parent), preflight triggering for a default-only call, verbatim model-visible text with and without a default, settings/event validation (malformed, out-of-list), inheritance at depth two, and the client controller/fields default-route and effort staging.

## Related decisions

Route allowlisting, Session sampling and inheritance, and the fixed `list_subagent_models` schema remain owned by [user-authorized subagent model routes](2026-08-24-user-authorized-subagent-model-routes.md); route arguments, adapter preflight, and the fork cache restriction remain owned by [model-selected subagent routes](2026-08-18-model-selected-subagent-routes.md).
