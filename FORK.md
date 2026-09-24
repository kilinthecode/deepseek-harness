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
| `snapshots/session/**` (41 files), `snapshots/sdk/**` (10), `snapshots/web/**` (4) | The identity line is line 1 of each `system-prompt.expected.md`. | 2026-09-21 |
| 8 test files pinning the literal | `agent-loop/tests/loop.spec.ts`, `system-prompt/tests/system-prompt.spec.ts`, `boot/app-boot/tests/app-boot.spec.ts`, `preset/persona/tests/persona.spec.ts`, `web/tool-web/tests/tool-web.spec.ts`, `fs/tool-fs/tests/tools.spec.ts`, `fs/tool-fs-search/tests/tools.spec.ts`, `apps/web/tests/replay-round-trip.e2e.ts` | 2026-09-21 |

Recorded fixtures need no re-recording: they template the prompt as `{{system}}`. A conflict in any file above
means upstream changed the prompt — re-apply the fork's identity line, then regenerate the expected outputs with
`DSH_SNAPSHOT=replay pnpm run test:web` and `pnpm run test:snapshot`.

## Category C — fork product identity in shipped artifacts

Files whose *content* is fork brand material. No seam exists for these, so they are genuine fork patches.

| File | Fork divergence | Since |
|---|---|---|
| `apps/web/public/manifest.webmanifest` | PWA name `Portal Harness`, short name `Portal`. | 2026-09-19 |
| `apps/web/public/favicon.svg` | Portal tesseract icon with a light/dark adaptive palette. | 2026-09-21 |
| `apps/web/tests/pwa-manifest.e2e.ts` | Asserts the fork's manifest values and the adaptive-favicon contract. | 2026-09-21 |
| `apps/desktop/resources/icon*.{png,svg}` | Portal app icons (macOS, Windows, generic). | 2026-09-19 |
| `apps/desktop/src/locale.ts` | Desktop dictionary says "Portal Harness". | 2026-09-21 |
| `apps/desktop/src/main.ts` | About-panel application name; dev Dock icon; first-paint deadline. | 2026-09-21 |
| `apps/desktop/tests/expected/*` | Expected About panel and fatal-dialog copy. | 2026-09-21 |
| `apps/desktop/tests/main-startup.spec.ts` | Asserts the fork's About menu label and window show path. | 2026-09-21 |
| `apps/desktop/README.{md,zh.md,i18n.yaml}` | Documents the fork's About label. | 2026-09-21 |
| `apps/desktop/scripts/*` | Local ad-hoc signing path (`DSH_ADHOC_SIGN`). | 2026-09-19 |

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
  changing the expected outputs. See Category B for the 65 diverged files.
- **In-app prose** in `ui-settings-models` (welcome notice), `ui-plugin-manager` (install safety), and
  `ui-sidebar-documentpreview` (Office preview error) still says "DeepSeek Harness". The `DSH` acronym appears in
  four more client dictionaries and has no successor derivable from "Portal Harness". Undecided as of 2026-09-21.
- **npm scope.** Every package is still `@deepseek-ai/dsh-*`. Renaming the scope touches ~300 manifests and is
  deferred until the fork publishes under its own scope.
- **Duplicate-check gate.** `pnpm run duplication` is red on this branch (8 clones). Four are between
  `tool-agent-room` and `tool-agent-team`, one is `agent-team`'s `RoomFollowQueue` against the private
  `ControlQueue` in `packages/api/session-controller`, two are inside `scripts/gen-tool-catalog.ts`, and one is
  `packages/client/portal-brand/src/client/HarnessNameplate.tsx` extracting the badge geometry upstream still
  carries inline in `BrandWordmark`. See the Agent Note of 2026-09-21.

## Attribution

Upstream's `LICENSE` and copyright headers are retained unmodified. This fork is a derivative work; see the root
`README.md` for the fork's own statement of derivation.
