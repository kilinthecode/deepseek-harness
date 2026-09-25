---
description: "Portal fork brand occupants for the sidebar and conversation hero, active only in a portal build; for fork maintainers keeping product identity out of upstream files."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-portal-brand

English | [中文](README.zh.md)

## Summary

This package gives a `portal` client build the Portal tesseract mark, the Portal wordmark, and the HARNESS nameplate in the sidebar, and the Portal mark in the blank-session hero. It is fork-owned: it exists so the fork's product identity lives outside the upstream brand packages, which upstream keeps editing. The upstream occupants in [`dsh-client-ui-brand-official`](../ui-brand-official/README.md) register only for the `official` build profile, so the two never contend for a slot. It has no runtime state and does not affect model requests.

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

`DSH_CLIENT_BUILD_PROFILE` selects which brand renders. A `portal` build shows the Portal mark and name in the sidebar and the Portal mark in the hero; an `official` build shows the upstream DeepSeek Harness brand there. Any other value leaves the shell fallbacks — the fish mark and the local-build label — in place. The plugin still loads and validates in every case; only the registration is profile-gated. The boot page is not a slot: `dsh-client-web` draws the Portal mark and name on it under every build profile, so an `official` or local build opens on the Portal boot brand and then shows its own in-app brand.

### Changing the brand

Edit the artwork in [`src/client/`](src/client) and the wordmark text in [`src/client/locales.ts`](src/client/locales.ts). The wordmark is a caller-supplied prop, so this package owns the only copy and no primitive carries a fallback string.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The sidebar pair installs as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar declaration, so the set works whether this row activates before or after the declarer, withdraws both occupants when the declaration collapses, and leaves no partial brand mix during HMR. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`, supplied by the `portal` profile), outside the slot system.

The mark, wordmark, and nameplate artwork live here rather than in `dsh-client-ui-primitives` so that upstream's primitive barrel stays upstream's. The wordmark's text arrives through this package's own `portal-brand` locale namespace.

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
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot; the `portal` build profile supplies it.
- **The desktop shell copy is not covered** — the Electron About panel, menus, and dialogs read their own dictionary, so a rename must update that separately.
- **Upstream must keep owning `official`** — a sync that overwrites the Portal profile block in `scripts/client-build-environment.ts` silently returns the fork to the upstream title; `scripts/client-build-environment.portal.spec.ts` fails loudly when it does.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package is the fork's brand seam. Keep every fork brand change inside it: editing `dsh-client-ui-brand-official` or `dsh-client-ui-primitives` re-adds permanent merge conflicts with upstream for no gain. See `FORK.md` for the full ledger of upstream files the fork intentionally diverges in.

</details>

**Runtime invariant:** No companion is published. The package retains no mutable state; its three slot occupants install and leave through two declaration-aware registration sets, and its dictionaries through one effect.
