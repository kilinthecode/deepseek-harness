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

With `false`, the composer refuses image intake with `image.modelUnsupported`; while the rail holds images it shows that copy once per episode and refuses Send and the Enter gesture for a message draft or for a command claim that carries attachments. A `/` line whose claim carries no attachments stays submittable under the command plane's own attachment policy, and the command submit refuses a line that adjudicates to an attachment-carrying claim before encoding its images, because Host command execution does not check the route. `null` and `true` leave the composer unchanged. Host prompt admission refuses an image prompt the Session's resolved model does not accept, regardless of the advisory. The model menu shows an Image caption on rows whose list includes `image`.

## Alternatives considered

**A Host projection of route capability.** Session projections are synchronous folds of Session events, while `resolveModelInfo` is asynchronous and its answer changes with adapters, settings, and credentials. The catalog the client already reloads on those events carries the fact without a second cache.

**Refusing an unknown capability on the client.** Treating an absent list, an unloaded catalog, or an unlisted selection as text-only would lock image intake on routes the Host admits.

**A confirmation dialog in the model menu.** The menu cannot see the draft, and `/model` would bypass it; the composer observes every route change.

**A runtime import from `ui-model-selection` into `ui-conversation`.** Feature plugins must not runtime-import each other; the one-way push follows the existing composer-block channel.

## Consequences

The composer and Host prompt admission can disagree in both directions. An unknown or unlisted route allows images, and the Host decides. A stale advisory refuses images the Host would admit: a `false` retained after a failed catalog refresh outlives an adapter, setting, or credential change that made the route image-capable until the next successful load, and a model switch keeps the previous value until the `modelSelection` projection reports the new selection. Users see the refusal before sending and can remove the images or switch back. A deployment that composes no `ui-model-selection` leaves the advisory `null`, so its composer accepts images on every route; Host prompt admission still refuses an image prompt on a text-only route, and the images of an attachment-carrying command reach the model request unchecked.

## Testing

Specs cover the catalog field (`packages/api/session-controller/tests/session-models.host.spec.ts`), the advisory push (`packages/client/ui-model-selection/tests`), the registry (`packages/client/ui-conversation/tests/route-image.client.spec.ts`), the composer intake, notice, Send, Enter, and slash-command behavior in both locales (`packages/client/ui-conversation/tests/input-bar.client.spec.tsx`), and the command-submit refusal (`input-matrix.client.spec.tsx`, `input-scenarios.client.spec.tsx`, and `service-orchestration.client.spec.ts` in the same directory, and the built-client `apps/web/tests/command-image-envelope.expected.e2e.ts`).
