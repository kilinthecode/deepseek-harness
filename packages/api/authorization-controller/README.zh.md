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

authorization 命名空间在 `ctx.authorization` 和 `ctx.credentials` 之上提供 getState、start、answer、decline、cancel、signOut 和 watch。

getState 返回每个已注册的流程以及控制器自己的尝试。流程带有 key、label、methods 与 `inFlight`（其他界面启动的尝试同样为 true），并与 `ctx.credentials.describeRecord` 提供的 `configured` 和 `writable` 合并，使界面无需读取凭证即可启用登录或退出登录。尝试带有其 key、正在运行的方法、所处阶段、最新通知、当前阻塞它的问题，以及失败后的简短失败代码。任何方法都不返回凭证负载：视图由 `list()`、`describeRecord()` 和流程自身的通知与提示构建，而用户输入的答案只单向地从界面流入流程。

控制器同一时间只拥有一个正在进行的尝试：start 为某个凭证 key 占用该槽位，在已有尝试运行时拒绝为另一个 key 启动；answer 和 decline 按 id 指向当前尝试的提示；decline 会让尝试以 cancelled 结束，与信号被撤回时的结果一致；cancel 撤回当前正在运行的尝试。decline 和 cancel 在投递拒绝或撤回后立即返回，不等待流程结算，因此仍在运行的流程无法一直占住 Remote 调用；尝试的终态通过 watch 到达。signOut 删除某个已注册流程为该 key 声明的存储记录，并先取消该 key 上正在进行的尝试；对于没有流程声明的 key，或当前生效的提供方无法写入的记录，都会被拒绝。watch 先发送一次完整初始状态，随后发送完整状态变化，并且对信号已经中止的流也会先发送这一次当前状态；断开连接只停止观察，不取消尝试。

尝试经历 `starting`、`running` 和 `prompting`，并以唯一一个终态结束：流程提交记录后的 `authorized`、人工拒绝或调用方撤回后的 `cancelled`，或 `failed`。只有尝试当前的提示可以被回答：过期的提示 id，以及不在该提示所给选项之内的 `select` 取值，都会以 `authorization/stale-prompt` 被拒绝。流程通过自身信号撤回的问题不会影响尝试继续运行；只有整个请求才会以 `cancelled` 结束。

被取消、被替换或控制器被释放的尝试，会以普通错误——而非 decline——拒绝它当前停留的问题；只有人才会 decline。它还会挡开已不再属于它的流程的后续回调，因此不会有界面拿到无人能回答的问题。

失败使用本命名空间的代码：`authorization/no-flow`、`authorization/unknown-method`、`authorization/already-in-flight`、`authorization/not-committed`、`authorization/stale-prompt` 和 `authorization/read-only`。不符合 `<scope>/<id>` 凭证 key 语法的 key 会以载体自身的 `gateway/bad-request` 被拒绝，因为任何流程都不可能声明它。失败的尝试会发布一个简短代码来指明失败原因——种子失败若属于本命名空间声明的代码则使用该代码，否则使用失败自身的代码——绝不发布提供方文本或私密值。

<a id="understand-the-implementation"></a>
## 理解实现

控制器向 authorization 和 credentials 两个种子转发操作，并拥有一个尝试、它当前停留的提示以及它所通知的观察者；因此不发布 invariant。

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

- 尝试无法跨越 Host 重启，也没有界面能加入其他界面已启动的尝试：授权种子对每个 key 只允许一个尝试，因此对已经在授权的 key 调用 start 会让本控制器的尝试以 `authorization/already-in-flight` 变为 `failed`，而流程列表会报告 `inFlight`。
- 重新连接的界面通过 watch 恢复状态，但错过的提问不会被重放：它看到的提示是尝试当前停留的那一个。
- decline 和 cancel 在流程结算前就返回，因此尝试可能短暂报告 `running` 且没有停留的提示：在这段窗口内再次对同一 key 调用 start 读到的是正在撤回的尝试而非新尝试，其终态通过 watch 到达。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
