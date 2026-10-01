---
description: "Circular deque for Host and browser packages that need amortized constant-time queue operations, immediate release of removed entries, and bounded vacant storage."
kind: "package-library"
---

# @deepseek-ai/dsh-deque

English | [中文](README.zh.md)

## Summary

`dsh-deque` lets Host and browser packages drain long-lived in-process queues without moving every remaining entry after each removal. Callers append or prepend entries and remove them from the front with amortized constant-time operations. The deque owns entry order and backing-storage release; each consumer still owns wake-up, failure, cancellation, capacity, and overload behavior.

`FrameQueue<T>` composes that storage with the wake-up protocol many-to-one stream hand-offs repeat: producers push, one reader iterates, and the caller declares once whether a finish drains the backlog or discards it. Consumers whose wake-up, failure, or cancellation behavior differs keep their own queue.

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

Use `Deque<T>` when entries can accumulate across asynchronous work and the consumer needs FIFO removal, optional front insertion, or explicit queue clearing. Finite local worklists can stay as arrays when their maximum size makes head removal cost irrelevant.

### Entry point

Import the deque, append entries at the tail, and check `size` before removing an entry whose type may include `undefined`:

```ts
import { Deque } from '@deepseek-ai/dsh-deque'

const frames = new Deque<string>()
frames.pushBack('first')
frames.pushFront('before-first')

while (frames.size > 0) {
  console.log(frames.popFront())
}
```

The methods do not impose a queue limit or translate consumer failures. See [`src/index.ts`](src/index.ts) for the exact TypeScript contract.

### Hand-off to one asynchronous reader

Use `FrameQueue<T>` when producers enqueue while a single reader consumes, and the reader must be woken on demand rather than polled. The construction-time drain policy is the one lifecycle decision this class makes on the caller's behalf: `'drain'` delivers entries still queued when the queue finishes, and `'discard'` ends the reader without them.

```ts
import { FrameQueue } from '@deepseek-ai/dsh-deque'

const frames = new FrameQueue<string>('drain')
const controller = new AbortController()

const reader = (async () => {
  for await (const frame of frames.iterate(controller.signal)) console.log(frame)
})()

frames.push('first')
frames.finish()
void reader
```

`finish()` is idempotent, and `push()` after it discards the entry. Aborting the iteration's signal finishes the queue and removes the listener the iteration installed. A queue retains its entries until the reader removes them; capacity and overload policy stay with the caller.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The deque stores entries in a circular array. Removing an entry clears that slot immediately, while geometric growth and quarter-full shrinking keep copying work amortized constant time and prevent a head cursor from retaining indefinitely growing vacant storage.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Circular deque operations, backing-storage lifecycle, and the `FrameQueue` wake-up protocol |
| — | No runtime invariant companion is published because this collection owns no event stream or shared mutable state; unit tests cover its ordering and storage lifecycle. |
| [`tests/deque.spec.ts`](tests/deque.spec.ts) | FIFO, front insertion, wrapping, growth, compaction, clearing, and reuse coverage |
| [`tests/frame-queue.spec.ts`](tests/frame-queue.spec.ts) | Wake-up delivery, finish idempotence, both drain policies, and abort coverage |
| [`benchmarks/drain.ts`](benchmarks/drain.ts) | Reproducible backlog-drain timing across increasing queue sizes |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Utility package map](../README.md) — the other zero-dependency primitives shared across package groups.
- [Linear stream queue decision](../../../.agents/notes/archived/bug-fix/2026-08-28-linear-stream-queue-drain.md) — why production streams use this deque instead of array head removal.

-----

<a id="model-experience"></a>
## Model Experience

None, as this in-process collection registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No capacity policy** — the deque does not bound, coalesce, or reject entries; each consumer must define overload behavior appropriate to its stream.
- **One reader per `FrameQueue`** — the wake-up protocol releases the single reader waiting when an entry arrives, so concurrent readers would race for entries. Give each reader its own queue, and keep shared back-pressure outside this class.
- **The drain policy is fixed at construction** — a queue that must observe the backlog and one torn down without further delivery differ only by that argument; changing it later is not supported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
