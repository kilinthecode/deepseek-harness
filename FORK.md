# Fork ledger — Portal Harness

This repository is a **fork** of [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) (MIT).
This file is the ledger of every tracked upstream file the fork deliberately diverges in, and why.

**Read this before resolving a sync conflict.** A conflict in a file listed here is expected — re-apply the
fork's intent, don't take either side blindly. A conflict in a file **not** listed here means the fork
diverged by accident; prefer upstream and re-apply the change through a fork-owned file instead.

Established 2026-09-21. Update this ledger whenever the fork intentionally touches an upstream file.

---

## Sync procedure

```sh
git remote add upstream git@github.com:deepseek-ai/deepseek-harness.git   # once
git fetch upstream
git switch -c sync/upstream-$(date +%F)
git merge upstream/master
```

Rules:

1. **Merge forward; never rebase the fork branch.** Other worktrees are based on it, and rebasing orphans them.
2. **Generated files are never merged by hand.** Take either side, then regenerate:
   ```sh
   pnpm install
   pnpm run gen-cordis-catalog && pnpm run gen-module-graph && pnpm run gen-client-catalog
   pnpm run gen-tool-catalog  && pnpm run gen-config-catalog && pnpm run gen-persistence-catalog
   pnpm run gen-doc-graphs
   ```
3. **`.i18n.yaml` pairing records are content hashes.** Never merge them; after resolving prose, re-record:
   `pnpm run verify-translation-pairing --write <the .md path>`
4. **Re-assert the fork's invariants** after every sync — these tests exist only to catch a sync clobbering the fork:
   - `scripts/client-build-environment.portal.spec.ts` (the `portal` profile block)
   - `packages/client/portal-brand/tests/` (the brand occupants)

---

## Category A — fork identity (small, additive edits)

These are upstream files the fork edits with the smallest possible change, deliberately.

| File | Fork divergence | Since |
|---|---|---|
| `scripts/client-build-environment.ts` | Adds the `PORTAL_CLIENT_BUILD_ENVIRONMENT` block and the `portal` branch in `resolveClientBuildEnvironment`. Upstream's `official` values are untouched. | 2026-09-21 |
| `scripts/verify-package-readme-model-experience.ts` | Adds `packages/client/portal-brand` to `SENTENCE_MODEL_EXPERIENCE` with `kind: 'none'`. | 2026-09-21 |
| `tsconfig.base.json` | Adds the `@deepseek-ai/dsh-client-portal-brand` path alias. | 2026-09-21 |
| `tsconfig.client.json` | Adds the `packages/client/portal-brand` project reference. | 2026-09-21 |
| `packages/bundle/web-app/cordis.patch.yml` | Adds the `portal-brand` client row. Always mounted; the plugin self-gates on the build profile. | 2026-09-21 |
| `packages/bundle/web-app/package.json` | Adds the `@deepseek-ai/dsh-client-portal-brand` dependency. | 2026-09-21 |
| `packages/boot/app-boot/src/profile.ts` | Adds `@deepseek-ai/dsh-experimental-agent-room-profile` to `OPTIONAL_BUNDLES`. | 2026-09-17 |

## Category B — the model-visible identity (largest divergence)

The model's self-description has no composition seam: the shipped base profile is what upstream's snapshot
corpus replays, so changing it diverges 65 upstream files. This is the fork's largest intentional divergence.

| Files | Fork divergence | Since |
|---|---|---|
| `packages/core/system-prompt/src/index.ts` | The `harness:identity` text is `You are an AI agent powered by Portal Harness.` (line 430), and the `includeHarnessIdentity` JSDoc names the fork identity. | 2026-09-21 |
| `packages/core/system-prompt/README.{md,zh.md,i18n.yaml}` | Documents the fork's identity line. | 2026-09-21 |
| `packages/bundle/web-app/src/index.ts` | `webSurfacePrompt` opens `You are interacting with the user through the Portal Harness Web GUI at …`, and the `DSH_WEB_URL` description names the same GUI. | 2026-09-26 |
| `packages/boot/app-boot/src/index.ts` | `addHarnessSourceSection` names the Portal Harness checkout and what the model may extend with it. | 2026-09-26 |
| `snapshots/session/**` (41 files), `snapshots/sdk/**` (10), `snapshots/web/**` (4) | The identity line is line 1 of each `system-prompt.expected.md`. | 2026-09-21 |
| `snapshots/web/{fresh-round-trip,ptc-round,schedule-catalog,cordis-tool-round}/system-prompt.expected.md`, `snapshots/web/fresh-round-trip/web-context.expected.md`, `apps/web/tests/expected/web-runtime-context/web-surface-prompt.expected.md` | Carry the Web GUI and checkout lines above. | 2026-09-26 |
| 10 test files pinning those literals | `agent-loop/tests/loop.spec.ts`, `system-prompt/tests/system-prompt.spec.ts`, `boot/app-boot/tests/app-boot.spec.ts`, `bundle/web-app/tests/web-app.spec.ts`, `preset/persona/tests/persona.spec.ts`, `web/tool-web/tests/tool-web.spec.ts`, `fs/tool-fs/tests/tools.spec.ts`, `fs/tool-fs-search/tests/tools.spec.ts`, `apps/web/tests/replay-round-trip.e2e.ts`, `apps/web/tests/document-preview.e2e.ts` | 2026-09-26 |

