---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-memory-catalog-source

[English](2026-09-24-memory-catalog-source.md) | 中文

## 概述

为持久记忆目录新增仅用于归属的 `tool-memory` user 消息 source kind。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-memory-catalog-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-30-peer-activity-source"
    after: "72faca5ef2adafdf12c70286f336489aaf1733264c7cac60492fa6b7af1d4920"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-peer-activity-source"
    after: "81e3a9087e0b3efddf0fd9d36cc79ee39455b8b1931fcc9a681037bdc562847b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-peer-activity-source"
    after: "03b51916ae6ed18d3d96655a1828520022001c6d761f3bf70e99e06f9ab00fd5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-peer-activity-source"
    after: "a69cf4bb04d9411c5f0fa3d645036cb01fb8dc67e57158305e0922c59988eef8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效，Session 头保持 V4。`tool-memory` kind 标注 dsh-tool-memory 以 `snapshot` 形式注入的记忆目录 user 消息；未安装该生产者的读取方保留记录的内容和每个 source JSON 属性。生产者自己的 `memoryCatalog` 投影使用该 kind 查找最近注入的目录，归属策略允许这种用法。已有的 source 备选项保持不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/memory：64 个测试通过，其中包括只折叠 `tool-memory` snapshot 消息、忽略其他生产者 snapshot 和 `tool-memory` notice 的投影测试。录制的 memory-catalog-recall、memory-project-forget 和 memory-catalog-refresh 场景以新 kind 回放目录。

<a id="dev-note"></a>
## 开发备注

无。
