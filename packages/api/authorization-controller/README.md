---
description: "Authorization screens use authenticated Remote commands and a snapshot stream over the credential sign-in seam. The controller exposes flow and attempt state without returning prompts' secret values."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-authorization-controller

English | [中文](README.zh.md)

## Summary

Authorization screens use authenticated Remote commands and a snapshot stream over the credential sign-in seam. The controller exposes flow and attempt state without returning prompts' secret values.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The authorization namespace exposes getState, start, answer, decline, cancel, signOut, and watch over `ctx.authorization` and `ctx.credentials`.

getState returns every registered flow and the controller's own attempt. A flow carries its key, label, methods, and `inFlight` — true for an attempt another surface started too — joined with `configured` and `writable` from `ctx.credentials.describeRecord`, so a surface can enable Sign in or Sign out without reading a credential. An attempt carries its key, the method it runs, its phase, the latest notice, the question currently blocking it, and a short failure code once it failed. No method returns credential payloads: the view is built from `list()`, `describeRecord()`, and the flow's own notices and prompts, while a typed answer travels one way, from the surface into the flow.

The controller owns exactly one running attempt at a time: start claims the slot for a credential key and refuses a different key while an attempt is active, answer and decline address the attempt's current prompt by id, decline settles the attempt cancelled the same way a withdrawn signal does, and cancel withdraws whatever attempt is currently active. decline and cancel answer as soon as the refusal or withdrawal is delivered, without waiting for the flow to settle, so a flow that keeps running cannot hold a Remote call open; the attempt's terminal phase arrives through watch. signOut deletes the stored record a registered flow claims for a key, cancelling any attempt for that key first, and refuses a key no flow claims or a record the active provider cannot write. watch emits an initial complete view and subsequent complete views, and yields that first view even to a stream whose signal already aborted; disconnecting stops observation, not the attempt.

An attempt moves through `starting`, `running`, and `prompting`, and ends in exactly one terminal phase: `authorized` after the flow committed its record, `cancelled` when a human declined or a caller withdrew, or `failed`. Only the attempt's current prompt can be answered: a stale prompt id, and a `select` value outside the options that prompt offered, reject with `authorization/stale-prompt`. A question the flow withdraws through its own signal leaves the attempt running; only the whole request settles `cancelled`.

An attempt that is cancelled, replaced, or disposed refuses the question it is parked on with a plain error rather than a decline — only a human declines — and turns away every later callback from a flow it no longer owns, so no surface is left holding a question nobody can answer.

Failures use the namespace's codes: `authorization/no-flow`, `authorization/unknown-method`, `authorization/already-in-flight`, `authorization/not-committed`, `authorization/stale-prompt`, and `authorization/read-only`. A key outside the `<scope>/<id>` credential-key grammar rejects as the carrier's `gateway/bad-request`, because no flow could ever claim it. A failed attempt publishes a short code naming the failure — the namespace's own code for a seam failure it declares, otherwise the failure's own code — never provider text or a secret.

<a id="understand-the-implementation"></a>
## Understand the implementation

The controller forwards operations to the authorization and credentials seams and owns one attempt, its parked prompt, and the watchers it feeds; no invariant companion is published.

<a id="further-exploration"></a>
## Further Exploration

The [credentials subsystem](../../../docs/subsystems/credentials.md) owns the authorization and credential-storage seams this controller wraps; the [architecture](../../../docs/architecture.md) explains application composition.

<a id="model-experience"></a>
## Model Experience

None, as authorization credentials affect HTTP and provider authentication and never enter model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- An attempt does not survive a Host restart, and no surface can join an attempt another surface started: the authorization seam admits one attempt per key, so start on a key that is already being authorized settles this controller's attempt `failed` with `authorization/already-in-flight` while the flow list reports `inFlight`.
- A reconnecting surface recovers state through watch, but a question it missed is never replayed: the prompt it sees is the one the attempt is currently parked on.
- decline and cancel answer before the flow settles, so an attempt can briefly report `running` with no parked question: a surface that starts the same key again in that window reads the withdrawing attempt instead of a new one, and reaches the terminal phase through watch.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
