---
description: "Trial smaller file reads and compare complete-task usage, prompt caching, and tool modes."
---

# Trial token-saving settings

English | [中文](token-savings.zh.md)

## Summary

Use a smaller default file-read window when a task needs only part of a large file. Keep explicit larger reads available, and compare complete tasks before retaining the setting. Stable workspace instructions can improve opportunities for prefix caching, while model switches keep the conversation's task state.

## Table of Contents

- [Try smaller reads](#try-smaller-reads)
- [Keep reusable context stable](#keep-reusable-context-stable)
- [Choose a tool mode](#choose-a-tool-mode)
- [Measure the complete task](#measure-the-complete-task)
- [Dev Note](#dev-note)

<a id="try-smaller-reads"></a>
## Try smaller reads

The optional [read-window overlay](../../apps/cli/config/examples/token-savings.patch.yml) uses a trial default of 500 lines and keeps the maximum at 2000. This setting is not a universal savings recommendation. From the repository root, inspect the resulting profile:

```sh
dsh --profile headless --patch "$PWD/apps/cli/config/examples/token-savings.patch.yml" --dump-config
```

Confirm that the `tool-fs` row contains `readDefaultLimit: 500` and `readLimit: 2000`. Pass the same `--patch` option when launching your chosen profile to trial it. Copy the overlay to a permanent location if you use an installed CLI outside the checkout. A patch replaces the row's whole configuration, so include any custom byte, line-length, or streaming limits you want to keep.

A `read` call without `limit` returns at most 500 lines, subject to the existing byte and line-length caps. A caller can request an explicit `limit` up to 2000 or use the returned continuation offset. Removing the overlay restores the profile's own settings; [filesystem tools](../../packages/fs/tool-fs/README.md) own configuration and validation details.

<a id="keep-reusable-context-stable"></a>
## Keep reusable context stable

Fresh conversations place applicable workspace instructions before the initial task, so different tasks can share an identical instruction prefix. Direct user instructions retain precedence over workspace guidance. Existing conversation history keeps its order; [workspace instructions](../../packages/context/agent-instructions/README.md) define loading and refresh behavior.

Keep stable guidance in instruction files and changing requests in the task. Providers decide whether an eligible prefix produces a cache hit. Switching models retains conversation history, goals, todos, and checkpoints; it does not transfer a portable raw model cache or automatically summarize the switch. Evaluate reuse separately for each provider and model.

<a id="choose-a-tool-mode"></a>
## Choose a tool mode

Compare native tool calls with programmatic tool calling (PTC) on the same workload. Native calls avoid the generated code SDK context; PTC can batch several operations and process results locally, but its SDK and program output also consume context. Choose the mode that completes your tasks with less total usage, not the mode with fewer visible calls. [Tool modes](../../packages/core/tools/README.md) describe the available configuration.

<a id="measure-the-complete-task"></a>
## Measure the complete task

Run the same representative tasks with and without the overlay, using the same model and effort setting. Include short files, partial reads of large files, and tasks that need an entire file. Verify the resulting files or answers independently, and compare completion time and retries.

Compare totals for provider-reported input, output, and available cache-read/cache-write usage separately across every request, including retries, compaction, and auxiliary model calls. Keep missing usage fields unknown; prompt estimates do not establish billed savings. Use the provider's applicable prices when comparing cost. Retain the trial setting only when successful complete tasks improve without losing required results; extra continuation calls can erase a smaller window's benefit.

<a id="dev-note"></a>
## Dev Note

None.
