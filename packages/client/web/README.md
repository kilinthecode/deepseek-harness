---
description: "Web boot kernel for the web GUI: two-stage boot of the client plugin tree, the framework-free boot page, and the shared module table, for users and maintainers composing or debugging the browser application."
kind: "package-library"
---

# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

## Summary

`dsh-client-web` boots the web GUI: it loads the client module system from the Host-provided boot graph, then activates every client plugin before the application mounts, so the full UI appears only when every plugin is up. A framework-free boot page reports per-entry status, so a failing bundle or plugin stays visible instead of a blank screen. It also defines the shared module table (`PLATFORM_MODULES`) that every dynamic bundle resolves its externals against. The model never sees this package.

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

Use it when you assemble the browser application: `apps/web`'s Vite entry runs `new AppWebEntry(container).run()` against the mount point, and the boot page carries the user through activation. Ordinary browser callers pass no options. A pre-injected page transport is the default ahead of the `seams` override: when `globalThis.__DSH_TRANSPORT__` carries `loadBundle`, the module stage adopts it as the bundle transport and skips the immediate-tier HTTP prefetch, while explicit `seams` still win (for example jsdom tests, where external `<script>` execution cannot reach the page context).

Static application pages install `__DSH_BOOT_READY__` before the entry runs. The boot page renders immediately while `run()` waits; the page owner applies the Host rows with `applyIndexInjections` (also exported from `./injections`) and resolves the deferred after all scripts finish. A rejected deferred renders a boot failure unless the caller supplies `run(onFailure)` to present the error externally while retaining the loading page. Desktop uses this callback to request native recovery. Desktop and WebWorker share the injection interpreter; server-side `tapIndex` HTML transforms apply only to served documents.

The shell base styles apply automatic CJK/Latin spacing to ordinary content in supporting browsers. Semantic code and terminal, diff, read, and search output containers retain literal source spacing and column alignment; browsers without `text-autospace` support ignore both declarations.

### What boot looks like

Boot runs in two stages: the module stage adopts the parser-loaded bootstrap batch, builds the module system from the Host-provided boot graph, and prefetches the `immediately` tier through the shared application-batch URL, which executes once. The plugin stage then activates every graph entry and waits for all of them before mounting the UI renderer beside the marked boot DOM: the application renders beneath the boot page overlay, which finishes its brand moment and fades out.

### The boot page

The boot page uses plain DOM and local CSS, so bundle and plugin-activation failures remain visible: it draws the Portal mark with the typed `PORTAL` wordmark and `HARNESS` nameplate, and reports per-entry status. A boot that outlasts the brand moment also gains one spinner node whose CSS arc grows as entries activate; a boot that finishes inside it shows no spinner at all. A plugin that fails import or activation is reported by name with the reason (missing service, import failure, or state) instead of a blank page. The console contains the original import error.

### The shared module table

