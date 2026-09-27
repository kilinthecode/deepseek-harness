---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-26-team-duty-and-subject

English | [中文](2026-09-26-team-duty-and-subject.zh.md)

## Summary

Records the duty a teammate was created with on its team/member record, and adds the team/subject event that holds the subject the Lead gave its Team.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-team-duty-and-subject
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-18-team-member-route"
    after: "602df874ec87ea193096763329faf87e74fd7005eea3bcfefad3f177f4fd1588"
    decision: same-version
  - root: "event:team/subject"
    previous: null
    after: "e632de6c2a434c169a380dfe895fcc8261cb8504a8b374980fd30581290f87e8"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The duty property is optional and additive: existing team/member records stay valid and read as teammates without a duty, which keep the unrestricted task rules. team/subject is a new log-only event type written only after a Lead records a subject, so Sessions without one are unchanged; the latest record wins. The Team projection checkpoint layout moves to version 6 and rebuilds from the Session log. No durable union changes and no Session format version moves.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team --exclude '**/*.e2e.ts' --coverage.enabled=true --coverage.include='packages/experimental/agent-team/src/**' --coverage.include='packages/experimental/tool-agent-team/src/**': 210 tests passed, 100% statements, branches, functions, and lines on both src trees.

<a id="dev-note"></a>
## Dev Note

None.
