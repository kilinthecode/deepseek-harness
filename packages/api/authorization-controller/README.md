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

The authorization namespace exposes getState, start, answer, decline, cancel, signOut, and watch over `ctx.authorization` and `ctx.credentials`. The controller owns exactly one running attempt at a time: start claims the slot for a credential key and refuses a different key while an attempt is active, answer and decline address the attempt's current prompt by id and refuse a stale one, decline settles the attempt cancelled the same way a withdrawn signal does, and cancel withdraws whatever attempt is currently active. signOut deletes the stored record a registered flow claims for a key and refuses when the active provider cannot write it. watch emits an initial complete view and subsequent complete views; disconnecting stops observation, not the attempt.

<a id="understand-the-implementation"></a>
## Understand the implementation

The controller forwards operations to the authorization and credentials seams and maintains no independent state; no invariant companion is published.

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

- This commit scaffolds the Remote surface: every method signature and failure code is final, but every method body throws `not implemented`. A follow-up change implements the delegation to `ctx.authorization` and `ctx.credentials` and adds its test coverage.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
