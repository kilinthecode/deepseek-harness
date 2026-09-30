---
description: "以出厂配置挂载对等会话服务及其工具的可选 bundle。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-peer-sessions-profile

[English](README.md) | 中文

## 概述

用 `dsh-experimental-peer-sessions-profile` 在某个 profile 中启用对等协同。该 bundle 是一份 patch 列表，按出厂配置插入 [`dsh-experimental-peer-sessions`](../peer-sessions/README.zh.md) 与 [`dsh-experimental-tool-peer-sessions`](../tool-peer-sessions/README.zh.md)，并提供 bundle 名册所需的图标与本地化文件。挂载它本身就是开关：未启用它的 profile 对其他对等会话不可见，而启用它的会话只能看到分组在同一仓库中的顶层会话。

## 目录

- [使用本包](#use-this-package)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把该 bundle 加入需要提供对等协同的 profile 的可选 bundle 列表。每个需要互相看见的对等进程都要在自己的 profile 中启用该 bundle，并且它们共用同一个 Harness home；home 决定谁能写入信箱文件，仓库分组决定谁可以被投递。

```yaml
- name: '@deepseek-ai/dsh-experimental-peer-sessions'
  config:
    pollMs: 1000
    maxPendingPerTarget: 8
    maxPendingPerSenderPerTarget: 4
    maxMessageBytes: 8192
    maxIdleWatches: 32
    peerInbound: steer
- name: '@deepseek-ai/dsh-experimental-tool-peer-sessions'
```

插入的行严格使用这些上限，因此需要不同上限的部署应覆盖该 bundle 的 patch，而不是改本包。

-----

<a id="further-exploration"></a>
## 进一步探索

- [对等会话服务](../peer-sessions/README.zh.md) — bundle 挂载的注册表、信箱与仓库键。
- [工具包](../tool-peer-sessions/README.zh.md) — bundle 挂载的工具与提示词段落。
- [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-peer-sessions) — 每个字段及其 JSDoc。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该 bundle 只按出厂配置插入两行插件，插入的包各自负责其所有模型可见的工具、结果与提示词文本。

#### KV Cache effect

没有直接失效；修改 bundle 的行只会改变由哪些插件负责请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明仅启用 bundle 仍然不够的情形。它们是当前的包约束，不是任务清单。

- **每个对等会话都必须主动启用** — profile 未包含该 bundle 的会话对其他对等会话不可见，因此 `list_peers` 为空并不能证明没有其他会话在运行。
- **必须共用同一个 Harness home** — `$DSH_HOME` 不同的进程永远看不到彼此的信箱、订阅与存在记录。
- **bundle 使用固定上限** — 需要其他上限的部署应覆盖 bundle 的 patch 行，而不是改本包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作说明 — 点击展开</summary>

无。

</details>

**Runtime invariant:** 不发布伴随状态。该 bundle 只贡献一份 patch 列表、一个图标与本地化文件，没有独立的事件序列。
