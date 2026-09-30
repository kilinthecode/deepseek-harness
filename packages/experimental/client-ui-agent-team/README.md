---
description: "Use and debug the experimental Web Agent Teams roster, shared task board, room, and teammate navigation panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds an Agent Teams action to the Web conversation header, where a user can inspect the roster and shared task board, follow and steer the Team's room when one is enabled, and open teammate conversations. It reads the Lead Session's `agentTeam` projection from the Session store, which Host projection frames keep current, reads the room through the generated `agentTeams/room*` Remote methods, and keeps child-history navigation on the stable addressed-subagent path. Choose it through an experimental Agent Teams or room bundle. The panel does not extend the stable API Proxy, store Team state, or register model-facing input.

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

Enable this package through [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.md), which supplies the Team service, tools, and Web UI together. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect and navigate the roster

The panel shows the Lead Session's roster and task board from the shared Session store. Task and roster updates appear while the panel stays open. Opening the panel performs no projection requests. The panel shows a loading notice while the conversation or Session list is loading, and an unavailable notice when no Team value is present afterward.

Roster rows show durable names and phases. Provisioning and running members use the shared ongoing loader, inactive members use a person icon, and failed members use error. Live Session status supplies running activity; the shared `modelSelection` projection supplies a model when available. The current conversation carries a Current chat tag and cannot be selected. Selecting the Lead from a teammate conversation opens the Lead Session directly. Selecting an active teammate opens its ordinary continuable child address. The Host validates the parent, child, and mode when history opens; later human prompts use the same addressed-subagent conversation.

### Read the room

Opening the panel reads the room once through `agentTeams/room`. When the composition has a room, the panel adds controls that grant one participant the floor, open a decision, or hand an unresolved decision to the human, and it shows the shared transcript and every collective decision: its phase, proposer, the exact statement, and the participants recorded on each side of the vote. The transcript names who said what; the decision board names who approved, rejected, abstained, and — while the decision is still open — who has yet to record a standing, and the room section names every live participant that produced no work within the room's window. A settled decision shows no awaiting participants, because nobody can change an outcome quorum already reached, and each recorded standing appears with the reason its reviewer gave. While the panel is open it follows the room: text a participant is streaming appears as it arrives, and that participant's committed transcript entry replaces its live text with the durable record. A failed room read or action appears inside the room section beside the healthy roster and tasks.

### Inspect the task board

Ready pending tasks use idle, blocked pending tasks use warning, in-progress and verifying tasks use ongoing, and completed tasks use done.

The read-only task board shows task identity, owner, blockers, readiness, advisory write scopes, and overlap warnings. A task awaiting its peer verdict reads Awaiting verification, and a task with a recorded verdict shows the verifier, the verdict, and the reason. Descriptions longer than two lines have an expand toggle. Section headings show member and task counts; an empty board shows a short description, and a lone member with no tasks uses a single-column panel. Team agents create, submit, and verify tasks through their tools; the panel provides no task mutation controls. When the projection reports a rejected persisted Team record, the panel shows that failure above the last valid roster and tasks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export mounts the generated `agentTeams` room Remote contribution, then registers its locale dictionaries and one conversation-header slot through Cordis effects. Disposing the plugin fiber removes both registrations and unmounts the Remote namespace; a registration failure unmounts it before the error propagates.

The panel renders outside the conversation container and stays within the viewport. Member cards use the shared elevation stroke for their outlines in resting, selected, and hover states. Hovering the trigger opens the panel after 150ms; leaving both trigger and panel closes it after a 120ms grace period. Clicking the trigger pins the panel and moves focus into it. Outside clicks and Escape dismiss the panel; Escape returns focus to the trigger only when focus was inside the panel. In a narrow header, the trigger becomes an icon and opens only on click. The component derives every roster and task row from the `useSessions`, `useSessionStatus`, and `useSession` seats: the Lead identity comes from the current Session's subagent address, the Team view from `projectionsBySession[lead].values.agentTeam`, member activity from Session status with the list summary as fallback, and the model from `projectionsBySession[member].values.modelSelection.next`. Each roster row selects its own running state. One injected callback opens a roster Session using the current and target Session ids; the room callbacks resolve the current conversation to its Lead before each `agentTeams/room*` call. The room section follows `agentTeams/roomStream` only while it is mounted and aborts the stream when the panel closes. Switching conversations closes the panel and clears a navigation failure.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Room Remote mount, locale, navigation, and slot registrations |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Projection-derived roster and task board, Remote-backed room section, and panel interaction state |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams bundle](../agent-team-profile/README.md) — the published opt-in bundle that mounts this Client plugin.
- [Agent Teams service](../agent-team/README.md) — authoritative roster, task, room, and projection behavior.
- [Conversation UI](../../client/ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser panel registers no model-facing input. Its room controls call the Host room operations, which own every resulting participant prompt and record it in `room/*` and mailbox events; the panel never records a standing.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No mailbox timeline** — the projection view carries roster and tasks only; peer messages are not shown.
- **Late plugin activation** — after enabling Agent Teams in an already-open conversation, reload the page to receive its Team projection.
- **Model availability** — a model appears only when the shared store has a durable selection or request for that member. Missing cold-cache values stay absent until normal Session loading or a live update supplies them.
- **Live follow needs an open panel** — the panel subscribes to the room only while it is open and drops streaming text when a committed change replaces it; a closed panel reads the room again on the next open.
- **Abandoned live text stays** — the follow carries text chunks but not the end of a participant's stream, so text from an aborted or failed turn stays live, and that participant's next streamed text extends it, until its next committed utterance.
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

**Runtime invariant:** No companion is published. The Host projection and room service are authoritative, and the package owns only one disposable slot registration and one Remote mount.
