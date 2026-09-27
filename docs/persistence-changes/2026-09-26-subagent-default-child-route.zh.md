---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-26-subagent-default-child-route

[English](2026-09-26-subagent-default-child-route.md) | 中文

## 概述

为 subagent/model-selection-policy 事件新增可选字段 defaultModel，记录委派调用省略 provider 和 model 时使用的默认子路由与推理强度。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-subagent-default-child-route
baseline: false
changes:
  - root: "event:subagent/model-selection-policy"
    previous: "2026-09-11-initial"
    after: "fde25355968b1b7eacba0c45b16fa179d607295763e0cc2c1a79874296235a0b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：较旧的事件不携带 defaultModel 键，折叠结果与此前一样只包含 allowedModels。不了解该字段的读取方会忽略它；该字段从不进入模型历史，也不是解析现有行为所必需的。新的读取方会校验存在的 defaultModel 是否在 allowedModels 中，并拒绝格式错误或不在列表中的值。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/subagent/tool-subagent/tests packages/client/ui-settings-subagent --coverage.enabled=true --coverage.include='packages/subagent/tool-subagent/src/**' --coverage.include='packages/client/ui-settings-subagent/src/**' --coverage.reporter=text：196 个测试通过，改动的 src 文件语句/分支/函数/行覆盖率均为 100%。

<a id="dev-note"></a>
## 开发备注

无。
