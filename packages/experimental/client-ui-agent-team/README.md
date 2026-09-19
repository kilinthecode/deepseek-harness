---
description: "Use and debug the experimental Web Agent Teams roster, shared task board, and teammate navigation panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds an Agent Teams action to the Web conversation header, where a user can inspect the current roster, manage the shared task board, and navigate into a teammate's conversation. It reads authoritative Team state through the generated `ctx.remote.agentTeams` contribution and keeps ordinary child-history navigation on the stable addressed-subagent path. Choose it through the published experimental Agent Teams Web profile. The browser projection does not extend the stable API Proxy, store Team state, or register model-facing input.

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

Install the package through [`@deepseek-ai/dsh-experimental-agent-team-web-profile`](../agent-team-web-profile/README.md) after the stable Web bundle and the Host-side Agent Teams profile. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect and navigate the roster

Opening the panel calls `agentTeams/view`. Roster rows show durable names, runtime status, model, and diagnostics. Selecting a healthy teammate refreshes the existing direct-child catalog and opens the ordinary `{ parentSessionId, childSessionId, mode: 'continuable' }` address. History and later human prompts continue through the stable addressed-subagent conversation path; this package adds no Team-specific address field.

### Read the room

When the composition has a room, the panel adds controls that grant one participant the floor, open a decision, or hand an unresolved decision to the human, and it shows the shared transcript and every collective decision: its phase, proposer, the exact statement, and the participants recorded on each side of the vote. The transcript names who said what; the decision board names who approved, rejected, abstained, and — while the decision is still open — who has yet to record a standing, and the room header names every live participant that produced no work within the room's window. A settled decision shows no awaiting participants, because nobody can change an outcome quorum already reached, and each recorded standing appears with the reason its reviewer gave. While the panel is open it follows the room: text a participant is streaming appears as it arrives, and every committed transcript entry or decision change replaces that live text with the durable record.

### Manage the task board

The task board shows task identity, owner, blockers, readiness, advisory write scopes, and overlap warnings. A user can create, edit, assign or unassign, submit, reopen, and delete tasks through `agentTeams/createTask` and `agentTeams/updateTask`, and verify a submitted task with a reason: the task card offers Verify while work awaits its peer verdict, and a verdict without a reason is refused before it leaves the browser. Every update sends the displayed revision, and create or update rejections remain explicit business results.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export mounts the generated `ctx.remote.agentTeams` contribution from [`@deepseek-ai/dsh-experimental-agent-team/remote`](../agent-team/README.md), then registers its locale dictionaries and one conversation-header slot through Cordis effects. Disposing the plugin fiber removes both registrations.

Starting a create or update invalidates older refreshes. Success reloads the complete Team view so every task's derived fields stay current. A `team-task-conflict` result displays a stale-state notice only after that reload succeeds; a reload failure remains visible instead. Editing task text or scopes and changing dependencies use two sequential compare-and-set mutations because the Team service exposes them as separate actions.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Generated Remote, locale, navigation, and slot registrations |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Roster and task-board interaction state |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams Web profile](../agent-team-web-profile/README.md) — the published opt-in bundle that mounts this Client plugin.
- [Agent Teams service](../agent-team/README.md) — authoritative roster, task, and Remote behavior.
- [Conversation UI](../../client/ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection, room reader, and task control surface registers no model-facing input. The room panel renders the durable `room/*` records the model-facing room tools produced; it neither writes those records nor grants any participant authority.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Live follow needs an open panel** — the panel subscribes to the room only while it is open and drops streaming text when a committed change replaces it; a closed panel refreshes from the durable log on the next open.
- **A composition without a room shows no room section** — the panel omits it rather than rendering an empty one, because an absent room and an idle room are different states.
- **The room panel writes only three things** — it can grant one participant the floor with an instruction, open a decision with a statement, and hand an unresolved decision to the human with a reason, each through its own `agentTeams/room*` Remote call. It never records a standing: a review is a participant's own verdict, recorded by that participant or its model.
- **The room reader has one assembled-browser case** — `apps/web/tests/agent-room-panel.e2e.ts` pins the rendered transcript and decision board and then opens a decision after the panel mounted, requiring it to appear through the live follow without a refresh; the roster and task-board paths keep their own cases.
- **Ordinary child continuation** — a human message sent after navigation uses the stable addressed-subagent prompt path, not the Team peer mailbox.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. RPC is authoritative and the package owns only one disposable slot registration.
