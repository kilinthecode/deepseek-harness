# Agent Note: Fork product identity lives in fork-owned packages

Status: implemented

English | [中文](2026-09-21-fork-identity-lifecycle.zh.md)

## Problem

This repository is a fork. Its product identity — the Portal mark, wordmark, and nameplate, the build title, and the desktop shell copy — was originally implemented by editing upstream's own brand packages: `dsh-client-ui-brand-official` for the occupants, `dsh-client-ui-primitives` for the artwork, and the `OFFICIAL_CLIENT_BUILD_ENVIRONMENT` constant for the title.

Those are exactly the files upstream keeps editing. Diverging inside them converts every upstream sync into a manual merge of files whose content the fork does not actually want to own, and it hides the fork's intent: a reader cannot tell a deliberate rebrand from a stale local edit. The same problem applies to any fork work that lands inside an upstream package by default, so the fork needs a standing rule rather than a one-off cleanup.

## Decision

The fork's product identity lives in fork-owned files. Upstream files receive only minimal additive seams, and `FORK.md` at the repository root is the ledger of every upstream file the fork intentionally diverges in, with the reason and the date.

Four seams carry the identity:

- **Brand occupants.** `packages/client/portal-brand` owns the mark, wordmark, and nameplate artwork and occupies the three generic brand slots. It was created by moving the artwork out of `dsh-client-ui-primitives` and reverting both upstream brand packages to their upstream content.
- **Build profile.** `scripts/client-build-environment.ts` gains a `portal` profile carrying `DSH_CLIENT_TITLE: 'Portal Harness'`, and upstream's `official` values are restored to `DeepSeek Harness`. The profile gate is what keeps the two occupant sets from contending: upstream's register only for `official`, the fork's only for `portal`, and a `single` slot therefore never sees two candidates.
- **Invariant tests.** `scripts/client-build-environment.portal.spec.ts` asserts the fork's profile and asserts that `official` still answers with upstream's title, and `packages/client/portal-brand/tests/` covers the occupants. These exist to fail loudly when a sync clobbers the fork, which is the failure mode a merge-forward workflow actually produces.
- **Model-visible identity.** `packages/core/system-prompt/src/index.ts` ships `You are an AI agent powered by Portal Harness.`, so the model's self-description matches the interface. This is the one identity change with no seam: the shipped base composition is what the upstream snapshot corpus replays, so the line is pinned in 58 `*.expected.md` files (44 under `snapshots/session`, 10 under `snapshots/sdk`, 4 under `snapshots/web`) and 8 test files, and all of them are now fork divergences recorded in `FORK.md`. Recorded fixtures are unaffected because they template the prompt as `{{system}}`, so no re-recording was needed and the keyless replay validates the result.

The rule generalizes: fork behavior belongs in a fork-owned package, a fork-owned profile, or a fork-owned composition. Editing an upstream package is a last resort recorded in `FORK.md`, not a default.

## Alternatives considered

**Keep editing the upstream brand packages in place.** Rejected. It is the status quo that produced the ledger, and it makes the fork's intent invisible: the next sync cannot distinguish the fork's deliberate rebrand from an upstream edit it should simply take.

**Patch only the `OFFICIAL_CLIENT_BUILD_ENVIRONMENT` title.** Rejected as the whole answer. It is a one-constant change that appears harmless, but it makes the fork's title indistinguishable from upstream's official title, so an upstream release would ship the fork's product name and a sync could not tell which value was whose. A named profile keeps both facts explicit.

**Compose the model identity from a fork-only profile instead.** Rejected after measuring it, because the premise does not hold. `dsh web` *is* the shipped `web` template, and the snapshot harness accepts only the shipped `headless`, `sdk`, `acp`, and `web` profiles, so the corpus boots the same templates the fork runs. Putting the identity bundle into those templates changes the 58 expected files anyway; giving the fork a distinct `portal` template keeps the corpus pristine but changes the fork's daily command from `dsh web` to `dsh --profile portal` and requires pointing the desktop shell at it. There is no composition in which `dsh web` reports the fork identity and upstream's expected outputs stay byte-identical, so the fork took the direct edit and recorded the cost instead of hiding it behind a profile.

**Rename the npm scope to the fork's own.** Deferred, not rejected. Every package is still `@deepseek-ai/dsh-*`, and the prefix is load-bearing across roughly three hundred manifests, the Cordis resolver manifests, the release family checks, and the documentation. It is a coherent follow-up with its own blast radius, not part of establishing the seam.

**Change the in-app prose now.** Deferred. The welcome notice, the plugin install-safety warning, and the Office preview error still say DeepSeek Harness, and the `DSH` acronym appears in four more client dictionaries. `DSH` derives from DeepSeek Harness and has no successor derivable from Portal Harness, so a partial rename would ship "Portal Harness" next to "DSH plugin ecosystem" in one paragraph.

## Consequences

Fork brand work in the sidebar and hero is reachable without touching an upstream file, so a sync resolves those brand conflicts by taking upstream and keeping the fork package. The boot page is not a slot: `dsh-client-web` draws the Portal brand on it under every build profile, a divergence `FORK.md` records under Category D. The six upstream files the fork edits for identity are additive: a profile block, one allowlist entry, one path alias, one project reference, one client row, and one dependency line. The model-visible identity is the exception: it has no seam, so it diverges 70 upstream files outright, and a conflict there means upstream changed the prompt and the fork must re-apply its one line before regenerating.

Changing the identity also reaches sessions that already exist. The loop re-projects the rendered prompt on each step and appends a fresh `system/message` when it differs, so a session resumed after this change carries the old opener in its surface history and the new one after it. Each live session's prompt prefix therefore shifts once, and its cached prefix is invalidated at that point. No recorded log is rewritten.

`pnpm run duplication` remains red on this branch — **six** clones. Four are between `packages/experimental/tool-agent-room` and `packages/experimental/tool-agent-team`, one is between `agent-team`'s `RoomFollowQueue` and the private `ControlQueue` in `packages/api/session-controller`, and one is `packages/client/portal-brand/src/client/HarnessNameplate.tsx` extracting the same 11 lines of badge geometry that upstream's `BrandWordmark` still carries inline as `dsh-wordmark-badge-clip`.

That last clone is inherent to the seam rather than an oversight. Upstream's `BrandWordmark` renders the lowercase `deepseek` lettering and the badge as one svg, so no upstream export draws the badge alone; extracting it is what lets the fork place the Portal wordmark beside the HARNESS plate. The correct fix is an upstream contribution that exports the badge artwork from `dsh-client-ui-primitives` for both consumers, after which the fork deletes its copy. Until then the fork carries the duplication deliberately. The other five clones still need a home for shared experimental tool plumbing, which this note does not decide.
