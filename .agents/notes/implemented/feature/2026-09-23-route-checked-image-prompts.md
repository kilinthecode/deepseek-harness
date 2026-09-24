# Agent Note: SDK and headless image prompts are checked against the route

Status: implemented

English | [中文](2026-09-23-route-checked-image-prompts.zh.md)

## Problem

Image input already worked end to end on image-capable routes, but three non-browser surfaces hid whether it worked:

- The JSON-RPC SDK server admitted image prompts on every route. On a route that declares text-only input, `LlmRuntime` replaced each image with placeholder text, so the caller received a text-only answer and no error.
- The headless profile offered no way to attach an image.
- ACP, the TypeScript and Python SDKs, and `dsh-subagent-dsh-sdk` defaulted to `deepseek-v4-flash`, which passes through as a text-only route since the shipped DeepSeek catalog dropped it. An image sent with default options was refused by ACP or silently degraded by the SDK.

## Decision

### One mapping, caller-owned policy

`imageInputSupport(info)` in `@deepseek-ai/dsh-llm` maps a resolved model's `inputModalities` to `'supported'`, `'unsupported'`, or `'undeclared'`. Callers resolve the model info themselves and choose their own policy for `'undeclared'`.

### Prompt-entry gates are permissive

The SDK server's `session/prompt` and the headless `--image` option refuse only `'unsupported'`. The SDK check runs before a Session is created or an attachment is stored; the headless check runs before any file is read and before the Agent is created. `'unsupported'` is the condition under which `LlmRuntime` replaces each image with placeholder text and the condition the Web prompt admission in `packages/api/session-controller/src/commands.ts` refuses, so these gates refuse every prompt the runtime would silently degrade. An `'undeclared'` route is admitted and its images reach the adapter unchanged: an adapter that can send them does, and one that cannot fails the turn with `UNSUPPORTED_CONTENT` after the Session and attachments exist. The gates in `read_image`, the MCP bridge, and ACP refuse `'undeclared'` as well, so on an undeclared route a prompt image is admitted while `read_image` refuses.

### Headless attaches images by flag

`dsh --profile headless --image <path>` is repeatable. The runner resolves each path through the mounted filesystem provider and takes the media type the way `read_image` does: a supported extension selects it, an extension-less path is identified from its file signature, and any other extension fails before any file is read, whatever the file holds. It stores the batch with `attachments.saveImages` and sends one user message with the task text followed by the images in invocation order. Storing runs before the Agent is created or resumed, so every image refusal, including the attachment store's batch and decode refusals, creates no Session and stores no image; a failure of the Agent step itself, such as an unusable `--session-id`, leaves stored images that no Session references. Storing after the Agent step would instead move those refusals after Session creation.

### The shipped defaults accept images

ACP's shipped row, the TypeScript and Python SDK clients, and `dsh-subagent-dsh-sdk` default to `deepseek-flash`, the shipped catalog entry that declares image input, so an image sent with default options reaches the model and ACP advertises image prompts. The auxiliary `dsh-web-search-deepseek` provider keeps its own `deepseek-v4-flash` default: it sends a text-only search request straight to DeepSeek's Anthropic-compatible endpoint without resolving the model through `ctx.llm`, so route image capability does not apply to it.

## Alternatives considered

**Strict prompt-entry gates.** Refusing `'undeclared'` in the SDK server and headless would refuse routes that the runtime serves with images unchanged, and would disagree with Web prompt admission.

**Keeping `deepseek-v4-flash` as the default and relying on the refusal.** The gates would make the default fail loudly, but every default-route image prompt would still fail; the maintainer chose image-capable defaults instead.

**Migrating the five existing gates onto `imageInputSupport`.** The migration is mechanical but touches five packages with two semantics; it is left as a follow-up that the shared mapping enables.

**`@path` references inside the headless task.** The task positional is free text joined by spaces, so prefix parsing is ambiguous; a repeatable `--image` flag is explicit.

## Consequences

SDK automation that sent images on a text-only route now receives a JSON-RPC error instead of a placeholder answer. Headless users can attach images, and a text-only route fails the invocation before any model request. Default-route SDK and ACP sessions run on `deepseek-flash` instead of the `deepseek-v4-flash` pass-through. Five route image gates remain with two semantics until the follow-up migration.

## Testing

Unit specs cover the mapping (`packages/llm/llm/tests/content.spec.ts`), the SDK gate before Session creation (`packages/sdk/server/tests/server.spec.ts`), the headless option and runner (`packages/bundle/headless/tests/startup.spec.ts`, `headless.spec.ts`), and the shipped ACP row (`packages/bundle/acp-app/tests/acp-app.spec.ts`). The keyless `snapshots/session/headless-image-prompt` scenario replays a headless run with one `--image` attachment.
