---
description: "Portal fork brand occupants for the sidebar and conversation hero, active only in the portal or portal-dev builds; for fork maintainers keeping product identity out of upstream files."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-portal-brand

English | [中文](README.zh.md)

## Summary

This package gives a `portal` client build the Portal tesseract mark, the Portal wordmark, and the HARNESS nameplate in the sidebar, and the Portal mark in the blank-session hero. A `portal-dev` build adds the dev-channel chip and a violet accent, so a dev build is never mistaken for production. It is fork-owned so the fork's product identity stays outside the upstream brand packages, whose occupants register only for `official` and never contend for the same slot. It has no runtime state and does not affect model requests.

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

Mount this plugin in the browser roster of a deployment whose identity is Portal's, then build the client with the `portal` profile so the occupants register.

### Choosing the profile

`DSH_CLIENT_BUILD_PROFILE` selects which brand renders. A `portal` build shows the Portal mark and name in the sidebar and the Portal mark in the hero; a `portal-dev` build shows the same brand with the dev-channel chip after the nameplate and the violet dev accent; an `official` build is untouched and shows the upstream DeepSeek Harness brand. Any other value leaves the shell fallbacks — the fish mark and the local-build label — in place. The plugin still loads and validates in every case; only the registration is profile-gated.

### Changing the brand

Edit the Portal mark in [`src/client/`](src/client) and the wordmark text in [`src/client/locales.ts`](src/client/locales.ts). The HARNESS nameplate uses the `nameplateOnly` rendering of `BrandWordmark` from `dsh-client-ui-primitives`, so it shares the official wordmark geometry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The sidebar pair installs as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar declaration, so the set works whether this row activates before or after the declarer, withdraws both occupants when the declaration collapses, and leaves no partial brand mix during HMR. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`, supplied by each fork profile), outside the slot system.

The Portal-specific mark and wordmark stay in this package. The HARNESS nameplate uses the nameplate-only rendering of `BrandWordmark` from `dsh-client-ui-primitives`, keeping the shared artwork aligned with the official wordmark. The Portal wordmark text arrives through this package's own `portal-brand` locale namespace. The dev variant registers its own name component and stacks one theme token layer (`portal-brand.dev`) through the optional theme service, so the accent rides the user's base palette and the layer leaves with the plugin.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark` and `sidebar.brand.name` and renders their fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [ui-brand-official](../ui-brand-official/README.md) — the upstream occupants this package displaces under the fork's profile.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define how the fork's brand presentation is supplied. They are current package constraints, not a brand-design comparison or a task backlog.

- **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The dev accent is optional** — the violet accent layer rides the theme service, so a composition without `ui-theme` keeps the base accent while the dev chip still marks the build.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot; each fork profile supplies its own title.
- **The desktop shell copy is not covered** — the Electron About panel, menus, and dialogs read their own dictionary, so a rename must update that separately.
- **Upstream must keep owning `official`** — a sync that overwrites the Portal profile block in `scripts/client-build-environment.ts` silently returns the fork to the upstream title; `scripts/client-build-environment.portal.spec.ts` fails loudly when it does.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package owns the fork-specific brand graphics and product copy. The HARNESS nameplate uses the shared `BrandWordmark` primitive; keep Portal-only marks here. See `FORK.md` for the full ledger of upstream files the fork intentionally diverges in.

</details>

**Runtime invariant:** No companion is published. The package retains no mutable state, and its three slot occupants install and leave through one transactional effect.
