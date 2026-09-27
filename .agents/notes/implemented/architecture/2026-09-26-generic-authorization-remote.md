# Agent Note: Generic authorization Remote

Status: implemented

English | [中文](2026-09-26-generic-authorization-remote.zh.md)

## Problem

The [credential-records decision](2026-08-13-credential-records-and-authorization-flows.md) put provider sign-in behind the `ctx.authorization` seam and deferred the wire contract and the Models-page control it needed. A flow took an interaction and a signal from whoever ran it in process, and the credential store's Remote describes records rather than sign-ins. Every page that renders a Sign in control reaches the Host over a Remote, so the Models settings page could list a route such as `openai-codex` — whose ChatGPT Plus or Pro subscription sign-in is the only credential it accepts — but never run its flow, show the page or device code it produced, answer the question it asked, cancel it, or sign out.

## Decision

`@deepseek-ai/dsh-api-authorization-controller` mounts a Host Remote at `ctx.remote.authorization` with `getState`, `start`, `answer`, `decline`, `cancel`, `signOut`, and `watch`, forwarding each operation to `ctx.authorization` and `ctx.credentials`. The namespace names no provider and no protocol: whichever adapter owns a credential format registers the flow, the [pi-ai adapter](../../../../packages/llm/llm-pi-ai/README.md) registers one per installed catalog provider that ships a login, and the same seven commands run an OAuth subscription login, an interactive api-key prompt, or whatever a later adapter registers.

`getState` returns every registered flow joined with `configured` and `writable` from `ctx.credentials.describeRecord()`, plus the controller's own attempt, so a surface enables Sign in, Sign out, and the signed-in label from one read. No method returns credential material: the view is built from `list()`, `describeRecord()`, and the flow's own notices and prompts, and the only value crossing the wire the other way is a typed answer.

## One attempt with a whole-view stream

The controller owns exactly one attempt at a time. `start` claims the slot for a credential key, answers the attempt already running for that same key instead of starting a second, and refuses a different key with `authorization/already-in-flight`. Every mutating method returns the complete view as it stands after the command, and `watch` emits one complete view per change — coalescing to the latest view per subscriber rather than queueing deltas — so a surface that reconnected renders the current state instead of replaying what it missed. A record change for a flow's key wakes the same watchers, because a record another tool wrote changes what a row should read.

Per-key concurrent attempts are deferred until a second surface needs them: the seam itself admits one attempt per key, and two attempts for one key would be two humans answering the questions of one flow. The single slot is also what makes the attempt view unambiguous — one `attempt` field a surface renders, never a list it has to pick from.

## The directory advertises the sign-ins the seam registers

`LlmConfigurableProvider.authorization?: { key, required }` answers from `authorizationFor()`, the same predicate `registerPiAiFlows()` uses to decide which flows exist, so a surface can never offer a sign-in the seam does not run and no flow exists for a key no directory entry names. `required` is true exactly when the provider serves no api-key auth at all, which the installed catalog makes true for `openai-codex` alone; a stored profile narrows what a route serves without changing that fact, because the sign-in is a property of the provider.

Only a `required` sign-in affects whether a keyless row counts as usable. Every installed provider except `openai-codex` ships an api-key method, and a route that authenticates from ambient environment variables or provider-native discovery keeps it, so that route reports `required: false` and stays usable with no stored sign-in; the page never blocks a route whose credential the process supplies.

## Prompts, withdrawal, and the end of an attempt

Each parked question carries a controller-minted branded `AuthorizationPromptId`, because pi-ai's own prompt object is not a wire value, and `answer` and `decline` name that id: a stale id, or a `select` value outside the options that prompt offered, rejects with `authorization/stale-prompt` rather than landing on the next question.

A question the flow withdraws through its own signal — the losing half of a race, such as a typed code against a browser callback — leaves the view and keeps the attempt running, because the flow is still working; only the whole request settles `cancelled`.

`cancel` aborts the attempt's controller, tells the seam, and refuses the parked question with a plain `Error`, never an `AuthorizationDeclinedError`, because nobody declined it. A question that arrives after the attempt was cancelled, replaced, or disposed is refused the same way, and every later callback from a flow the controller no longer owns is turned away, so a flow never outlives its attempt. `decline` and `cancel` answer as soon as the refusal or withdrawal is delivered, so a flow that keeps asking cannot hold a Remote call open; the terminal phase arrives through `watch`. A failed attempt publishes a short code — the namespace's own code for a seam failure it declares, otherwise the failure's own code, and `unknown` when it carries none — never provider text or a secret.

## Alternatives considered

**A provider-specific command, such as a Codex login method on the models surface.** The authorization seam is already provider-neutral and the pi-ai adapter registers a flow per provider, so a per-provider command would restate the flow registry and be rewritten for the next sign-in.

**Per-key concurrent attempts on the controller now.** Deferred rather than rejected: one attempt per key is what the seam enforces, no second surface asks for more, and a queue would still need a policy for which attempt a question belongs to.

**Returning the credential record, or a prompt's secret value, in `getState`.** A surface needs presence and writability, not the secret: the view is built from `list()` and `describeRecord()`, and a secret question's answer travels one way, into the flow.

**Streaming deltas instead of complete views.** A surface that missed changes would have to replay them and reconstruct the state, where complete views make the latest state the only thing to render.

**A second interaction registry beside the request that started the flow.** The credential-records decision already rejected reusing `ctx.userQuestions`, and the same lifecycle argument holds for a registry of its own: a question must reach the page that started the flow and be withdrawn per prompt by the flow that wins the race, so the interaction travels with the attempt.

## Consequences

- Every sign-in surface reaches the flows through one namespace, and the deferred Models-page control and wire contract are what this decision delivered; a composition that mounts no authorization seam mounts no controller, so headless and ACP hosts are unchanged.
- The Models page enables **Sign in** and **Sign out** from `configured` and `writable`, labels a required sign-in **Signed in** or **Not signed in**, and runs the flow's own link, device code, and questions in a dialog; a keyless `openai-codex` row is usable once the sign-in has committed.
- An attempt is not durable and is not shared: a page reload abandons the login, a question missed while disconnected is never replayed, and a `start` on a key another surface is authorizing outside this controller settles the attempt `failed` with `authorization/already-in-flight` while the flow list reports `inFlight`.
- `decline` and `cancel` return before the flow unwinds, so an attempt can briefly report `running` with no parked question, and a surface that starts the same key in that window reads the withdrawing attempt instead of a new one.
- `signOut` deletes the record a registered flow claims, cancelling any attempt for that key first, and refuses a key no flow claims or a record the active provider cannot write.
- `packages/api/authorization-controller/tests/controller.spec.ts` covers the lifecycle end to end: a select question through the notice to a committed record, a withdrawn question leaving the attempt running, decline and cancel refusing the parked question, a replaced attempt turning later callbacks away, the coalescing stream, the single attempt slot, `signOut`, and disposal.