Recorded fixtures need no re-recording: they template the prompt as `{{system}}`. A conflict in any file above
means upstream changed the prompt — re-apply the fork's identity line, then regenerate the expected outputs with
`DSH_SNAPSHOT=replay pnpm run test:web` and `pnpm run test:snapshot`.

## Category C — fork product identity in shipped artifacts

Files whose *content* is fork brand material. No seam exists for these, so they are genuine fork patches.

| File | Fork divergence | Since |
|---|---|---|
| `README.{md,zh.md,i18n.yaml}` | Fork title, the derivation statement linking upstream and this ledger, and the fork's clone and issue URLs. Upstream's Discord link and the paper citation stay verbatim as attribution. | 2026-09-26 |
| `apps/web/public/manifest.webmanifest` | PWA name `Portal Harness`, short name `Portal`. | 2026-09-19 |
| `apps/web/public/favicon.svg` | Portal tesseract icon with a light/dark adaptive palette. | 2026-09-21 |
| `apps/web/tests/pwa-manifest.e2e.ts` | Asserts the fork's manifest values and the adaptive-favicon contract. | 2026-09-21 |
| `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/tests/built-boot.expected.e2e.ts` | The pre-build document title and its build-time replacement read `Portal Local Build`; the built-boot assertion follows. Both literals must move together. | 2026-09-26 |
| `apps/desktop/resources/icon*.{png,svg}` | Portal app icons (macOS, Windows, generic). | 2026-09-19 |
| `apps/desktop/src/locale.ts` | Desktop dictionary says "Portal Harness", including the address-in-use recovery dialog. | 2026-09-21 |
| `apps/desktop/src/main.ts` | About-panel application name; dev Dock icon; first-paint deadline. | 2026-09-21 |
| `apps/desktop/installer/strings.nsh` | Installer launch-failure, running-instance, and path-ownership copy names Portal Harness. | 2026-09-26 |
| `apps/desktop/tests/expected/*` | Expected About panel and fatal-dialog copy. | 2026-09-21 |
| `apps/desktop/tests/main-startup.spec.ts` | Asserts the fork's About menu label and window show path. | 2026-09-21 |
| `apps/desktop/README.{md,zh.md,i18n.yaml}` | Documents the fork's About label. | 2026-09-21 |
| `apps/desktop/scripts/*` | Local ad-hoc signing path (`DSH_ADHOC_SIGN`). | 2026-09-19 |
| `packages/client/locale/src/locales/{en,zh}.ts` | `brand.localBuild` reads `Portal Local Build` / `Portal 本地构建` — the fallback brand and document title of a build with no profile. | 2026-09-26 |
| `packages/client/{ui-settings-models,ui-plugin-manager,ui-conversation,ui-model-selection,ui-sidebar-browser,ui-sidebar-documentpreview}/src/client/**` | The welcome notice, plugin install-safety, session-in-use, embedded-browser, and Office-preview copy names Portal Harness. The provider names beside them (`onboardingDescription`, `webSearchDescription`) keep saying DeepSeek: they name the model and search providers, not this product. | 2026-09-26 |
| `packages/client/ui-layout/tests`, `packages/client/ui-sidebar/tests` | Follow the `brand.localBuild` rename in their stubs, assertions, and the sidebar shell snapshot. | 2026-09-26 |
| `apps/web/tests/{scaffold.ts,expected/onboarding-deepseek-config/welcome.expected.md}`, `snapshots/web/document-preview/document.expected.md` | Follow the welcome-notice and Office-preview copy changes. | 2026-09-26 |
| `packages/bundle/web-app/src/startup.ts`, `packages/bundle/sdk-app/src/index.ts`, `apps/cli/src/args.ts`, `apps/cli/tests/expected/launcher-help.txt` | Command descriptions and the launcher help name Portal Harness. | 2026-09-26 |
| `packages/skill/skill-badge/src/index.ts`, `packages/skill/skill-badge/README.{md,zh.md,i18n.yaml}`, `packages/skill/skill-badge/tests`, `apps/cli/tests/dsh-badge.expected.e2e.ts` | The bundled badge skill's description names Portal Harness. The skill name, its `powered by dsh` label, the PNG, and the upstream project URL stay: they are upstream attribution. | 2026-09-26 |

## Category D — fork features that extend upstream packages

The rooms and verification work necessarily modifies upstream-owned packages rather than only adding new ones.

