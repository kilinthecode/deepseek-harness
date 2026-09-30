---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-18-team-member-route

[English](2026-09-18-team-member-route.md) | 中文

## 概述

在每位队友的 team/member 记录中记录其解析后的模型路由，使子 Agent 在各轮之间停止后，名册与房间看板仍能指出该队友运行的模型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-team-member-route
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "49c67f40c45f8e1c1bc65851eaefbe41d5ed354544fa90bbd264aa2ce14321ba"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个属性均为可选且为纯新增：已有的 team/member 记录仍然有效，读作未记录路由的成员；只要子 Agent 存活，行就回退到该 Agent。持久 union 不变，Session 格式版本不升级。

<a id="verification"></a>
## 验证

node node_modules/vitest/vitest.mjs run --config vitest.config.ts --coverage --coverage.include='packages/experimental/agent-team/src/**' packages/experimental/agent-team packages/experimental/tool-agent-team packages/experimental/tool-agent-room packages/experimental/client-ui-agent-team packages/core/agent-default-model：223 个测试通过，packages/experimental/agent-team/src 的语句、分支、函数与行覆盖率均为 100%。

<a id="dev-note"></a>
## 开发备注

无。
