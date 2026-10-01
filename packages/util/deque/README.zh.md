---
description: "供 Host 和浏览器包使用的环形双端队列，提供摊销常数时间的队列操作、已移除条目的即时释放和有界空闲存储。"
kind: "package-library"
---

# @deepseek-ai/dsh-deque

[English](README.md) | 中文

## 概述

`dsh-deque` 让 Host 和浏览器包可以排空长期存在的进程内队列，而无需在每次移除后移动所有剩余条目。调用方可以追加或前插条目，并以摊销常数时间从前端移除。双端队列负责条目顺序和后备存储释放；唤醒、失败、取消、容量和过载行为仍由各消费方负责。

`FrameQueue<T>` 把该存储与许多「多生产者对单读者」流交接反复实现的唤醒协议组合在一起：生产者推入，一个读者迭代，调用方一次性声明结束时是排空积压还是丢弃积压。唤醒、失败或取消行为不同的消费方保留各自的队列。

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

当条目可能在异步工作期间持续积累，且消费方需要 FIFO 移除、可选前插或显式清空队列时，使用 `Deque<T>`。如果有限本地工作列表的最大规模使头部移除成本无关紧要，它可以继续使用数组。

### 入口

导入双端队列，在尾部追加条目；当条目类型可能包含 `undefined` 时，在移除前检查 `size`：

```ts
import { Deque } from '@deepseek-ai/dsh-deque'

const frames = new Deque<string>()
frames.pushBack('first')
frames.pushFront('before-first')

while (frames.size > 0) {
  console.log(frames.popFront())
}
```

这些方法不施加队列限制，也不转换消费方失败。准确的 TypeScript 约定见 [`src/index.ts`](src/index.ts)。

### 交接给单个异步读者

当多个生产者入队、单个读者消费，且读者必须按需被唤醒而非轮询时，使用 `FrameQueue<T>`。构造时传入的排空策略是该类代调用方做出的唯一生命周期决定：`'drain'` 在队列结束前交付仍在排队的条目，`'discard'` 结束读者且不交付它们。

```ts
import { FrameQueue } from '@deepseek-ai/dsh-deque'

const frames = new FrameQueue<string>('drain')
const controller = new AbortController()

const reader = (async () => {
  for await (const frame of frames.iterate(controller.signal)) console.log(frame)
})()

frames.push('first')
frames.finish()
void reader
```

`finish()` 是幂等的，其后的 `push()` 会丢弃条目。中止迭代的信号会结束队列并移除该迭代安装的监听器。队列会保留条目直到读者移除它们；容量与过载策略仍由调用方负责。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

双端队列把条目存入环形数组。移除条目会立即清空对应槽位；按几何级数扩容并在四分之一满时缩容，使复制工作保持摊销常数时间，并防止头游标保留持续增长的空闲存储。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 环形双端队列操作、后备存储生命周期，以及 `FrameQueue` 唤醒协议 |
| — | 不发布运行时不变式伴生入口；这个集合不拥有事件流或共享可变状态，其顺序与存储生命周期由单元测试覆盖。 |
| [`tests/deque.spec.ts`](tests/deque.spec.ts) | FIFO、前插、环绕、扩容、压缩（compaction）、清空和复用覆盖 |
| [`tests/frame-queue.spec.ts`](tests/frame-queue.spec.ts) | 唤醒交付、finish 幂等性、两种排空策略与中止覆盖 |
| [`benchmarks/drain.ts`](benchmarks/drain.ts) | 随队列规模增长的可复现 backlog 排空计时 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包映射](../README.zh.md)——跨包组共享的其他零依赖原语。
- [线性流队列决策](../../../.agents/notes/archived/bug-fix/2026-08-28-linear-stream-queue-drain.md)——生产流为何使用本双端队列而非数组头部移除。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这个进程内集合不注册任何面向模型的内容。

#### KV Cache 影响

这里的内容不会进入模型请求，因此不影响提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有容量策略**——双端队列不会限制、合并或拒绝条目；每个消费方必须定义适合其流的过载行为。
- **每个 `FrameQueue` 只服务一个读者**——唤醒协议只释放条目到达时正在等待的那个读者，因此并发读者会竞争条目。请为每个读者使用各自的队列，并把共享背压保留在该类之外。
- **排空策略在构造时固定**——需要观察积压的队列与拆除后不再交付的队列仅由该参数区分；之后不再支持更改。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
