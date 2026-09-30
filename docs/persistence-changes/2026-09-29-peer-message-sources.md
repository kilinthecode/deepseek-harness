---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-peer-message-sources

English | [中文](2026-09-29-peer-message-sources.zh.md)

## Summary

Adds the peer-message and peer-idle message sources for messages delivered from peer sessions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-peer-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "3b562a1005aa4fcf01c227c97d477baa82e0c9aa52d2e6b295c551f4f62ab33c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "b31fbdb6f330c899fa46c3a03392f8f9cc6f96a105d318ef07cf1796abe0ac6e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "10e3c0481dc47eb8aae6de6ba1e9614ade1a1289ba87da54eabb02f15859e269"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "bbde81c8451cf2869f13650ec6e0da6080ee00b31483d28544211d441fbd0633"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Attribution-only source kinds added under writer 4. Existing records remain valid; a build without the peer sessions package still reads the log because only the attribution vocabulary grows.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/peer-sessions: 127 tests passed; the peer-message recorded-session snapshot replays keyless.

<a id="dev-note"></a>
## Dev Note

None.
