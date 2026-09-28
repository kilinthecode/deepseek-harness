---
description: "Buffered hand-off from synchronous producers to one async-iterator consumer: push entries, take them in order, and park in wait() until an entry arrives or the queue ends."
kind: "package-library"
---

# @deepseek-ai/dsh-async-queue

English | [中文](README.zh.md)

## Summary

`dsh-async-queue` hands values from synchronous producers to one asynchronous consumer without polling. A producer calls `push()`, and the consumer calls `take()` for buffered entries or `wait()` to park until an entry arrives or `end()` finishes the queue. The package owns entry order, waking the parked consumer, and refusing pushes after the end; each consumer still owns its iteration loop, its cancellation, and the meaning of a delivered entry. `dsh-api-session-controller` and `dsh-experimental-agent-team` use it for their live streams.

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

### When to use it

Use `AsyncQueue<T>` when synchronous code produces entries for one consumer that awaits them, and polling or an event emitter would waste work or lose the ordering. Consumers that already receive entries through a Cordis service or a `SessionEventMap` subscription keep that path; this queue serves a direct hand-off inside one process.

### Entry point

Import the queue, push entries from the producer, and alternate `take()` with `wait()` in the consumer:

```ts
import { AsyncQueue } from '@deepseek-ai/dsh-async-queue'

const queue = new AsyncQueue<string>()
const consume = (async () => {
  for (;;) {
    const entry = queue.take()
    if (entry !== undefined) {
      console.log(entry)
      continue
    }
    if (queue.finished) return
    await queue.wait()
  }
})()

queue.push('first')
queue.end()
await consume
```

`push()` after `end()` is refused, and `take()` keeps returning the entries buffered before the end, so the loop above drains them before it observes `finished`. The methods neither bound the buffer nor translate consumer failures. See [`src/index.ts`](src/index.ts) for the exact TypeScript contract.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The queue holds buffered entries in an array behind a consumed-head cursor: `take()` clears the slot it removes, and a drained buffer resets to empty, so retained references do not accumulate. `push()` and `end()` wake the one parked consumer through the same hand-off.

The class deliberately stops at the hand-off and leaves the iteration loop to each consumer, because consumers disagree about a finished queue. `ControlQueue` in `@deepseek-ai/dsh-api-session-controller` drains the frames buffered before its end, because disposal must not drop committed control state. The room stream's `iterateFrames` in `@deepseek-ai/dsh-experimental-agent-team` delivers nothing after its end, because disposal ends its readers before their listeners stop. Cancellation stays local for the same reason: each consumer owns the `AbortSignal` that finishes its own loop.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Buffered hand-off, parked-consumer wake-up, and finished state |
| — | No runtime invariant companion is published because this hand-off owns no independently observable relationship beyond its own buffer; unit tests cover ordering, wake-up, and refusal after the end. |
| [`tests/async-queue.spec.ts`](tests/async-queue.spec.ts) | Ordering, empty and refilled buffers, parked and immediate waits, idempotent `end()`, and refused pushes |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Utility package map](../README.md) — the other zero-dependency primitives shared across package groups.
- [Cross-package value dependencies](../../../.agents/notes/archived/process/2026-08-23-client-cross-package-value-dependencies.md) — the extraction policy that moved this hand-off out of its two callers.

-----

<a id="model-experience"></a>
## Model Experience

None, as this in-process hand-off registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One consumer per queue** — `wait()` holds a single parked resolver, so a second concurrent consumer would leave the first parked indefinitely; a consumer that needs fan-out uses one queue per reader.
- **No capacity policy** — the queue does not bound, coalesce, or reject entries, so a producer that outruns its consumer grows the buffer; each consumer must define overload behavior appropriate to its stream.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
