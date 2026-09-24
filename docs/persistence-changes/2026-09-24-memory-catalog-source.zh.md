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
    previous: "2026-09-16-session-format-v4"
    after: "3ee73ce8ae9a1eb6b8a08da854eba7780eeef15e0f0927e66f143dfba4360d43"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "49dc7dcbdf82006eba9f75aebc32ba9b3004503185518cef44a10729a8e97e49"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "0ed198589af45c87e413a50be0b1524be51629241b9919ad9e7da1118df6e74f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "ccd57d9a60cd7d3d3c15ad392ee6ad103d5e414fca805f71f906356bd1704d6a"
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
