---
name: dsh-durable-memory
description: Use when changing @deepseek-ai/dsh-memory or @deepseek-ai/dsh-tool-memory, the TOOL_MEMORY prompt section, the memory tool schemas, the catalog injection, the memory snapshot scenarios or e2e suites, or when a plugin or test must consume ctx.memory in deepseek-harness, to order the model-visible text freeze, the unit, lib-mode, snapshot, and real-model lanes, and the documentation updates so the recorded corpus is refreshed exactly once.
---

# DSH durable memory

Work on first-party durable memory touches two packages, the recorded system prompt and tool schemas of every composition that mounts the tools, and the keyless store fixtures. This skill orders that work; the contracts stay in their owners.

## Read the owners first

- [`packages/memory/memory/README.md`](../../../packages/memory/memory/README.md) — the store: config, record layout, scopes, `ctx.memory` operations, error codes, limitations.
- [`packages/memory/tool-memory/README.md`](../../../packages/memory/tool-memory/README.md) — the tools, the catalog, and the verbatim model-visible text under Model Experience.
- [`docs/subsystems/memory.md`](../../../docs/subsystems/memory.md) — request and result types and the generated `ctx.memory` API.
- [The implemented Agent Note](../../notes/implemented/feature/2026-09-19-first-party-durable-memory.md) — why the design is what it is and what it rejected; keep it current when a fact it states changes.
- [`docs/user/guide/memory.md`](../../../docs/user/guide/memory.md) — what users are told; a behavior change that users can see updates it in the same change.

## Where the pieces live

| Piece | Location |
|---|---|
| Store, domain, project identity | `packages/memory/memory/src/` |
| Tools, catalog injection, prompt section | `packages/memory/tool-memory/src/` |
| Base bundle rows `memory` and `tool-memory` | `packages/bundle/base/cordis.patch.yml`; Web disables the host-plane tools in `packages/bundle/web-app/cordis.patch.yml` and the `standard`, `ptc`, and `cordis` preset declarations in `packages/bundle/web-app/presets/<id>.patch.yml` mount them |
| Prompt position | `TOOL_MEMORY` in `packages/core/system-prompt/src/index.ts` |
| Catalog source kind | the attribution-only `tool-memory` member of `MessageSourceMap` in `packages/memory/tool-memory/src/catalog.ts`, acknowledged by `docs/persistence-changes/2026-09-24-memory-catalog-source.md`; a change to it follows the [persistence-type cookbook](../../../docs/cookbook/reviewing-persistence-type-changes.md) |
| Keyless recorded scenarios | `snapshots/session/memory-catalog-recall/` (seeded global store, recall, write; owns the composition and header sidecars), `snapshots/session/memory-project-forget/` (project-scope write, catalog with a `Project:` section, forget; shares that composition), and `snapshots/sdk/memory-catalog-refresh/` (two SDK turns: the catalog refreshes at the second turn after a write, and the `memory-catalog-compaction` fixture plugin in `packages/test-support/session-snapshot/tests/fixtures/` compacts it away after `memory_recall` so the next step re-injects it; borrows the `compaction-recovery` header sidecars) |
| Keyless two-process suites | `packages/memory/tool-memory/tests/cross-session.e2e.ts`, `packages/memory/memory/tests/publish.two-process.e2e.ts` |
| Real-model suite | `packages/memory/tool-memory/tests/real-model.e2e.ts` |

## Freeze model-visible text before anything else

The prompt section, the three tool descriptions and parameter descriptions, the catalog header, the omission line, and the empty-catalog line are quoted by the `system-prompt*.expected.md` and `tool-schemas*.expected.json` sidecars of every recorded composition that mounts `tool-memory` under `snapshots/session`, `snapshots/sdk`, `snapshots/acp`, and `snapshots/web`, and verbatim by the tool-memory README pair. The tool names alone are also pinned by the Python SDK projection under `scripts/snapshots/python-sdk-single-exe/`. Settle the wording, update the README pair, then refresh the corpus once; a second wording edit costs a second refresh of about a hundred files.

Two pinned sets stay out of a refresh on purpose: `snapshots/web/cordis-tool-round` declares `retired-tools` coverage, so its fixture and sidecars are a frozen historical composition, and `snapshots/web/minimal-preset` composes the `minimal` preset, which has no memory tools.

## Run the lanes in this order

1. Unit suites with the coverage the CI gate requires:

```sh
pnpm exec vitest run packages/memory --coverage.enabled=true --coverage.include='packages/memory/*/src/**' --coverage.reporter=text
```

2. Run the full build; the snapshot and e2e lanes below load the built `lib/`, not the source:

```sh
pnpm run build
```

