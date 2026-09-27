# Agent Note: Threshold-relative prune headroom and compact-first pressure order

Status: implemented

English | [中文](2026-09-28-cache-aware-pressure-prune.zh.md)

## Problem

The pressure path pruned oversized tool results unconditionally before selecting a summarization range, even when the prune alone could not clear the pressure threshold. Summarization then ran anyway on the already-pruned surface, paying a second prompt-cache break per pressure event instead of one: `region.ts`'s `buildSummarizationInput` derives each shadowed message from the session's current surface at call time, so a prune landed before compaction makes the summary request diverge from the conversation's warm prefix at the first pruned node, and the provider re-prices the request from that point on.

A landed prune-only reduction can also be worth less than it costs. Measured on one user's MiMo v2.6 Pro sessions (262144-token window): ten prune-only passes each started a new request series and re-sent 40K–180K uncached tokens (about 0.74M in total); pressure returned within 1.4–8.5 minutes in six of seven measurable cases, and once after 35 minutes. A margin expressed as a fraction of the context window does not track this cost: the window is fixed per model, while the amount a failed prune-only pass re-sends is the suffix after the first pruned node, which grows with the conversation.

## Decision

`compaction-tool-result-pruner` exposes `previewSession(session): PrunePreview`, sharing the pruner's candidate-planning routine with `pruneSession` so a preview can never diverge from what actually lands. `compaction-basic` resolves `pruneHeadroomRatio` (default `0.2`, validated to `[0, 1)`) into `pruneHeadroomTokens = floor(thresholdTokens * pruneHeadroomRatio)` — a fraction of the resolved pressure threshold, not of the context window, so the bar scales with what a prune-only pass would have to re-send if it falls short.

At a pressure trigger, `compactIfNeeded` previews the mounted pruner before selecting a summarization range. When landing the prune would leave at least `pruneHeadroomTokens` of headroom below the threshold, the prune lands as the sole reduction and summarization is skipped — one cache break. Otherwise range selection and summarization run first on the unpruned surface, matching the conversation's warm prefix, and a prune of the surviving surface follows each landed compaction, which costs nothing further since the summary replacement already broke the cache. A session with no compactable range still gets pruned before `compactIfNeeded` declines. Context-overflow recovery is unchanged: it still prunes unconditionally before selecting a range, since the retried request itself must fit the window.

The post-prune recheck compares a route-priced remeasurement against the heuristic preview, so a preview that qualifies does not guarantee the landed prune clears the threshold — at `pruneHeadroomRatio: 0`, an exact tie can go either way depending on which estimate is used. When the landed prune does not clear the threshold, execution falls through into the same compaction loop instead of returning early, so the surviving, already-pruned surface is what gets summarized.

## Alternatives considered

**An absolute-token margin instead of a threshold fraction.** A fixed token count does not scale with the re-send cost a failed prune-only pass incurs, which grows with the conversation, not with a constant; a small-window and a large-window deployment would need unrelated tuning for the same underlying trade-off.

**Always prune before compacting (the previous order).** This is the behavior the measurement above quantifies: it pays a second cache break whenever the prune alone cannot clear the threshold, without buying anything, since the compaction that follows summarizes the pruned surface anyway.

**Never prune at pressure; only prune on context overflow.** This gives up the cheap, model-free reduction a genuinely oversized single tool result can provide on its own, forcing every pressure event through a paid summarization call even when pruning alone would have sufficed.

**Represent the summarizer's leading system prompt as an in-history user-role message for the `llm-pi-ai` adapter, instead of the adapter's own request field.** `llm-pi-ai`'s request context carries exactly one leading `systemPrompt` field plus `user`/`assistant`/`toolResult` messages; wrapping the system prompt as a user-role message would change instruction-following semantics differently across providers, so replay keeps using each adapter's native system-prompt field instead.

## Consequences

- A pressure event now costs one prompt-cache break in the common case: either the prune-only reduction lands alone, or compaction runs first on the surface that still matches the conversation's warm prefix.
- `pruneHeadroomRatio: 0` only restores skipping summarization when the prune alone reaches the threshold; it does not restore the former prune-before-compaction order, since a prune that falls short now falls through to compaction on the already-pruned surface rather than summarizing the original one.
- `pruneHeadroomTokens` and its resolution are threshold-relative rather than window-relative; a configuration or test written against the prior window-relative token count needs updating.
