---
description: "The bundled agent-crew skill for users and maintainers enabling, using, or debugging worktree-isolated goal decomposition."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-agent-crew

English | [中文](README.zh.md)

## Summary

Agents can load the bundled `agent-crew` skill from this provider and follow its instructions for splitting a goal into independently verifiable parts, delegating each to a worker agent in its own git worktree, and landing only the parts an independent reviewer confirms. The provider has no configuration and registers at `BUNDLED_SKILL_RANK`, the same precedence as `dsh-badge` and `dsh-office`, so a project or user skill named `agent-crew` still wins.

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

Enable the plugin to make the `agent-crew` skill available in the session skill catalog; the model can then load it like any other skill (or a person can invoke it directly with `/agent-crew`) and follow its instructions for splitting and landing decomposed work.

### When to choose it

Choose this provider where worker-agent delegation with independent review is available and worth surfacing as a named workflow: alongside `@deepseek-ai/dsh-tool-subagent-worktree` and a `subagent` tool with `worktreeIsolation` enabled (the `@deepseek-ai/dsh-agent-crew` bundle mounts all three together). Skip it where those tools are not mounted — the skill's instructions name them directly, so loading it without them leaves a model unable to follow the workflow.

### Enable the plugin

The plugin has no configuration.

```yaml
- name: '@deepseek-ai/dsh-skill-agent-crew'
```

After enabling, `agent-crew` appears in the available skills of the session catalog.

### What the skill provides

- **Decomposition guidance.** How to split a goal into parts with disjoint scopes and an acceptance criterion each.
- **A worker-brief template.** Goal context, exact scope, constraints, acceptance checks, and what to report.
- **The exact tool call shapes.** `subagent({ description, prompt, isolation: "worktree", provider, model })`, and the `accept_worktree` / `discard_worktree` / `list_worktrees` / `send_message` loop for landing, fixing, or discarding each part.
- **A pointer to `dsh agents run`** for the same loop from a shell, for people and external agents.

### Observable success and failures

Enabling the plugin makes `agent-crew` appear in the catalog and loadable by name; disabling or omitting the row keeps it out of every catalog. Because the provider is immutable, discovery always succeeds with exactly one skill and never reports partial results.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the bundled provider is wired; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The provider is an immutable, synchronously registered skill source: it registers one fixed candidate at the bundled skill rank (600) under the provider name `agent-crew`, exposes its packaged `assets/` directory as the skill's directory resource base, and reads the skill body from the packaged `assets/agent-crew.md` file on every load. It copies the `skill-badge` shape exactly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry and the immutable provider: one candidate, resource base, body load |
| [`assets/agent-crew.md`](assets/agent-crew.md) | Packaged skill body: when to use it, decomposition, the worker brief, spawning, and landing each part |
| — | No runtime invariant companion is published; the package owns one immutable provider registration, while the skill registry owns registration uniqueness and lifecycle checks. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry this provider registers on to how the skill reaches the model and the tools its workflow calls.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry and provider contract this provider implements.
- [skill package](../skill/README.md) — the registry the provider registers on, and the shared rendering of loaded skills.
- [tool-skill package](../tool-skill/README.md) — how the `agent-crew` skill reaches the session catalog and the model.
- [`@deepseek-ai/dsh-tool-subagent-worktree`](../../subagent/tool-subagent-worktree/README.md) — the tools this skill's workflow calls to land, discard, and list worktrees.
- [`@deepseek-ai/dsh-agent-crew`](../../bundle/agent-crew/README.md) — the optional bundle that mounts this skill with worktree-isolated delegation.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders the provider's catalog entry and the selected skill body to the model.

#### KV Cache effect

Absent from shipped compositions by default, the plugin changes no request until the `agent-crew` bundle enables it. Once enabled, its catalog entry and any loaded body change the provider KV prefix at their insertion points.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the bundled provider does not do. They are current package constraints, not a task backlog.

- **One fixed skill, no runtime customization** — the provider contributes exactly the `agent-crew` skill; a deployment that needs another decomposition workflow authors its own skill instead.
- **Assumes the worktree tools are mounted** — the body names `subagent`'s `isolation: "worktree"`, `accept_worktree`, `discard_worktree`, and `list_worktrees` by name; loading this skill without those tools leaves a model with instructions it cannot follow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
