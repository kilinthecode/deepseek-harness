---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-26-team-duty-and-subject

[English](2026-09-26-team-duty-and-subject.md) | 中文

## 概述

在 team/member 记录上记录 teammate 创建时的分工（duty），并新增 team/subject 事件，用于保存 Lead 为其 Team 设定的主题。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

duty 属性是可选的增量字段：现有 team/member 记录保持有效，读取为没有分工的 teammate，这类 teammate 沿用不受限制的任务规则。team/subject 是新的仅日志事件类型，只在 Lead 设定主题后写入，因此没有主题的 Session 不受影响；以最新一条记录为准。Team 投影检查点布局升到版本 6，并从 Session 日志重建。没有持久联合类型发生变化，Session 格式版本不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team packages/experimental/tool-agent-team --exclude '**/*.e2e.ts' --coverage.enabled=true --coverage.include='packages/experimental/agent-team/src/**' --coverage.include='packages/experimental/tool-agent-team/src/**'：210 个测试通过，两个 src 目录的语句、分支、函数与行覆盖率均为 100%。

<a id="dev-note"></a>
## 开发备注

无。
