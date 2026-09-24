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
   pnpm run gen-doc-graphs    && pnpm run gen-plugin-packages
   pnpm run verify-persistence-formats --write
   ```
   `gen-tool-catalog`, `gen-config-catalog`, and `gen-doc-graphs` write only the English page; carry each
   change into the `.zh.md` pair by hand. When upstream changes a type the fork's persistence records embed,
   refresh the fork's unaccepted record with `pnpm run persistence-changes --update <record id>`.
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
| `apps/cli/package.json` | Adds the `@deepseek-ai/dsh-experimental-agent-room-profile` dependency, which an `OPTIONAL_BUNDLES` entry requires the installation to ship. | 2026-09-17 |
| `tsconfig.host.json` | Adds the `tool-agent-room` and `agent-room-profile` project references and `apps/web/tests/agent-room-panel.e2e.ts`. | 2026-09-17 |
| `apps/web/tests/plugin-{manager,config}.e2e.ts`, `apps/web/tests/expected/plugin-manager/{manager,live-enabled}.expected.md`, `apps/web/tests/expected/plugin-config/official.expected.md` | Count the room bundle as a third optional bundle in the Official group. | 2026-09-23 |

## Category B — the model-visible identity (largest divergence)

The model's self-description has no composition seam: the shipped base profile is what upstream's snapshot
corpus replays, so changing it diverges 65 upstream files. This is the fork's largest intentional divergence.

| Files | Fork divergence | Since |
|---|---|---|
| `packages/core/system-prompt/src/index.ts` | The `harness:identity` text is `You are an AI agent powered by Portal Harness.` (line 430), and the `includeHarnessIdentity` JSDoc names the fork identity. | 2026-09-21 |
| `packages/core/system-prompt/README.{md,zh.md,i18n.yaml}` | Documents the fork's identity line. | 2026-09-21 |
| `snapshots/session/**` (44 files), `snapshots/sdk/**` (10), `snapshots/web/**` (4) | The identity line is line 1 of each `system-prompt.expected.md`. | 2026-09-21 |
| 8 test files pinning the literal | `agent-loop/tests/loop.spec.ts`, `system-prompt/tests/system-prompt.spec.ts`, `boot/app-boot/tests/app-boot.spec.ts`, `preset/persona/tests/persona.spec.ts`, `web/tool-web/tests/tool-web.spec.ts`, `fs/tool-fs/tests/tools.spec.ts`, `fs/tool-fs-search/tests/tools.spec.ts`, `apps/web/tests/replay-round-trip.e2e.ts` | 2026-09-21 |

Recorded fixtures need no re-recording: they template the prompt as `{{system}}`. A conflict in any file above
means upstream changed the prompt — re-apply the fork's identity line, then regenerate the expected outputs with
`DSH_SNAPSHOT=replay pnpm run test:web` and `pnpm run test:snapshot`. A scenario upstream adds after a sync
still opens with upstream's identity line: refresh it with
`DSH_EXAMPLE_MODE=lib DSH_SNAPSHOT=refresh vitest run --config vitest.snapshot.config.ts -t <scenario>`
and keep only the changed `*.expected.*` files, never a rewritten or new committed `session.v*.jsonl`.

## Category C — fork product identity in shipped artifacts

Files whose *content* is fork brand material. No seam exists for these, so they are genuine fork patches.

| File | Fork divergence | Since |
|---|---|---|
| `apps/web/public/manifest.webmanifest` | PWA name `Portal Harness`, short name `Portal`. | 2026-09-19 |
| `apps/web/public/favicon{,-dark}.svg` | Portal tesseract icon. `favicon.svg` is the light-scheme mark and `favicon-dark.svg` inverts its three colours; upstream's media-qualified `<link>` tags in `index.html` choose between them. Regenerate the dark file from the light one after any edit. | 2026-09-21 |
| `apps/web/tests/pwa-manifest.e2e.ts` | Asserts the fork's manifest values and the light/dark favicon palette pair. | 2026-09-21 |
| `apps/desktop/resources/icon*.{png,svg}` | Portal app icons (macOS, Windows, generic). The Windows plate keeps `rx=44`; upstream moved its own to `rx=192`. Edit the SVG and re-export the PNG together. | 2026-09-19 |
| `apps/desktop/src/locale.ts` | Desktop dictionary says "Portal Harness", including upstream's Hide/Quit, welcome, and update keys; the model-provider text and the `DSH` acronym are unchanged. | 2026-09-21 |
| `apps/desktop/src/main.ts` | About-panel application name; development Dock icon. The window reveal is upstream's (see Known open decisions). | 2026-09-21 |
| `apps/desktop/tests/expected/*` | Expected About panel, application menu, welcome, and fatal-dialog copy. | 2026-09-21 |
| `apps/desktop/tests/main-startup.spec.ts` | Asserts the fork's About menu label and About dialog copy. | 2026-09-21 |
| `apps/desktop/README.{md,zh.md,i18n.yaml}` | Documents the fork's About label, the development Dock icon, and the `~/Library/Logs/Portal` crash-report directory. | 2026-09-21 |
| `apps/desktop/scripts/*` | `productName: 'Portal'` in `electron-builder-config.mjs`, so `package-macos.ts`, `package-target.ts`, and `smoke-packaged-runtime.ts` locate `Portal.app`, `Portal.exe`, and `MacOS/Portal`. Local ad-hoc signing path (`DSH_ADHOC_SIGN`), which in `macos-runtime.ts` bypasses upstream's signature cache. | 2026-09-19 |

## Category D — fork features that extend upstream packages

The rooms and verification work necessarily modifies upstream-owned packages rather than only adding new ones.

| Area | Files | Since |
|---|---|---|
| `packages/experimental/agent-team/**` | Room runtime: `room.ts`, `room-quorum.ts`, `types.ts`, `projection.ts`, `roster.ts`, `task-board.ts`, `task-view.ts` (the `verifying` status and named verification), `index.ts` and their tests. Upstream removed every Team Remote method; `TeamService` still extends `TypertRemoteService` for five room methods (`room`, `roomStream`, `roomPrompt`, `roomPropose`, `roomEscalate`), with the `./typert` and `./remote` exports. The projection checkpoint layout is version 5. | 2026-09-17 |
| `packages/experimental/tool-agent-team/**`, `tool-agent-room/**`, `client-ui-agent-team/**`, `agent-room-profile/**` | The room tool surface and its panel. `client-ui-agent-team` mounts the room `./remote` contribution and renders a room section inside upstream's read-only, projection-driven panel. `agent-room-profile` carries the `ui-agent-team` row, as upstream's single Team bundle does. `tool-agent-team` declares the `dsh-llm` peer its route schema imports. | 2026-09-17 |
| `scripts/gen-tool-catalog.ts`, `scripts/gen-cordis-catalog.ts`, `scripts/gen-doc-graphs.ts`, `scripts/type-equiv.manifest.json`, `packages/core/tools/tests/gen-tool-catalog.spec.ts`, `snapshots/AGENTS.md` | Generators and gates cover the room: the tool catalog boots `tool-agent-room` through the Team catalog helper it shares with `tool-agent-team`, the Cordis catalog links room types, the doc graphs list the room consumers of `agentTeams`, type-equiv pins the room snapshots, and the snapshot rules document child-role scenarios. | 2026-09-17 |
| `snapshots/session/team-targets/{system-prompt,tool-schemas}.expected.*` | Pin the fork's Team POLICY and the route and peer-verification tool fields. | 2026-09-23 |
| `packages/core/agent-default-model/src/index.ts` | Removes the `reasoningEffort` config field, restoring the package's documented decision. | 2026-09-21 |
| `packages/core/session/src/known-event-types.ts` | Generated: adds the four `room/*` event types. | 2026-09-17 |
| `packages/test-support/session-snapshot/**` | Snapshot-harness support for scenarios that own child roles. | 2026-09-17 |
| `apps/cli/tests/profiles/headless/**` | Owner-local expectations and the scripted team fixture. | 2026-09-17 |
| `packages/client/web/**`, `packages/client/ui-renderer/**` | Boot-page overlay, handoff, and mount-into-host. The overlay's z-index (1150) sits above application layers (1100) and below the WebWorker preview's pre-boot source chooser (1200). | 2026-09-19 |
| `apps/web/tests/settings-chrome.e2e.ts`, `apps/web/tests/preview-boot.e2e.ts`, `apps/web/tests/lifecycle-chrome.e2e.ts` | Find the boot page by `[data-dsh-boot]`: the fork's overlay nests the progress hint in a status block, shows it only when boot outlasts the brand moment, and holds over the mounted application on page timers, which a test's installed clock must run out. | 2026-09-23 |

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
  changing the expected outputs. See Category B for the 65 diverged files.
- **In-app prose** in `ui-settings-models` (welcome notice), `ui-plugin-manager` (install safety), and
  `ui-sidebar-documentpreview` (Office preview error) still says "DeepSeek Harness". The `DSH` acronym appears in
  four more client dictionaries and has no successor derivable from "Portal Harness". Undecided as of 2026-09-21.
- **npm scope.** Every package is still `@deepseek-ai/dsh-*`. Renaming the scope touches ~300 manifests and is
  deferred until the fork publishes under its own scope.
- **Duplicate-check gate.** `pnpm run duplication` is red on this branch (6 clones). Four are between
  `tool-agent-room` and `tool-agent-team`, one is `agent-team`'s `RoomFollowQueue` against the private
  `ControlQueue` in `packages/api/session-controller`, and one is
  `packages/client/portal-brand/src/client/HarnessNameplate.tsx` extracting the badge geometry upstream still
  carries inline in `BrandWordmark`. The two `scripts/gen-tool-catalog.ts` clones were removed on 2026-09-23 by
  sharing one Team catalog helper. See the Agent Note of 2026-09-21.
- **Desktop boot brand visibility — open as of 2026-09-23.** Upstream's welcome window keeps the
  main window hidden until the Host is ready and the welcome-or-workspace choice is made, and upstream's
  `main-startup.spec.ts` pins it. The 2026-09-23 sync kept that reveal and dropped the fork's ready-to-show
  reveal and 15 s first-paint deadline, so on desktop the boot brand sequence mostly plays while the window is
  hidden; `dsh web` is unaffected. Restoring it means revealing on ready-to-show when neither the welcome window
  nor recovery is active, re-adding the deadline, and changing those upstream tests.
- **Browser task controls — follows upstream as of 2026-09-23.** Upstream made the Team panel read-only and
  projection-driven. The room section keeps the floor, decision, and escalation actions, but
  the browser no longer creates, edits, submits, or verifies tasks.
- **Remaining upstream brand strings.** `apps/desktop/renderer/assets/welcome-brand.svg` is upstream's DeepSeek
  artwork (its alt text says Portal Harness); `apps/desktop/installer/strings.nsh`, `installer/extract-report.h`,
  the `dsh` protocol display name, and `development-app.ts`'s `CFBundleURLName` still say DeepSeek Harness,
  and `apps/desktop/README.md` still says the platform icons retain the whale.

## Attribution

Upstream's `LICENSE` and copyright headers are retained unmodified. This fork is a derivative work; see the root
`README.md` for the fork's own statement of derivation.
