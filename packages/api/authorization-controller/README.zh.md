---
description: "授权页面通过凭证登录种子上经过认证的 Remote 操作和快照流提供服务。控制器提供流程和尝试状态，不返回提示中的私密值。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-authorization-controller

[English](README.md) | 中文

## 概述

授权页面通过凭证登录种子上经过认证的 Remote 操作和快照流提供服务。控制器提供流程和尝试状态，不返回提示中的私密值。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

authorization 命名空间在 `ctx.authorization` 和 `ctx.credentials` 之上提供 getState、start、answer、decline、cancel、signOut 和 watch。控制器同一时间只拥有一个正在进行的尝试：start 为某个凭证 key 占用该槽位，在已有尝试运行时拒绝为另一个 key 启动；answer 和 decline 按 id 指向当前尝试的提示，遇到过期 id 会被拒绝；decline 会让尝试以 cancelled 结束，与信号被撤回时的结果一致；cancel 撤回当前正在运行的尝试。signOut 删除某个已注册流程为该 key 声明的存储记录，当前生效的提供方无法写入时会被拒绝。watch 先发送一次完整初始状态，随后发送完整状态变化；断开连接只停止观察，不取消尝试。

<a id="understand-the-implementation"></a>
## 理解实现

控制器向 authorization 和 credentials 两个种子转发操作，不维护独立状态，因此不发布 invariant。

<a id="further-exploration"></a>
## 深入探索

[凭证子系统](../../../docs/subsystems/credentials.zh.md)定义本控制器包装的授权与凭证存储接口；[架构](../../../docs/architecture.zh.md)说明应用组合。

<a id="model-experience"></a>
## 模型体验

无，因为授权凭证只影响 HTTP 与提供方认证，不进入模型提示、Session 日志或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本次提交仅搭建 Remote 接口：每个方法签名与失败代码均已确定，但每个方法体都抛出 `not implemented`。后续提交将实现对 `ctx.authorization` 和 `ctx.credentials` 的转发并补充测试覆盖。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
