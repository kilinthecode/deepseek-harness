---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-18-team-task-verification

English | [中文](2026-09-18-team-task-verification.zh.md)

## Summary

Records a peer verification on a shared Team task: who submitted which revision and, once a peer answers, its verdict and reason.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-team-task-verification
baseline: false
changes:
  - root: "event:team/task"
    previous: "2026-09-11-initial"
    after: "2ecebd9ca881ece7744b2ef2a6ad12b2f08c132eb2dadd8004a4357ce6a61b76"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The property is optional and additive: existing team/task records keep their committed status variants, and no durable union changes, which is why no Session format version moves. A task revision committed before this change that reached `completed` carries no verification record, and it stays readable as completed: the read rule accepts an absent verification record whatever the status, while the writer can no longer produce that pair because only an approving verdict reaches `completed`. Awaiting verification is derived from a submission with no verdict rather than stored as a new status.

<a id="verification"></a>
## Verification

node node_modules/vitest/vitest.mjs run --config vitest.config.ts --coverage --coverage.include='packages/experimental/agent-team/src/**' packages/experimental/agent-team packages/experimental/tool-agent-team packages/experimental/tool-agent-room packages/experimental/client-ui-agent-team: 206 tests passed, 100% statements, branches, functions, and lines on packages/experimental/agent-team/src.

<a id="dev-note"></a>
## Dev Note

None.
