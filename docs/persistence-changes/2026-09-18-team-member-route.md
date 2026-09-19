---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-18-team-member-route

English | [中文](2026-09-18-team-member-route.zh.md)

## Summary

Records the resolved LLM route of each teammate on its team/member record, so the roster and the room board keep naming the model a teammate runs after its child Agent stops between turns.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-team-member-route
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "49c67f40c45f8e1c1bc65851eaefbe41d5ed354544fa90bbd264aa2ce14321ba"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both properties are optional and additive: existing team/member records stay valid and read as members with no recorded route, and a row falls back to the live child Agent whenever one exists. No durable union changes and no Session format version moves.

<a id="verification"></a>
## Verification

node node_modules/vitest/vitest.mjs run --config vitest.config.ts --coverage --coverage.include='packages/experimental/agent-team/src/**' packages/experimental/agent-team packages/experimental/tool-agent-team packages/experimental/tool-agent-room packages/experimental/client-ui-agent-team packages/core/agent-default-model: 223 tests passed, 100% statements, branches, functions, and lines on packages/experimental/agent-team/src.

<a id="dev-note"></a>
## Dev Note

None.
