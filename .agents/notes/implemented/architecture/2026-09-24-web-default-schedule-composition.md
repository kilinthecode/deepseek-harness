# Agent Note: Schedule in the shipped Web composition

Status: implemented

English | [中文](2026-09-24-web-default-schedule-composition.zh.md)

## Problem

The Automation tasks page, the Session reminder catalog, and the `schedule_*` tools reached a Web deployment only through `--patch apps/cli/config/examples/schedule/cordis.yml`. `packages/bundle/web-app/cordis.patch.yml` carried the `ui-schedule` client row with `disabled: true`, and the Host rows `time-context` and `schedule` existed in that overlay alone. A person running the shipped `web` profile therefore saw no Automation tasks entry and no reminder tools, while every consumer that wanted them repeated the same three rows: the repository preview image kept its own overlay list, and two Web suites hard-coded the overlay path.

## Decision

`packages/bundle/web-app/cordis.patch.yml` inserts `schedule` in its Host row list and leaves `ui-schedule` enabled. The `web` profile consequently ships the Automation tasks page, the Session-header reminder clock, the idle Session row's clock mark and hover list, and the right-Sidebar task tab. The `standard`, `cordis`, and `ptc` presets declare `@deepseek-ai/dsh-tool-schedule` and `@deepseek-ai/dsh-time-context`; `minimal` declares neither. The [preset-scoped tools](2026-09-24-preset-scoped-schedule-tools.md) and [preset-scoped clock](2026-09-24-preset-scoped-time-context.md) decisions own that placement. `packages/bundle/web-app/package.json` declares the service, tool, and clock packages for bare-name resolution.

`apps/cli/config/examples/schedule/cordis.yml` is deleted. `applyEntryPatches` appends an `insert` list without de-duplicating ids, so keeping the overlay would mount `schedule` a second time and add a profile-wide `time-context` row; the two Web suites and the preview packer that named the overlay compose the shipped profile alone.

`time-context` ships with Schedule because a reminder request states a wall-clock target. The plugin appends one durable user message at its configured minimum interval on eligible steps carrying the sampled instant, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message. The sampling instant is what lets the model turn a request such as "tomorrow at nine" into an offset-bearing `at` value; the [Schedule subsystem](../../../../docs/subsystems/schedule.md) owns that interpretation boundary and the explicit-zone requirement it feeds.

This decision keeps Schedule in the shipped Web composition. The [Host-owned scheduled messages decision](2026-09-16-host-schedule-storage.md) continues to own task storage, activation, dispatch, and delivery records; the preset placement decisions refine which Agents receive the tools and clock reading.

## Recorded sessions

A Web scenario using a preset with `time-context` logs readings at the configured minimum interval; its committed Session fixture and header sidecars record those messages. A reading's sampled instant, browser zone, and elapsed duration are volatile, and `normalizeWebSessionVolatiles` in `apps/web/tests/scaffold.ts` replaces them with `{{timeContextTimestamp}}`, `{{clientTimeZone}}`, and `{{elapsed}}`. The turn and step numbers and the preceding-event baseline stay readable, so a fixture still shows what the model received. Refresh writes the current writer generation (`session.v4.jsonl`) beside the retained predecessors, which remain committed replay baselines.

## Alternatives considered

**Keep the overlay and change nothing.** The shipped surface would keep contradicting the product documentation that describes the Automation tasks entry, and each consumer would keep its own copy of the three rows. The overlay also cannot satisfy the request that the default `dsh web` process exposes the page without a flag.

**Ship the Schedule rows without `time-context`.** The model would then have no sampling instant of its own, so an unqualified date or time in a reminder request would depend on a separate clock source; the overlay paired the two rows for that reason.

**Reach for a separate optional bundle.** `OPTIONAL_BUNDLES` exists for bundles a person switches on from the plugin manager, which is the same opt-in shape as the overlay; the decision here is that a default Web surface owns the page and the tools.

## Consequences

- `standard`, `cordis`, and `ptc` request headers carry four reminder tool schemas, and their eligible steps append durable clock readings at the configured minimum interval. A conversation using those presets pays that token cost even if it never creates a reminder; `minimal` pays neither cost.
- The clock reading is model-visible and durable, so it replays, compacts, and appears in exported Session logs like any other user message.
- A deployment disables the Host service and client page through the `schedule` and `ui-schedule` rows in its profile patch. Removing or reconfiguring the clock and model tools requires editing the applicable preset's `config.plugins`, because those declarations are not profile-wide rows.
- The `cordis_inspect_query` `listTools` answer for a full preset table now passes the base composition's configured inline budget, so the spill policy retains that answer's head and tail with a spill path instead of the complete JSON.
- The repository preview image and both Web suites drop their overlay arguments, so one composition change reaches every surface at once.
