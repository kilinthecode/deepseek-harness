---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-18-team-task-verification

[English](2026-09-18-team-task-verification.md) | 中文

## 概述

在共享 Team 任务上记录同行验证：谁提交了哪个 revision，以及在同行答复后其裁决与理由。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

该属性是可选的增量字段：已有的 team/task 记录仍然有效并保留其既有 status 变体，因此没有验证信息的任务读取结果与之前完全一致。等待验证是由“已提交但尚无裁决”派生出来的，而不是存储为新 status，因此没有持久 union 变更，也没有 Session 格式版本变化。

较早的读取方并不会忽略这一新增字段。Team 投影对每个 `team/task` payload 都按 `.strict()` schema 解析，因此在 `verification` 出现之前发布的构建会拒绝该记录：fold 会把解析失败锁定在自身投影状态中，并为该会话丢弃之后的所有 Team event；用同一构建重新加载仍会在同一条记录上失败。只有声明了该属性的构建才能折叠该会话。

<a id="verification"></a>
## 验证

node node_modules/vitest/vitest.mjs run --config vitest.config.ts --coverage --coverage.include='packages/experimental/agent-team/src/**' packages/experimental/agent-team packages/experimental/tool-agent-team packages/experimental/tool-agent-room packages/experimental/client-ui-agent-team：206 个测试通过，packages/experimental/agent-team/src 的语句、分支、函数与行覆盖率均为 100%。

<a id="dev-note"></a>
## 开发备注

无。