3. Refresh the recorded corpus once, then replay it:

```sh
DSH_EXAMPLE_MODE=lib DSH_SNAPSHOT=refresh pnpm run test:snapshot
DSH_EXAMPLE_MODE=lib pnpm run test:snapshot
```

A scenario whose sidecars another scenario owns compares its headers against the owner's committed sidecars, so when the first refresh pass rewrites an owner after its dependents ran, those dependents fail with a request-header mismatch; a second refresh pass settles them. Refresh also rewrites native writer oracles (`writer*.expected.jsonl`) and the notifications that follow them, and writes a `session.v4.jsonl` successor beside each selected V3 fixture; revert or delete those unless the recorded content changed. `snapshots/session/compaction-output-reserve` and `compaction-summary-headroom` calibrate their `contextWindow` so the proactive trigger falls between the history and its condensed replacement; a change to the size of the prompt section or tool schemas can move both past it, which replay reports as a request for a fourth scripted model call, and the fix is a new window in each scenario's `cordis.yml`, `cordis.snapshot.yml`, and fixture `request/context` row. A scenario that hand-picks its tools, such as `snapshots/sdk/persistent-tools/cordis.yml`, carries its own `tool-memory` disable row; a new memory tool needs no change there, a renamed one does. The `platform: pwsh` pair `snapshots/session/pwsh-tool-turn` and `persistent-pwsh-tool-turn` refreshes only on a host with `pwsh`; elsewhere give their sidecars the same paragraph and schema entries the refreshed sidecars gained.

4. Refresh the pinned Web sidecars of `fresh-round-trip` and `ptc-round` through their owning Web suites against a fresh Web build, then replay them:

```sh
pnpm run build:web
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/replay-round-trip.e2e.ts apps/web/tests/ptc-round.e2e.ts
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/replay-round-trip.e2e.ts apps/web/tests/ptc-round.e2e.ts
```

`snapshots/web/schedule-catalog` is an authored session that `apps/web/tests/schedule-after.e2e.ts` seeds under the `standard` preset without comparing its sidecars, so give them the same paragraph and schema entries by hand.

5. A change to the memory tool set updates the Python SDK projection: the sorted `toolNames` in `scripts/snapshots/python-sdk-single-exe/restart/requests.json` and the `request/header` tool lists in the selected (highest-generation) `advanced` and `restart` session logs, `advanced/result.json`, and `dynamic-tools/tool-history.json`. `scripts/smoke-python-runtime.py --scenario sdk-restart --update-snapshots` (and `sdk-snapshot`, `sdk-dynamic-tools`) rewrites them, but it needs the packaged single executable that Python-runtime CI builds; without one, edit those lists the way the smoke script renders them.

6. Keyless process suites, which need the rebuilt libraries:

```sh
DSH_EXAMPLE_MODE=lib pnpm run test:e2e packages/memory
```

7. The real-model suite self-skips without `DEEPSEEK_API_KEY`; run it with a key before claiming the feature works end to end, and never print the key.

8. Documentation gates after README, guide, or Agent Note edits: re-record each edited pair with `pnpm run verify-translation-pairing --write <pair>`, then `pnpm run doc-sync`. Regenerate `pnpm run gen-tool-catalog`, `pnpm run gen-config-catalog`, `pnpm run gen-cordis-catalog`, and `pnpm run gen-doc-graphs` when schemas, config fields, or service JSDoc changed.

## Seed a store for a recorded scenario

Commit global records only, under the scenario's `workspace/.dsh/storages/memory/global/<name>.json`, with fixed `createdAt` and `updatedAt` values; `memory-catalog-recall` is the template. A project record cannot be seeded because its key embeds a hash of the machine-specific workspace path; let the scripted model write it in-session instead, as `memory-project-forget` does. A `.git` entry cannot be committed either, so the shared composition sets `projectRootMarkers` to `.dsh-project` and the scenario commits `workspace/.dsh-project`. The `.dsh` tree is excluded from the workspace comparison, so writes during replay never diff.

## Consume `ctx.memory` from a plugin or test

Declare `memory` in the plugin's `inject`, pass the owning session's `header.cwd` so project scope resolves, and handle `MemoryError` by its `code`. In tests, mount the real storage stack over a temporary root the way `packages/memory/tool-memory/tests/helpers.ts` does; do not mock the store.

## Do not

- Restate the record schema, config values, error codes, or prompt text here; link the owners above.
- Add a session event or an invariant companion for memory mutations; the tool call and result already log every mutation, and the Agent Note records why.
- Land a Web card for the memory tools without the GIF the repository requires for product-visible GUI changes; the generic tool row is the documented current presentation.
