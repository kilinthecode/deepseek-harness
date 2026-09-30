---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-peer-message-sources

[English](2026-09-29-peer-message-sources.md) | 中文

## 概述

新增 peer-message 与 peer-idle 消息来源，用于来自对等会话的消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

在写入版本 4 下仅新增归属来源类型。已有记录仍然有效；未安装对等会话包的构建仍可读取日志，因为只扩展了归属词汇。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/peer-sessions：127 个测试通过；peer-message 录制会话快照可在无密钥情况下回放。

<a id="dev-note"></a>
## 开发备注

无。