`PLATFORM_MODULES` (in `src/platform.ts`) names the shell-seeded shared modules — React, Cordis, and static UI libraries — and together with `PRELOADED_CLIENT_EXTERNALS` (the parser-preloaded runtime row) defines the implicit external baseline every dynamic bundle resolves against. `dsh.client.external` adds only exact non-baseline requests; see [shared modules and the module graph](../AGENTS.md#shared-modules-and-the-module-graph).

### Configuration

The package accepts no plugin config of its own; the generated [configuration catalog](../../../docs/config-catalog.md) lists every plugin config in the repo for comparison.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Menus use the shared `MenuSurface` material, including the macOS backing for background blur; custom content follows the [menu rules](../../../docs/web-styling.md#component-rules).

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the boot kernel is built; observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The kernel owns exactly three things: the module system, the Cordis Loader, and the boot page. The Host owns the graph, batch preload, and loader facade, so `AppWebEntry` never knows the bootstrap package id or parses the wire format. The dynamic UI renderer receives the mount point only after every client entry activates.

### Two-stage boot

`run()` calls the Host-installed `window.__ModuleLoader__.create({ boot, staticModules, ...seams })`; the facade returns the constructed module system and parsed manifest after adopting the parser-loaded bootstrap batch. The module stage prefetches the `immediately` tier through the one shared application-batch URL. The plugin stage mounts the Loader, assigns `loader.internal = modules`, creates every graph entry uniformly, awaits quiescence, then audits activation: any entry that failed import, stayed pending on a missing service, or landed in another non-active state throws one aggregated error naming every failing entry.

### Boot page mechanics

The boot page is plain DOM with local CSS whose fallback fonts and colors match the theme tokens that arrive during loading. The brand sequence reveals the mark in four staged groups, types the wordmark, and lands the nameplate as the caret leaves, animating opacity and transform alone so it keeps its frame rate while the plugin roster loads on the same main thread. `internal/status` events drive the spinner and per-entry labels, which join the card only when boot outlasts 2.8s. The overlay starts below the Windows desktop caption strip and keeps its node and animation phase through the application mount. On the macOS desktop the overlay precedes the application host inside `#root` and marks no drag row, so while it holds and fades, the marked chrome rows of the application beneath it stay the window drag regions. Once the application is mounted it waits for the brand animations to finish, at most 4s (2.6s from mount where the host reports no animations), rests 260ms, and fades over 480ms onto the ready application; reduced motion removes it at once, and so does disposing the entry. `fail()` renders the thrown reason. React mounting, slot rendering, and assembly live in `ui-renderer`; `ui-layout` owns the assembled browser-title projection.

The boot kernel delegates manifest entry creation to Client Modules so live graph synchronization owns the same entry identities after startup. The initial activation audit remains strict; later page-local failures appear in Settings → Plugins → Plugin list.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Library entry: `AppWebEntry`, `getStaticModules`, platform tables |
| [`src/boot.ts`](src/boot.ts) | `AppWebEntry`: module stage, boot page, immediate-tier prefetch, window drag-rect watcher install, then `bootClient` + `mountClient` |
| [`src/boot-client.ts`](src/boot-client.ts) | `bootClient` / `assertEntriesActive`: Loader mount, one entry per manifest row, activation audit |
| [`src/mount.ts`](src/mount.ts) | `mountClient`: renderer handoff through a `uiRenderer` dependency fiber |
| [`src/boot-page.ts`](src/boot-page.ts) | Framework-free boot page: brand sequence, spinner, per-entry status, failure rendering |
| [`src/platform.ts`](src/platform.ts) | `PLATFORM_MODULES` / `PRELOADED_CLIENT_EXTERNALS`: the implicit external baseline |
| [`src/seed.ts`](src/seed.ts) | Static module table handed to the loader at boot |
| [`src/window-drag/regions.ts`](src/window-drag/regions.ts) | The darwin app-region composition model, and the interactive selector `base.css` subtracts |
| [`src/window-drag/recall.ts`](src/window-drag/recall.ts) | The shell's one window drag-rect watcher (electron/electron#32341): measure the marked rows per frame and pulse the recall mark while they move |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the boot contract is not enough: the module system it boots, the renderer that mounts the app, and the client authoring rules behind the baseline.

- [Client module system](../modules/README.md) — the lazy module table and boot graph this kernel consumes.
- [UI renderer](../ui-renderer/README.md) — receives the mount point and binds slot data to React.
- [Client modules subsystem](../../../docs/subsystems/client-modules.md) — the web plugin table, boot graph wire, and bundle route.
- [Client authoring rules](../AGENTS.md#shared-modules-and-the-module-graph) — the shared-module baseline and `dsh.client.external` semantics.
- [Client group map](../README.md) — the browser half this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

None, as the boot kernel is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the boot kernel does not support. They are current package constraints, not a task backlog.

- **The application waits for the full roster** — one failed entry keeps the framework-free boot page visible with a per-entry report; partial UI availability is not supported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The Vite entry shell provides boot glue and module-table seeding, emits no Cordis events, and holds no cross-plugin mutable state; the boot chain (loading page → settled → one-flip UI) is verified by the web smoke e2e against the real carrier.
