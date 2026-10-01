---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-memory-catalog-source

English | [中文](2026-09-24-memory-catalog-source.zh.md)

## Summary

Adds the attribution-only `tool-memory` user-message source kind for the durable memory catalog.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-memory-catalog-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "10d2e59ec0553179548b58e6eae24159b5f21ef07bbe56381e2ed1dd98cb4d7b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "a75aba4fde1e9151726ef8a5425829af563d7678473cff5a0c5653052801234e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "ef2a32be50cf7ede652accdd96b9b5a430556d353a6b29cfc6eaaaec73a2d00f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "19156e0b778e0e3417bd792101c07f32d0ad9a1b2f7b5af89984cb090c678ec3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid and the Session header remains V4. The `tool-memory` kind attributes the memory catalog that dsh-tool-memory injects as a `snapshot`-form user message; readers without that producer keep the recorded content and every source JSON property. The producer's own `memoryCatalog` projection uses the kind to find the last injected catalog, which the attribution policy permits. Existing source alternatives are unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/memory: 64 tests passed, including the projection test that folds only `tool-memory` snapshot messages and ignores another producer's snapshot and a `tool-memory` notice. The recorded memory-catalog-recall, memory-project-forget, and memory-catalog-refresh scenarios replay the catalog under the new kind.

<a id="dev-note"></a>
## Dev Note

None.
