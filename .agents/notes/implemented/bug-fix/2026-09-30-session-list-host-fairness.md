# Agent Note: Time-sliced Session-list work

Status: implemented

English | [中文](2026-09-30-session-list-host-fairness.zh.md)

## Problem

Large cached projection states can monopolize the Host while a Session list is assembled. Yielding after every row avoids that batch stall but adds thousands of event-loop round trips when a list contains many cheap rows. Row count alone is not a useful scheduling budget.

## Decision

[ApiSessionList](../../../../packages/api/session-controller/src/list.ts) uses one monotonic deadline for classification and summary generation. It yields only after elapsed work exhausts the configured `listWorkSliceMs`, then starts a new deadline after the wait. The optional deployment setting defaults to 16 positive integral milliseconds. Small lists have no forced final yield or no-op asynchronous helper. Cancellation is checked per row, after each yield, and before returning; no partial list is returned.

Every row remains synchronous. Live rows precede queued cold rows before the stable activity sort; the list promises no cross-Session atomic cut. A cold row already queued before an attachment remains cached, and Client mutation replay plus [cached/sequenced precedence](../architecture/2026-09-19-projection-cache-listing-identity-and-cached-rows.md) reconcile the newer live state. No projection data or validation is omitted.

## Verification scope

[Controlled-clock tests](../../../../packages/api/session-controller/tests/list-scheduling.host.spec.ts) verify the elapsed-work budget, deadline reset after yielding, stable ties, and cancellation. The 16 ms default is configurable; these tests establish scheduling behavior rather than a throughput or browser-rendering guarantee. This fork does not include the upstream projection-list benchmark or its CI performance lane.

## Alternatives considered

**Unconditional per-row yielding.** It minimizes individual queue waits but charges an event-loop round trip for every cheap row. That scheduling cost grows with the number of cheap rows; a fixed number of rows would still ignore variable row cost.

**Larger or smaller time slices.** Smaller slices offer shorter queue waits at more scheduling cost. Larger slices reduce switching but extend the period other Host work waits. Configuration exposes this tradeoff without changing row semantics.

**Caching decoded state or wire views.** Decoded-state reuse retains another graph per stored row and changes schema-evaluation ownership. Wire views can depend on current runtime state. Scheduling needs neither cache and preserves all schema checks and dynamic views.

## Consequences

[Controlled-clock tests](../../../../packages/api/session-controller/tests/list-scheduling.host.spec.ts) require cheap rows to remain in one synchronous slice, budget exhaustion and post-wait reset to govern yields, and cancellation to stop work even when no yield is due. They also preserve stable ties and attachment/removal/status interleavings.

A single row, provider enumeration, GC, final sorting and serialization can exceed the target. Concurrent lists and operating-system scheduling also affect latency. The budget is not a hard global bound, and the scheduling policy does not promise browser paint or model/network latency improvements.
