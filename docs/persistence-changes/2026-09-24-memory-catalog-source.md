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
    previous: "2026-09-16-session-format-v4"
    after: "3ee73ce8ae9a1eb6b8a08da854eba7780eeef15e0f0927e66f143dfba4360d43"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "49dc7dcbdf82006eba9f75aebc32ba9b3004503185518cef44a10729a8e97e49"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "0ed198589af45c87e413a50be0b1524be51629241b9919ad9e7da1118df6e74f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "ccd57d9a60cd7d3d3c15ad392ee6ad103d5e414fca805f71f906356bd1704d6a"
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
