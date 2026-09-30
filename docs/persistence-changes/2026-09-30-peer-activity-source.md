---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-peer-activity-source

English | [中文](2026-09-30-peer-activity-source.zh.md)

## Summary

Adds the peer-activity message source for the activity snapshots that peer sessions publish to each other.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-peer-activity-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-29-peer-message-sources"
    after: "f77b7f0a0939ccb192b5a8440d502f2d99f3ef2aea1e11e33d5294faaa940d0f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-29-peer-message-sources"
    after: "d0ab8249b201dd953ff20782d802080f27ab713ce64489182d030e7f5124ac67"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-29-peer-message-sources"
    after: "5232bc1200091a0b11e413083763380ae1c5146f6b5270d8d239f54e1f187b0c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-29-peer-message-sources"
    after: "671561b6d873509d1705c7a736063f2d685576758b63f45f3a69d37eeae7ac52"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Attribution-only source kind added under writer 4 to the four roots that carry qualified message sources. Existing records remain valid. A build without the peer sessions package still reads the log: the kind and its `form`, `sections`, and `peerIds` survive reading, and the kind imposes no validation, replay, or authority requirement. Only the producing build reads `peerIds`, to decide whether a later step lists a peer again.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/peer-sessions packages/experimental/tool-peer-sessions: 215 tests passed; pnpm run test:snapshot -t peer-activity: 1 test passed, so the peer-activity recorded-session snapshot replays keyless.

<a id="dev-note"></a>
## Dev Note

None.
