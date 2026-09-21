---
name: dsh-durable-memory
description: Use when changing @deepseek-ai/dsh-memory or @deepseek-ai/dsh-tool-memory, the TOOL_MEMORY prompt section, the memory tool schemas, the catalog injection, the memory snapshot scenarios or e2e suites, or when a plugin or test must consume ctx.memory in deepseek-harness, to order the model-visible text freeze, the unit, lib-mode, snapshot, and real-model lanes, and the documentation updates so the recorded corpus is refreshed exactly once.
---

# DSH durable memory

Work on first-party durable memory touches two packages, every shipped profile's recorded system prompt and tool schemas, and one keyless store fixture. This skill orders that work; the contracts stay in their owners.

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
| Base bundle rows `memory` and `tool-memory` | `packages/bundle/base/cordis.patch.yml`; Web disables the host-plane tools in `packages/bundle/web-app/cordis.patch.yml` and the `standard`, `ptc`, and `cordis` presets mount them |
| Prompt position | `TOOL_MEMORY` in `packages/core/system-prompt/src/index.ts` |
| Keyless recorded scenarios | `snapshots/session/memory-catalog-recall/` (seeded global store, recall, write; owns the composition and header sidecars) and `snapshots/session/memory-project-forget/` (project-scope write, catalog with a `Project:` section, forget; shares that composition) |
| Keyless two-process suites | `packages/memory/tool-memory/tests/cross-session.e2e.ts`, `packages/memory/memory/tests/publish.two-process.e2e.ts` |
| Real-model suite | `packages/memory/tool-memory/tests/real-model.e2e.ts` |

## Freeze model-visible text before anything else

The prompt section, the three tool descriptions and parameter descriptions, the catalog header, the omission line, and the empty-catalog line are quoted by every recorded scenario's `system-prompt*.expected.md` and `tool-schemas*.expected.json` under `snapshots/session`, `snapshots/sdk`, `snapshots/acp`, and `snapshots/web`, and verbatim by the tool-memory README pair. Settle the wording, update the README pair, then refresh the corpus once; a second wording edit costs a second refresh of about a hundred files.

## Run the lanes in this order

1. Unit suites with the coverage the CI gate requires:

```sh
pnpm exec vitest run packages/memory --coverage.enabled=true --coverage.include='packages/memory/*/src/**' --coverage.reporter=text
```

2. Rebuild the host libraries; the snapshot and e2e lanes below load the built `lib/`, not the source:

```sh
pnpm run build:lib:host
```

3. Refresh the recorded corpus once, then replay it:

```sh
DSH_EXAMPLE_MODE=lib DSH_SNAPSHOT=refresh pnpm run test:snapshot
DSH_EXAMPLE_MODE=lib pnpm run test:snapshot
```

Refresh also rewrites the stream timestamps inside a few `writer.expected.jsonl` files; revert those files unless the scenario's behavior changed. A scenario that hand-picks its tools, such as `snapshots/sdk/persistent-tools/cordis.yml`, carries its own `tool-memory` disable row; a new memory tool needs no change there, a renamed one does.

4. Keyless process suites, which need the rebuilt libraries:

```sh
DSH_EXAMPLE_MODE=lib pnpm run test:e2e packages/memory
```

5. The real-model suite self-skips without `DEEPSEEK_API_KEY`; run it with a key before claiming the feature works end to end, and never print the key.

6. Documentation gates after README, guide, or Agent Note edits: re-record each edited pair with `pnpm run verify-translation-pairing --write <pair>`, then `pnpm run doc-sync`. Regenerate `pnpm run gen-tool-catalog`, `pnpm run gen-config-catalog`, `pnpm run gen-cordis-catalog`, and `pnpm run gen-doc-graphs` when schemas, config fields, or service JSDoc changed.

## Seed a store for a recorded scenario

Commit global records only, under the scenario's `workspace/.dsh/storages/memory/global/<name>.json`, with fixed `createdAt` and `updatedAt` values; `memory-catalog-recall` is the template. A project record cannot be seeded because its key embeds a hash of the machine-specific workspace path; let the scripted model write it in-session instead, as `memory-project-forget` does. A `.git` entry cannot be committed either, so the shared composition sets `projectRootMarkers` to `.dsh-project` and the scenario commits `workspace/.dsh-project`. The `.dsh` tree is excluded from the workspace comparison, so writes during replay never diff.

## Consume `ctx.memory` from a plugin or test

Declare `memory` in the plugin's `inject`, pass the owning session's `header.cwd` so project scope resolves, and handle `MemoryError` by its `code`. In tests, mount the real storage stack over a temporary root the way `packages/memory/tool-memory/tests/helpers.ts` does; do not mock the store.

## Do not

- Restate the record schema, config values, error codes, or prompt text here; link the owners above.
- Add a session event or an invariant companion for memory mutations; the tool call and result already log every mutation, and the Agent Note records why.
- Land a Web card for the memory tools without the GIF the repository requires for product-visible GUI changes; the generic tool row is the documented current presentation.
