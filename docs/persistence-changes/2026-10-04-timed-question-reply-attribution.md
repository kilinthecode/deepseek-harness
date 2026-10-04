---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-04-timed-question-reply-attribution

English | [中文](2026-10-04-timed-question-reply-attribution.zh.md)

## Summary

Adds attribution for ordinary user messages answering timed questions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-04-timed-question-reply-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-24-memory-catalog-source"
    after: "10d2e59ec0553179548b58e6eae24159b5f21ef07bbe56381e2ed1dd98cb4d7b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-24-memory-catalog-source"
    after: "a75aba4fde1e9151726ef8a5425829af563d7678473cff5a0c5653052801234e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-24-memory-catalog-source"
    after: "ef2a32be50cf7ede652accdd96b9b5a430556d353a6b29cfc6eaaaec73a2d00f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-24-memory-catalog-source"
    after: "19156e0b778e0e3417bd792101c07f32d0ad9a1b2f7b5af89984cb090c678ec3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The user-question-reply source kind adds attribution only. Existing event records and Session format version 4 remain valid. Timed and late replies use user/message; the original question event remains recorded. Existing serialized fixture generations are retained.

<a id="verification"></a>
## Verification

The selected runtime suite passed the question-service, timed-wait, projection, ask-user and question Client tests. Existing Session generations are preserved; selected recovery and timed-question fixtures are replayed in the integration checks.

<a id="dev-note"></a>
## Dev Note

None.
