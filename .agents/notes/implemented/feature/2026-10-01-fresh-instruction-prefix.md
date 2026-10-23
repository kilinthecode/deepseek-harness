# Agent Note: Stable instruction prefix for fresh conversations

Status: implemented

English | [中文](2026-10-01-fresh-instruction-prefix.zh.md)

## Problem

Workspace instructions can be identical across conversations in the same project, but placing them after a varying initial task ends the common request prefix before the instruction text. Reordering an established conversation would instead change input already sent to the model and discard reusable history.

## Decision

The [instruction plugin](../../../../packages/context/agent-instructions/src/index.ts) places complete baseline messages before the initial task only while no input has been admitted. It uses existing durable observations: no request header, no ordered message nodes, and zero `contentGeneration`. Empty assistant content still occupies a node, and replacements advance the generation; an empty derived transcript or a first step alone does not establish freshness. Rejected or cancelled proposals before admission leave the first prefix available for the next task.

Instructions remain sourced user-role messages with the existing framing and change records. The admitted `user/message` order is the model request order; no new event or separate admission flag is needed. A matching baseline already in the claimed batch moves before the initial task without another copy. An empty first entry keeps instructions pending.

Existing, resumed, inherited, and compacted history retains its order. Restored baselines and later file changes append. The framing continues to state that workspace guidance does not override system, developer, or direct user instructions. The [memory snapshot decision](2026-09-25-frozen-memory-snapshot-and-review.md) remains independent: this fresh-prefix exception applies only to complete workspace instruction baselines.

## Alternatives considered

**Keep the baseline after the initial task.** This preserves the previous placement but prevents differing tasks from sharing the following instruction prefix.

**Promote workspace instructions to system role.** This changes repository guidance into higher-authority content and makes system-prompt update behavior determine its lifecycle. User-role content already supplies the required durability and priority statement.

**Rewrite resumed or compacted history.** Moving admitted messages changes an established request prefix. Append-only restoration preserves the earlier input and requires no alternate replay representation.

**Add a switch summary or another admission flag.** A new summary spends tokens and duplicates existing conversation state on every switch. A new flag duplicates the request-header and message projections that already establish admission.

## Consequences

Matching workspace, configuration, and preceding request content can leave a longer identical prefix before differing task text. Provider cache eligibility still applies; this ordering neither removes instruction tokens nor guarantees a cache hit, and it transfers no model-specific KV cache. Dynamic context after the task and model-specific serialization can still limit reuse.

## Verification

The [instruction tests](../../../../packages/context/agent-instructions/tests/agent-instructions.spec.ts) pin fresh ordering, matching queued baselines, empty-message and replacement history, inherited requests, cancellation, pre-admission failure, provider retry, compaction, and later file changes. The [live e2e](../../../../packages/context/agent-instructions/tests/agent-instructions.e2e.ts) includes a direct user override of conflicting workspace guidance. The [native](../../../../snapshots/session/agent-instructions/snapshot.yml) and [PTC](../../../../snapshots/session/ptc-workspace-context/snapshot.yml) recordings pin admitted ordering. These checks establish request behavior; cache-hit rates and complete-task cost remain measurement questions.
