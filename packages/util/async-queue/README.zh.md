---
description: "面向异步迭代消费方的同步生产者缓冲交接：push 条目、按序 take，并在 wait() 中停驻，直到条目到达或队列结束。"
kind: "package-library"
---

# @deepseek-ai/dsh-async-queue

[English](README.md) | 中文

## 概述

`dsh-async-queue` 让同步生产者把值交给唯一的异步消费方，而无需轮询。生产者调用 `push()`，消费方用 `take()` 取走已缓冲的条目，或用 `wait()` 停驻，直到条目到达或 `end()` 结束队列。本包负责条目顺序、唤醒停驻的消费方，以及结束之后拒绝 push；迭代循环、取消，以及已投递条目的含义仍由各消费方负责。`dsh-api-session-controller` 和 `dsh-experimental-agent-team` 用它支撑各自的实时流。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

当同步代码为唯一等待条目的消费方生产条目，而轮询或事件发射器要么浪费工作、要么丢失顺序时，使用 `AsyncQueue<T>`。已经通过 Cordis 服务或 `SessionEventMap` 订阅接收条目的消费方保留原有路径；本队列用于单进程内的直接交接。

### 入口

导入队列，由生产者 push 条目，在消费方交替调用 `take()` 与 `wait()`：

```ts
import { AsyncQueue } from '@deepseek-ai/dsh-async-queue'

const queue = new AsyncQueue<string>()
const consume = (async () => {
  for (;;) {
    const entry = queue.take()
    if (entry !== undefined) {
      console.log(entry)
      continue
    }
    if (queue.finished) return
    await queue.wait()
  }
})()

queue.push('first')
queue.end()
await consume
```

`end()` 之后的 `push()` 会被拒绝，而 `take()` 仍会返回结束前缓冲的条目，因此上面的循环会先排空这些条目，再观察到 `finished`。这些方法既不限制缓冲区大小，也不转换消费方失败。准确的 TypeScript 约定见 [`src/index.ts`](src/index.ts)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

队列用数组加已消费头游标保存缓冲条目：`take()` 会清空它移除的槽位，缓冲排空后重置为空数组，因此不会累积保留引用。`push()` 与 `end()` 通过同一次交接唤醒唯一的停驻消费方。

这个类刻意止步于交接本身，把迭代循环留给各消费方，因为各消费方对“队列已结束”的理解不同。`@deepseek-ai/dsh-api-session-controller` 中的 `ControlQueue` 会排空结束前缓冲的帧，因为 dispose 不能丢弃已提交的控制状态。`@deepseek-ai/dsh-experimental-agent-team` 中房间流的 `iterateFrames` 在结束后不再投递任何内容，因为 dispose 会先结束其 reader，之后 listener 才停止。取消同理保留在本地：结束各自循环的 `AbortSignal` 由各消费方持有。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 缓冲交接、唤醒停驻的消费方，以及结束状态 |
| — | 不发布运行时不变式伴生入口；这次交接除了自身缓冲区外不拥有可独立观测的关系，顺序、唤醒和结束后的拒绝由单元测试覆盖。 |
| [`tests/async-queue.spec.ts`](tests/async-queue.spec.ts) | 顺序、空缓冲与补充缓冲、停驻等待与立即等待、幂等 `end()`，以及被拒绝的 push |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包映射](../README.zh.md)——跨包组共享的其他零依赖原语。
- [跨包值依赖](../../../.agents/notes/archived/process/2026-08-23-client-cross-package-value-dependencies.md)——把这次交接从两个调用方中抽取出来的抽取策略。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这个进程内交接不注册任何面向模型的内容。

#### KV Cache 影响

这里的内容不会进入模型请求，因此不影响提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每个队列一个消费方**——`wait()` 只保存一个停驻 resolver，因此第二个并发消费方会让第一个永久停驻；需要扇出的消费方为每个 reader 各建一个队列。
- **没有容量策略**——队列不会限制、合并或拒绝条目，生产快于消费时缓冲区会增长；每个消费方必须定义适合其流的过载行为。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
