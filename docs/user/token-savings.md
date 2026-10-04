---
description: "Trial smaller file reads and compare complete-task usage, prompt caching, and tool modes."
---

# Trial token-saving settings

English | [中文](token-savings.zh.md)

## Summary

Every composition that mounts the filesystem read tool uses a 500-line default window across model routes, while explicit reads may request up to 2,000 lines. A custom smaller line cap also lowers the default window. The window reduces input before provider routing, but each model's tokenizer and read behavior affect the total-token savings. Stable workspace instructions may improve provider-specific prefix caching, while model switches keep the conversation's task state.

## Table of Contents

- [Try smaller reads](#try-smaller-reads)
- [Retrieve large results selectively](#retrieve-large-results-selectively)
- [Keep reusable context stable](#keep-reusable-context-stable)
- [Choose a tool mode](#choose-a-tool-mode)
- [Measure the complete task](#measure-the-complete-task)
- [Dev Note](#dev-note)

<a id="try-smaller-reads"></a>
## Try smaller reads

The filesystem read tool owns the smaller default, so Web presets, Portal, SDK extensions, and custom compositions receive it without a provider-specific setting. A profile may override the tool configuration. The [read-window patch](../../apps/cli/config/examples/token-savings.patch.yml) pins the standard values explicitly; from the repository root, inspect that configuration:

```sh
pnpm dsh --profile portal --patch "$PWD/apps/cli/config/examples/token-savings.patch.yml" --dump-config
```

Confirm that the `tool-fs` row contains `readDefaultLimit: 500` and `readLimit: 2000`. The patch is optional. A patch replaces the row's whole configuration, so include any custom byte, line-length, or streaming limits you want to keep.

A `read` call without `limit` returns at most 500 lines, subject to the existing byte and line-length caps. A caller can request an explicit `limit` up to 2,000 or use the returned continuation offset. The window is model-independent; the exact token reduction is not, because tokenizers, task behavior, and provider accounting vary. [Filesystem tools](../../packages/fs/tool-fs/README.md) own configuration and validation details.

<a id="retrieve-large-results-selectively"></a>
## Retrieve large results selectively

Base-backed profiles retain large tool results within a 6,000-token estimate, including the recovery notice. The model receives the beginning and end plus a file path for the full formatted result. Follow that path with a targeted `read` or `grep` when the omitted middle matters. The policy leaves `read` results and complete PTC program values intact. Smaller results pass through unchanged; failed recovery storage keeps the original result visible. [Spill policy](../../packages/spill/spill-policy/README.md) defines configuration, image pricing, and exceptions.

Search results use compact `N: text` rows beneath each file path. This removes repeated labels while preserving paths, line numbers, and every retained match. [Filesystem search](../../packages/fs/tool-fs-search/README.md) owns result caps and complete-list recovery.

<a id="keep-reusable-context-stable"></a>
## Keep reusable context stable

Fresh conversations place applicable workspace instructions before the initial task, so different tasks can share an identical instruction prefix. Direct user instructions retain precedence over workspace guidance. Existing conversation history keeps its order; [workspace instructions](../../packages/context/agent-instructions/README.md) define loading and refresh behavior.

Keep stable guidance in instruction files and changing requests in the task. Providers decide whether an eligible prefix produces a cache hit. Switching models retains conversation history, goals, todos, and checkpoints; it does not transfer a portable raw model cache or automatically summarize the switch. Evaluate reuse separately for each provider and model.

<a id="choose-a-tool-mode"></a>
## Choose a tool mode

Compare native tool calls with programmatic tool calling (PTC) on the same workload. Native calls avoid the generated code SDK context; PTC can batch several operations and process results locally, but its SDK and program output also consume context. Choose the mode that completes your tasks with less total usage, not the mode with fewer visible calls. [Tool modes](../../packages/core/tools/README.md) describe the available configuration.

<a id="measure-the-complete-task"></a>
## Measure the complete task

Compare the 500-line default with a larger explicit setting on the same representative tasks and model route. Repeat the comparison across routes instead of assuming one model's percentage transfers to another. Include short files, partial reads of large files, and tasks that need an entire file. Verify the resulting files or answers independently, and compare completion time and retries.

A smaller-read trial on DeepSeek V4.1 Flash used 49.8% fewer provider-reported total tokens across six synthetic tasks per setting. A separate spill-budget trial on the `deepseek-flash` route compared 12,500 and 6,000 across three task patterns repeated three times per setting: all 18 reports matched independently checked answers, and totals fell from 524,213 to 349,116 tokens (33.4%). The small-output pattern increased 23.7% because one candidate run added verification calls. These synthetic results cover one model; they do not establish a cross-model savings rate. Compare provider-reported input, output, and available cache-read/cache-write totals separately across every request, including retries, compaction, and auxiliary model calls. Keep missing usage fields unknown; token totals do not establish billed savings. Use each provider's applicable prices when comparing cost. Retain the setting only when successful complete tasks improve without losing required results; extra continuation calls can erase a smaller window's benefit.

<a id="dev-note"></a>
## Dev Note

None.