| Area | Files | Since |
|---|---|---|
| `packages/experimental/agent-team/**` | Room runtime: `room.ts`, `room-quorum.ts`, `types.ts`, `projection.ts`, `roster.ts`, `task-board.ts`, `index.ts` and their tests. | 2026-09-17 |
| `packages/experimental/tool-agent-team/**`, `tool-agent-room/**`, `client-ui-agent-team/**`, `agent-room-profile/**` | The room tool surface and its panel. | 2026-09-17 |
| `packages/core/agent-default-model/src/index.ts` | Removes the `reasoningEffort` config field, restoring the package's documented decision. | 2026-09-21 |
| `packages/core/session/src/known-event-types.ts` | Generated: adds the four `room/*` event types. | 2026-09-17 |
| `packages/test-support/session-snapshot/**` | Snapshot-harness support for scenarios that own child roles. | 2026-09-17 |
| `apps/cli/tests/profiles/headless/**` | Owner-local expectations and the scripted team fixture. | 2026-09-17 |
| `packages/client/web/**`, `packages/client/ui-renderer/**` | Boot-page overlay, handoff, and mount-into-host. | 2026-09-19 |

## Category E — generated (never merged by hand)

Regenerate after every sync. Listed so a conflict here is not mistaken for a real divergence.

`docs/{tool,config,persistence}-catalog.*`, `docs/{module-graph,event-producer-consumer}.*`,
`docs/persistence-schema.json`, `docs/persistence-changes/historical-formats/*`,
`packages/core/session/src/known-event-types.ts`,
`packages/extensions/tool-cordis/src/api-catalog.ts`,
`packages/extensions/cordis-client-runtime/src/client/slot-catalog.ts`,
`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`,
`scripts/release/families.spec.ts` (hand-edited package list — expect conflicts when adding fork packages).

---

## Known open decisions

- **Model-visible identity — decided 2026-09-21.** The model now says `You are an AI agent powered by Portal Harness.`
  The direct edit was taken rather than a composing profile, because `dsh web` *is* the shipped `web` template and
  the snapshot harness boots only the shipped profiles, so no composition changes the model's opener without also
  changing the expected outputs. See Category B for the diverged files.
- **Product-visible prose — finished 2026-09-26.** The welcome notice, plugin install-safety, Office preview,
  session-in-use, embedded-browser, installer, and desktop copy now name Portal Harness, as do the Web GUI and
  checkout prompt lines and the command descriptions. The npm scope, package descriptions, package READMEs, the
  `docs/` corpus, the SDK and Python runtime error text, and in-source JSDoc still say DeepSeek Harness; see the
  boundary below.
- **`DSH` — settled 2026-09-26: it stays.** `DSH` is the runtime's short name, not a second product name: the `dsh`
  command, `DSH_HOME` and the other `DSH_*` variables, `__DSH_*` browser globals, and the `@deepseek-ai/dsh-*`
  scope all keep it. Prose that names the runtime mechanism by that short name — `Current DSH file policy` in the
  sandbox runtime context, `lost on DSH restart`, `provider: DSH SDK` — therefore stays too. Renaming it would
  diverge roughly 350 recorded fixtures and derived expectations for a string no product user sees, and "DSH" has
  no expansion derivable from "Portal Harness".
- **The 2026-09-26 boundary.** The rename reached what the product says to a person or a model at runtime. It
  deliberately did not reach surfaces that belong to the deferred package-scope decision: every `package.json`
  `description`, every package README, the `docs/` corpus and the `website/` site title, the TypeScript and Python
  SDK error text and the public `DeepSeekHarness` API identifiers, in-source JSDoc and comments (and therefore the
  generated `docs/config-catalog.*`, which quotes them), `packages/skill/skill-badge/assets/dsh-badge.md` (an
  upstream badge asset), the Codex `clientInfo` handshake pair (`deepseek-harness` / `DeepSeek Harness`), and the
  CDP target titles in `packages/experimental/inspector`. Those packages are still `@deepseek-ai/dsh-*`, so
  renaming their prose alone would put two names in one paragraph — the failure the `DSH` decision avoids. The
  prose itself is a token substitution in both languages, so this is mechanical work rather than translation work
  whenever the scope rename lands.
- **npm scope.** Every package is still `@deepseek-ai/dsh-*`. Renaming the scope touches ~300 manifests and is
  deferred until the fork publishes under its own scope. The boundary above is what closes with it.
- **Duplicate-check gate.** `pnpm run duplication` is red on this branch (8 clones). Four are between
  `tool-agent-room` and `tool-agent-team`, one is `agent-team`'s `RoomFollowQueue` against the private
  `ControlQueue` in `packages/api/session-controller`, two are inside `scripts/gen-tool-catalog.ts`, and one is
  `packages/client/portal-brand/src/client/HarnessNameplate.tsx` extracting the badge geometry upstream still
  carries inline in `BrandWordmark`. See the Agent Note of 2026-09-21.

## Attribution

Upstream's `LICENSE` and copyright headers are retained unmodified. This fork is a derivative work; see the root
`README.md` for the fork's own statement of derivation.
