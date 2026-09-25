---
description: "Published experimental room profile layer over dsh-base that enables quorum-authorized deliberation on the Agent Teams roster."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-room-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-room-profile` is a published experimental profile layer that turns [Agent Teams](../agent-team/README.md) into a room over `@deepseek-ai/dsh-base`. Its patch mounts the Team domain with `roomEnabled`, keeps the Team delegation tools so the roster can create participants, and adds the [room tools](../tool-agent-room/README.md). Collective decisions then settle only by recorded quorum, and every rejected decision needs a revised statement or an escalation. The dsh installation ships it as an optional bundle that no shipped profile enables; switch it on from the Web sidebar's Plugins page in place of the Agent Teams bundle, or add it explicitly to an initialized profile.

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

### Install into a profile

Add the package to an initialized profile and run a task that asks for several participants:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-room-profile
```

### What you get

Four rows after `dsh-base`: the Team domain with `roomEnabled: true`, its delegation tools, the room tools, and the Team browser UI. Every value the room enforces is stated in the patch rather than defaulted: eight members at most, a twenty-entry transcript window per prompt, majority approval, and four revisions before a decision must escalate. The Plugins page reads the bundle's [icon](icon.svg) from its `package.json.icon` declaration, including while the bundle is disabled.

<a id="understand-the-implementation"></a>
## Understand the implementation

The layer keeps `@deepseek-ai/dsh-experimental-tool-agent-team` mounted, which is what makes a room usable: a participant is a rostered teammate, so `spawn_teammate` is how a room gains members. Unlike the Team profile it disables nothing, because the room tools carry distinct names and do not shadow the legacy continuable-child controls.

The patch sets `roomEnabled` explicitly. Without it the room tools mount and then refuse every call with `TEAM_ROOM_DISABLED`, so a deployment that wants only delegation should use `@deepseek-ai/dsh-experimental-agent-team-profile` instead.

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-experimental-agent-team`](../agent-team/README.md) owns the durable room state, the roster, and every operation the tools call.
- [`@deepseek-ai/dsh-experimental-tool-agent-room`](../tool-agent-room/README.md) owns the model-facing room tools.
- [Room types](../../../docs/subsystems/agent-team.md#shared-room) define every durable record.

<a id="model-experience"></a>
## Model Experience

### Room policy and tools

#### What the model sees

The layer adds one system-prompt section describing co-accountability and five tools: `room_view`, `room_prompt`, `room_propose`, `room_review`, and `room_escalate`. It also keeps the nine Team tools, so a participant can create teammates and use the task board.

#### Token effect

The policy section is fixed text in every participant request. Tool results are compact JSON bounded by the roster size, and `room_view` spends tokens proportional to the configured transcript window.

#### KV Cache effect

The policy section joins the stable prompt sections, so it extends the reusable prefix. Tool results append after that prefix like any other turn content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what this layer cannot do yet or what needs special operational care. They are current package constraints, not a comparison with other coordination mechanisms.

- **Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.
- **No shipped profile enables it** — the layer ships with the installation but stays off until a profile adds it, because a room changes what its participants' turns mean.
- **The panel renders only in a Web Client** — the UI row's browser entry mounts only there, so a headless profile runs the room without a browser surface; read it through the Session log instead.
- **A room inherits every Team constraint** — one process, one shared checkout, a flat immutable roster, and no cross-process exactly-once delivery.

No runtime invariant companion is published: the package carries only a static profile patch, and the Team domain owns the mutable relationships it activates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer notes</summary>

This layer and `@deepseek-ai/dsh-experimental-agent-team-profile` are mutually exclusive choices over the same base rows: the Team profile disables direct delegation and the legacy controls, while this one keeps delegation and adds the room. Keep the two patches symmetric when either changes, and keep every configured value stated here rather than relying on the package defaults.

</details>
