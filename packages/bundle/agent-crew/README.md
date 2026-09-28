---
description: "Optional bundle that switches the subagent tool to worktree isolation and adds its accept/discard/list tools and the agent-crew skill from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-agent-crew

English | [中文](README.zh.md)

## Summary

This optional bundle switches `tool-subagent`'s `worktreeIsolation` on, and inserts the `tool-subagent-worktree` and `skill-agent-crew` rows the shipped compositions leave out. Shipped profiles leave it switched off.

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

Open Plugins in the Web sidebar (or a CLI profile's plugin manager) and enable Agent Crew. Once enabled, the `subagent` tool gains an `isolation: "worktree"` option: a caller that sets it gets a child working in its own git worktree, isolated from the caller's checkout and every other child. The session also gains `accept_worktree`, `discard_worktree`, and `list_worktrees` to land, discard, and list those worktrees, and the `agent-crew` skill becomes available in the session skill catalog, giving the model a named, practiced workflow for decomposing a goal across several worktree-isolated workers. Disabling the bundle restores the shipped `tool-subagent` configuration (no `worktreeIsolation`) and removes the two inserted rows; a worktree already created keeps existing until an operator accepts or discards it with `dsh agents accept`/`discard`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`cordis.patch.yml` replaces the `tool-subagent` row's whole config — restating `provider`, `toolName`, and `backgroundMode` from `dsh-base` alongside the new `worktreeIsolation: true`, because an id-targeted patch replaces the whole config rather than merging into it — and inserts the `tool-subagent-worktree` and `skill-agent-crew` rows. `package.json` depends on those two inserted rows' packages so they resolve from this bundle; the `subagent-worktree` service row itself lives in the shared `dsh-base` composition (mounted inert until a consumer like this bundle switches it on), so it is not a dependency of this bundle. `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts` names this package and `apps/cli` depends on it, so every installation ships it switched off and the plugin manager offers it in the Official group. No runtime invariant companion is published because this configuration-only package owns no mutable runtime state.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Restates `tool-subagent`'s config with `worktreeIsolation: true`; inserts `tool-subagent-worktree` and `skill-agent-crew` |
| [`package.json`](package.json) | The two inserted rows' packages as dependencies |
| [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) | Plugin-manager title and description |
| [`icon.svg`](icon.svg) | Plugin-manager icon |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-tool-subagent-worktree`](../../subagent/tool-subagent-worktree/README.md) — the `accept_worktree`, `discard_worktree`, and `list_worktrees` tools this bundle adds.
- [`@deepseek-ai/dsh-skill-agent-crew`](../../skill/skill-agent-crew/README.md) — the skill this bundle adds.
- `@deepseek-ai/dsh-subagent-worktree` (`packages/subagent/subagent-worktree/`) — the service behind the worktree lifecycle these tools expose.
- [`@deepseek-ai/dsh-tool-subagent`](../../subagent/tool-subagent/README.md) — the delegation tool this bundle switches to `worktreeIsolation`.

-----

<a id="model-experience"></a>
## Model Experience

### subagent isolation option and worktree tools

#### What the model sees

The `subagent` tool schema gains an `isolation` parameter (enum `["worktree"]`); the session gains `accept_worktree`, `discard_worktree`, and `list_worktrees`. Once enabled, `agent-crew` also appears in the session skill catalog.

#### Token effect

Selecting the bundle adds the `isolation` parameter to `subagent`'s schema, three new tool schemas, and one skill catalog entry to every request; a conversation that never delegates with `isolation: "worktree"` still pays this fixed schema cost.

#### KV Cache effect

These schema and catalog changes apply once, at the request prefix, when the bundle mounts; they do not change again afterward while the bundle stays enabled.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The three rows are not independently useful** — switching `tool-subagent-worktree` off while keeping `isolation: "worktree"` enabled on `subagent` leaves a caller able to create worktrees it can never land or discard through a model-facing tool (only through `dsh agents accept`/`discard`).
- **Disabling the bundle does not touch existing worktrees** — a worktree created while the bundle was enabled remains on disk with its branch until an operator runs `dsh agents accept` or `discard`.
- A profile patch or `--patch` overlay that targets `tool-subagent-worktree` or `skill-agent-crew` by id matches no row while this bundle is not selected: the loader warns `patch: entry <id> not found` for each such patch. Select this bundle instead of switching the rows on by id.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
