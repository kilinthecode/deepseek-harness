---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-peer-activity-source

[English](2026-09-30-peer-activity-source.md) | 中文

## 概述

新增 peer-activity 消息来源，用于对等会话之间发布的活动快照。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

在写入版本 4 下，向携带限定消息来源的四个根仅新增归属来源类型。已有记录仍然有效。未安装对等会话包的构建仍可读取日志：该 kind 及其 `form`、`sections` 与 `peerIds` 在读取时得以保留，且该 kind 不引入校验、回放或权限要求。只有生成该消息的构建会读取 `peerIds`，用来决定之后的步骤是否再次列出某个对等会话。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/peer-sessions packages/experimental/tool-peer-sessions：215 个测试通过；pnpm run test:snapshot -t peer-activity：1 个测试通过，因此 peer-activity 录制会话快照可在无密钥情况下回放。

<a id="dev-note"></a>
## 开发备注

无。
