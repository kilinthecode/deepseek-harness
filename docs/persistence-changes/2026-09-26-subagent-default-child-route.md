---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-26-subagent-default-child-route

English | [中文](2026-09-26-subagent-default-child-route.zh.md)

## Summary

Adds an optional defaultModel field to the subagent/model-selection-policy event, recording a default child route and reasoning effort applied when a delegation call omits provider and model.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-subagent-default-child-route
baseline: false
changes:
  - root: "event:subagent/model-selection-policy"
    previous: "2026-09-11-initial"
    after: "fde25355968b1b7eacba0c45b16fa179d607295763e0cc2c1a79874296235a0b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: an older event carries no defaultModel key, and the fold returns a policy with allowedModels only, exactly as before. A reader that does not know this field ignores it; the field never enters model history and is not required to resolve any existing behavior. New readers validate a present defaultModel against allowedModels and reject a malformed or out-of-list value.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/subagent/tool-subagent/tests packages/client/ui-settings-subagent --coverage.enabled=true --coverage.include='packages/subagent/tool-subagent/src/**' --coverage.include='packages/client/ui-settings-subagent/src/**' --coverage.reporter=text: 196 tests passed, 100% statement/branch/function/line coverage on touched src files.

<a id="dev-note"></a>
## Dev Note

None.
