---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-04-timed-question-reply-attribution

[English](2026-10-04-timed-question-reply-attribution.md) | 中文

## 概述

为回答计时问题的普通用户消息增加归属信息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

user-question-reply 来源类型只增加归属信息。已有事件记录和 Session 格式版本 4 仍有效。计时和迟到的答复使用 user/message，原问题事件仍保留。已有序列化夹具版本保持不变。

<a id="verification"></a>
## 验证

所选运行时测试中的问题服务、计时等待、投影、ask-user 和问题 Client 测试通过。已有 Session 版本保留；集成检查回放所选恢复和计时问题夹具。

<a id="dev-note"></a>
## 开发备注

无。
