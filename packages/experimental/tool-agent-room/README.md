---
description: "Five tools that let a room participant call on peers, propose decisions, and record a quorum verdict, for compositions mounting the experimental room runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-room

English | [中文](README.zh.md)

## Summary

`dsh-experimental-tool-agent-room` gives every participant in an experimental room the tools to conduct a collective decision: read the transcript and the current votes, give one participant the floor with the context it has not seen, put a statement to the room, record an approve, reject, or abstain standing with a reason, and hand an unresolved decision to the human. It ships the policy that makes quorum meaningful, so a participant approves only what it would defend and states the specific problem when it rejects. It requires `@deepseek-ai/dsh-experimental-agent-team` with `roomEnabled`, and it is published under its experimental name without a stability promise.

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

Mount this package beside `@deepseek-ai/dsh-experimental-agent-team` with `roomEnabled: true`. Add `@deepseek-ai/dsh-experimental-tool-agent-team` when participants should also create teammates; the room tools address participants the roster already holds, so they do not create any.

```yaml
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
  config:
    roomEnabled: true

- id: tool-agent-room
  name: '@deepseek-ai/dsh-experimental-tool-agent-room'
```

### When to choose it

Choose it when one question should be reasoned about by several models that must hold each other accountable, and a decision must not be any single participant's to make. Choose `@deepseek-ai/dsh-experimental-tool-agent-team` alone when the work is delegation and the Lead's judgement is the intended authority.

<a id="understand-the-implementation"></a>
## Understand the implementation

`apply` installs into every live or subsequently published room participant's Agent scope: one system-prompt section carrying the co-accountability policy, and five tools. Installation follows `ctx.agentTeams.tryMembership`, the same roster rule the room uses, so a member receives the tools from the moment provisioning records it.

Each tool wraps one `ctx.agentTeams` operation and renders its result as compact JSON against a declared schema. The service, not the tool, decides every outcome: `room_review` records a standing and returns whatever the quorum arithmetic then produces, `room_propose` cannot accept anything, and no tool can force a verdict. A refusal reaches the model as a tool error result naming the reason, so a participant can correct a stale revision or an unknown decision id and retry.

`room_view` returns at most `maxTranscriptEntries` trailing transcript entries and reports whether it truncated. The tool clamps a model-supplied `entries` to that configured ceiling, so the deployment bounds the window and the model cannot widen it.

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-experimental-agent-team`](../agent-team/README.md) owns the roster, the durable mailbox, the task board, and the room state these tools read and mutate.
- [Room types](../../../docs/subsystems/agent-team.md#shared-room) define every durable record and view.

<a id="model-experience"></a>
## Model Experience

### Room tools

#### What the model sees

Five tools appear in every participant's schema: `room_view`, `room_prompt`, `room_propose`, `room_review`, and `room_escalate`. Each returns compact JSON against a declared schema: a decision view carries its id, revision, proposer, statement, phase, required approvals, the three vote lists, every recorded standing with its reason, and, while the decision is still open, the names whose standing is missing. One system-prompt section states when a participant may speak and the quorum rule; each tool's description and parameters carry its own usage rules, and refusals such as self-review, a settled decision, or the revision limit arrive in the call result.

#### Token effect

The policy section is fixed text present in every participant's request. Each tool result is a compact JSON record; a decision view is bounded by the roster size because its vote lists name participants. `room_view` spends tokens proportional to the transcript window the deployment configures.

#### KV Cache effect

The policy section sits with the other stable prompt sections, so it extends the reusable prefix rather than invalidating it. Tool results append after that prefix like any other turn content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what a room participant cannot do yet or what needs special operational care. They are current package constraints, not a comparison with other coordination mechanisms.

- **Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.
- **The room must be enabled by the composition** — without `roomEnabled` on `@deepseek-ai/dsh-experimental-agent-team`, every tool fails with `TEAM_ROOM_DISABLED` rather than degrading.
- **A participant speaks only when given the floor** — no tool lets a participant claim a turn or answer a peer unprompted, so a room whose participants stop granting the floor stalls.
- **Scoped installation can reach a provider-owned subagent** — installation follows membership at creation time, before a provider-owned child's descriptor is recorded; the authority check inside each operation is what refuses it.
- **A silent reviewer only delays a decision** — every eligible reviewer must vote before a decision settles, and the room reminds a reviewer that stops working before it escalates the decision to the human with the silent reviewers named.
- **The room panel never records a standing** — `@deepseek-ai/dsh-experimental-client-ui-agent-team` renders the transcript and decisions when the composition mounts it, and it can give the floor, open a decision, and escalate one, but reviews come only from participants through `room_review`.

No runtime invariant companion is published: the package owns no runtime state of its own. Every schema it declares delegates to `ctx.agentTeams`, and `@deepseek-ai/dsh-experimental-agent-team` owns the invariant that guards those records.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer notes</summary>

The tool set mirrors `@deepseek-ai/dsh-experimental-tool-agent-team`: the same scoped-installation lifecycle, the same declared-schema result contract, and the same refusal path through tool error results. Keep the two packages symmetric when either changes; the shared delivery and roster machinery lives in `@deepseek-ai/dsh-experimental-agent-team`.

</details>
