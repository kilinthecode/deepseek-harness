---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-18-room-events

[English](2026-09-18-room-events.md) | 中文

## 概述

新增四个 log-only 的 Room event，用于承载 Team room 的 transcript、集体决策与 review 截止时间。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

这些都是新增的 event root：不含它们的日志仍然有效，也没有读取方依赖它们。它们是 log-only，因此回放绝不会把它们送进模型请求；未声明它们的构建会拒绝该日志，除非 envelope 将其标记为 ignorable。2026-09-23 上游同步之前的 fork 构建以 Session 格式 3 写入且含 room event 的 Lead Session 无法升级：已发布的 V3 到 V4 迁移只接受其封闭的 V3 event 类型列表，而 fork 不扩展该列表，因此这类 Session 不再能打开。格式 4 的日志把这些 event 作为已声明类型携带。Session 格式版本不变，已有 payload 与 header 字段的含义也没有改变。

<a id="verification"></a>
## 验证

node node_modules/vitest/vitest.mjs run --config vitest.config.ts --coverage --coverage.include='packages/experimental/agent-team/src/**' packages/experimental/agent-team packages/experimental/tool-agent-team packages/experimental/tool-agent-room：161 个测试通过，packages/experimental/agent-team/src 的语句、分支、函数与行覆盖率均为 100%。

<a id="dev-note"></a>
## 开发备注

无。
