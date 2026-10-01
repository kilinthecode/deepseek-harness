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
    previous: "2026-09-30-peer-activity-source"
    after: "72faca5ef2adafdf12c70286f336489aaf1733264c7cac60492fa6b7af1d4920"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-peer-activity-source"
    after: "81e3a9087e0b3efddf0fd9d36cc79ee39455b8b1931fcc9a681037bdc562847b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-peer-activity-source"
    after: "03b51916ae6ed18d3d96655a1828520022001c6d761f3bf70e99e06f9ab00fd5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-peer-activity-source"
    after: "a69cf4bb04d9411c5f0fa3d645036cb01fb8dc67e57158305e0922c59988eef8"
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
