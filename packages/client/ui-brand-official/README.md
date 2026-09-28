---
description: "Portal brand occupants for the sidebar and hero slots, active only in the fork's portal build; for users and maintainers choosing or replacing brand presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

This package gives a `portal` client build the Portal tesseract mark and the Portal wordmark with its Harness nameplate in the sidebar, and the same mark in the blank-session hero. An `official` build keeps upstream's occupants — the shipped fish mark and the `DeepSeek Harness` wordmark — so the upstream brand and the expectations that pin it stay untouched; a build with no profile keeps the shell's fallbacks. Choose it for deployments branded as Portal Harness; deployments with another identity should provide a replacement brand package. It has no runtime state and does not affect model requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the browser roster of a deployment whose identity is Portal's own, then build the client with the `portal` profile so the occupants register:

```sh
pnpm run build -- --profile portal
```

`DSH_BUILD_CLIENT_PROFILE=portal` selects the same profile for every command that resolves the client build environment.

### Choosing the profile

`DSH_CLIENT_BUILD_PROFILE` selects which brand renders. A `portal` build shows the Portal mark and the Portal wordmark with its Harness nameplate in the sidebar and the Portal mark in the hero; an `official` build shows upstream's fish mark and `DeepSeek Harness` wordmark and leaves the hero on the fallback its declaring package owns; a build with no profile registers nothing and keeps every shell fallback, including the local-build label. The plugin still loads and validates in every case; only the registration is profile-gated.

### Replacing the brand

A deployment with its own identity leaves this package out and composes another package that occupies the sidebar and hero slots. Occupying a slot is the only composition route; there is no brand configuration surface here.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The sidebar pair installs as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar declaration, so the set works whether this row activates before or after the declarer, withdraws both occupants when the declaration collapses, and leaves no partial brand mix during HMR. The hero mark waits on its own declaration, so a composition with no Conversation keeps the sidebar brand. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`), outside the slot system.

The name entry declares the shared `common` locale namespace, so the render machinery synthesizes its `t` seat from that dictionary's `brand.wordmark` key; the wordmark primitive renders the text it receives and owns no copy of its own.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark` and `sidebar.brand.name` and renders their fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how brand presentation is supplied. They are current package constraints, not a brand-design comparison or a task backlog.

- **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot; the `portal` profile supplies `Portal Harness`.
- **Upstream owns `official`** — the fork's identity is a separate profile, so an upstream sync that overwrites the Portal profile block in `scripts/client-build-environment.ts` returns the fork to the upstream title; `scripts/client-build-environment.portal.spec.ts` fails loudly when it does.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package retains no mutable state, and its slot occupants install and leave with the plugin fiber.
