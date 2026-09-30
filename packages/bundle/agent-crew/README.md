---
description: "Optional bundle that offers worktree isolation on the subagent tool and adds its accept/discard/list tools and the agent-crew skill from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-agent-crew

English | [中文](README.zh.md)

## Summary

This optional bundle inserts the `tool-subagent-worktree` and `skill-agent-crew` rows the shipped compositions leave out. That mounted row holds an isolation offer, so every `subagent` delegation tool whose provider has the `cwd` capability offers `isolation: "worktree"`. Shipped profiles leave it switched off.

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

Open Plugins in the Web sidebar (or a CLI profile's plugin manager) and enable Agent Crew. Once enabled, every `subagent` delegation tool whose provider has the `cwd` capability, whether mounted at the Host level or inside an agent preset, gains an `isolation: "worktree"` option: a caller that sets it gets a child working in its own git worktree, isolated from the caller's checkout and every other child. A tool whose provider cannot start a child in a chosen directory, such as `subagent_fork`, does not offer it. The tool mounts its definition again when the offer appears or lapses, so the option follows the bundle toggle whatever the load order. The session also gains `accept_worktree`, `discard_worktree`, and `list_worktrees` to land, discard, and list those worktrees, and the `agent-crew` skill becomes available in the session skill catalog, giving the model a named, practiced workflow for decomposing a goal across several worktree-isolated workers. Disabling the bundle removes the two inserted rows, which withdraws the offer; a worktree already created keeps existing until an operator accepts or discards it with `dsh agents accept`/`discard`.

### Reviewer route

`accept_worktree` has the accepting agent's own model route review each worker's commit unless the `subagent-worktree` row sets a reviewer route, so a worker running on a cheaper route is reviewed on the lead's model. To pin the reviewer, set `reviewerProvider` and `reviewerModel` (and optionally `reviewerReasoningEffort`) on the `subagent-worktree` row in the profile patch; that patch replaces the row's whole config but leaves the offer alone, because the worktree-tools row holds it. Also set `requireDistinctReviewer: true` there to make the service refuse a review that would run on the worker's own route: a call whose worker would share the reviewer's route then fails before any worktree is created, so start the worker on another model or configure a reviewer route.

### Worker routes

This bundle does not change which routes a `subagent` call can choose: a worker runs on the lead's route unless the call names another. The `provider`, `model`, and `reasoning_effort` fields appear on the tool only where the row that mounts it sets `modelSelectionSettings` and the Host model-selection setting (the **Model selection** section of the **Subagent** page under **Plugins**) is enabled with at least one allowed route. A session samples that allow list when it starts, and a call naming a route outside it fails. [`@deepseek-ai/dsh-tool-subagent`](../../subagent/tool-subagent/README.md) documents the fields and the discovery tool. The shipped Web presets set the flag, so there a lead can start an isolated worker on an allowed cheaper route.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`cordis.patch.yml` inserts the `tool-subagent-worktree` and `skill-agent-crew` rows and configures no shared row. The offer lives on the worktree-tools row rather than on a `tool-subagent` row because agent presets mount their own `tool-subagent` rows, which an id-targeted patch cannot reach, while every delegation tool whose provider has the `cwd` capability reads `ctx.subagentWorktrees.offersIsolation` and mounts again when it changes. A profile patch that replaces the `subagent-worktree` row's config, for example to pin a reviewer route, cannot switch the offer off; a restated `tool-subagent` row would replace that row's whole config and drift from the base. `package.json` depends on those two inserted rows' packages so they resolve from this bundle; the `subagent-worktree` service row itself lives in the shared `dsh-base` composition (mounted inert until a consumer like this bundle's tools register an offer), so it is not a dependency of this bundle. `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts` names this package and `apps/cli` depends on it, so every installation ships it switched off and the plugin manager offers it in the Official group. No runtime invariant companion is published because this configuration-only package owns no mutable runtime state.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Inserts the `tool-subagent-worktree` and `skill-agent-crew` rows; configures no shared row |
| [`package.json`](package.json) | The two inserted rows' packages as dependencies |
| [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) | Plugin-manager title and description |
| [`icon.svg`](icon.svg) | Plugin-manager icon |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| [`tests/`](tests) | `composition.spec.ts` mounts the rows the patch files name; `delegation.spec.ts` runs one isolated delegation through them over a temporary git repository |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-tool-subagent-worktree`](../../subagent/tool-subagent-worktree/README.md) — the `accept_worktree`, `discard_worktree`, and `list_worktrees` tools this bundle adds.
- [`@deepseek-ai/dsh-skill-agent-crew`](../../skill/skill-agent-crew/README.md) — the skill this bundle adds.
- `@deepseek-ai/dsh-subagent-worktree` (`packages/subagent/subagent-worktree/`) — the service behind the worktree lifecycle these tools expose, which counts the isolation offers its consumers register.
- [`@deepseek-ai/dsh-tool-subagent`](../../subagent/tool-subagent/README.md) — the delegation tool that offers `isolation` while the service holds an offer.

-----

<a id="model-experience"></a>
## Model Experience

### subagent isolation option and worktree tools

#### What the model sees

Every `subagent` delegation tool schema whose provider has the `cwd` capability gains an `isolation` parameter (enum `["worktree"]`); the session gains `accept_worktree`, `discard_worktree`, and `list_worktrees`. Once enabled, `agent-crew` also appears in the session skill catalog.

#### Token effect

Selecting the bundle adds the `isolation` parameter to `subagent`'s schema, three new tool schemas, and one skill catalog entry to every request; a conversation that never delegates with `isolation: "worktree"` still pays this fixed schema cost.

#### KV Cache effect

These schema and catalog changes apply once, at the request prefix, when the bundle mounts; they do not change again afterward while the bundle stays enabled.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The three rows are not independently useful** — a `tool-subagent` row that sets `worktreeIsolation: true` while no `tool-subagent-worktree` row is mounted leaves a caller able to create worktrees it can never land or discard through a model-facing tool (only through `dsh agents accept`/`discard`).
- **Disabling the bundle does not touch existing worktrees** — a worktree created while the bundle was enabled remains on disk with its branch until an operator runs `dsh agents accept` or `discard`.
- A profile patch or `--patch` overlay that targets `tool-subagent-worktree` or `skill-agent-crew` by id matches no row while this bundle is not selected: the loader warns `patch: entry <id> not found` for each such patch. Select this bundle instead of switching the rows on by id.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
