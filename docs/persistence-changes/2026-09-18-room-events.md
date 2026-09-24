---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-18-room-events

English | [中文](2026-09-18-room-events.zh.md)

## Summary

Adds the four log-only Room events carrying a Team room's transcript, collective decisions, and review deadlines.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-room-events
baseline: false
changes:
  - root: "event:room/message"
    previous: null
    after: "f59d8e06c228d0781707d7cad2e056247bb26096a943f1cf41ee7aa363d10fe3"
    decision: same-version
  - root: "event:room/proposal"
    previous: null
    after: "a0b9d7c5d336b2bfd4adf52ffc4ccae8a62ad0a6f09052510264afbef83cd1df"
    decision: same-version
  - root: "event:room/review"
    previous: null
    after: "9555e80bbf3df9fdc0973071c50d0cf0d80b8378ccde5a53f22d29591c92559a"
    decision: same-version
  - root: "event:room/review-timeout"
    previous: null
    after: "dd3402428512758f330762d8ac118b4ea29aab3e5e299e1e40877664ea2e1a87"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

These are additive event roots: logs without them stay valid and no reader requires them. They are log-only, so replay never feeds them to a model request, and a build that does not declare them refuses the log unless the envelope marks them ignorable. A Lead Session that a fork build before the 2026-09-23 upstream sync wrote at Session format 3 with room events cannot be upgraded: the released V3-to-V4 migration accepts only its closed list of V3 event types, which the fork does not extend, so such a Session no longer opens. Format-4 logs carry the events as declared types. No Session format version changes, and no existing payload or header field changes meaning.

<a id="verification"></a>
## Verification

node node_modules/vitest/vitest.mjs run --config vitest.config.ts --coverage --coverage.include='packages/experimental/agent-team/src/**' packages/experimental/agent-team packages/experimental/tool-agent-team packages/experimental/tool-agent-room: 161 tests passed, 100% statements, branches, functions, and lines on packages/experimental/agent-team/src.

<a id="dev-note"></a>
## Dev Note

None.
