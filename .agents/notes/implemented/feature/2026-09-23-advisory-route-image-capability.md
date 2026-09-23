# Agent Note: The Web composer reads the route's image capability as an advisory

Status: implemented

English | [中文](2026-09-23-advisory-route-image-capability.zh.md)

## Problem

The Web composer accepted images on every route. It learned that the selected route refuses images only after Send, when Host prompt admission rejected the prompt with `MODEL_DOES_NOT_SUPPORT_IMAGES`; switching a Session to a text-only route while the draft held images gave no warning, and the model menu did not say which models accept images.

## Decision

### The catalog carries the capability

`session/modelCatalog` rows carry the model's `inputModalities` when `resolveModelInfo` returns them and omit the field otherwise. The field is wire-only; no Session event or persisted type changes.

### The capability is pushed one way into the composer

`ui-model-selection` computes a per-Session `boolean | null` from the Session's current selection and the loaded catalog and publishes it to `ctx.conversation.routeImage`, the same one-way channel as composer blocks, so `ui-conversation` imports nothing from it. It publishes `false` for a listed text-only selection, `true` for a listed image-capable selection or a listed row without `inputModalities`, and `null` before the first load or for an unlisted selection, and it keeps the last value on a refresh error.

### The composer acts only on `false`

With `false`, the composer refuses image intake with `image.modelUnsupported`; while the rail holds images it shows that copy once per episode, disables Send, and refuses the Enter gesture for a message draft. A `/` command stays submittable so `/model` can switch back. `null` and `true` leave the composer unchanged. Host prompt admission remains the enforcement point. The model menu shows an Image caption on rows whose list includes `image`.

## Alternatives considered

**A Host projection of route capability.** Session projections are synchronous folds of Session events, while `resolveModelInfo` is asynchronous and its answer changes with adapters, settings, and credentials. The catalog the client already reloads on those events carries the fact without a second cache.

**Refusing an unknown capability on the client.** Treating an absent list, an unloaded catalog, or an unlisted selection as text-only would lock image intake on routes the Host admits.

**A confirmation dialog in the model menu.** The menu cannot see the draft, and `/model` would bypass it; the composer observes every route change.

**A runtime import from `ui-model-selection` into `ui-conversation`.** Feature plugins must not runtime-import each other; the one-way push follows the existing composer-block channel.

## Consequences

The composer disagrees with the Host only toward allowing: an unknown or unlisted route allows images and the Host decides. Users see the refusal before sending and can remove the images or switch back. A deployment that composes no `ui-model-selection` keeps today's behavior because the advisory stays `null`.

## Testing

Specs cover the catalog field (`packages/api/session-controller/tests/session-models.host.spec.ts`), the advisory push (`packages/client/ui-model-selection/tests`), the registry (`packages/client/ui-conversation/tests/route-image.client.spec.ts`), and the composer intake, notice, Send, Enter, and slash-command behavior (`packages/client/ui-conversation/tests/input-bar.client.spec.tsx`).
