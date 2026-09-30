# Peer Sessions

[English](peer-sessions.md) | 中文

实验性对等会话服务、其模型工具与挂载二者的可选 bundle 共享的类型。[对等会话 Agent Note](../../.agents/notes/implemented/feature/2026-09-29-peer-sessions.zh.md)负责信箱、分组与安全决策，[对等活动 Agent Note](../../.agents/notes/implemented/feature/2026-09-30-peer-activity.zh.md)负责活动决策；本页记录 [`packages/experimental/peer-sessions/src/types.ts`](../../packages/experimental/peer-sessions/src/types.ts) 与 [`repo.ts`](../../packages/experimental/peer-sessions/src/repo.ts) 中的持久与客户端可见形式。

## 对等身份

对等会话（peer session）是同一个 Harness home 下的另一个顶层会话。运行时根的头部来源不是 `subagent`、且委托深度为零的会话才是顶层会话，因此 subagent 既列不出对等会话，也不会被列为对等会话。

对等会话按仓库分组而非按精确工作目录分组：同一个检出目录的每个 worktree 属于同一组，任何检出目录之外的目录则各自成组。`peerRepoKey` 只用普通文件读取从磁盘上的 `.git` 标记派生该键，不启动 `git` 子进程：`.git` 目录按该检出目录的规范路径生成键，`.git` gitfile 按其 `gitdir` 行与可选的 `commondir` 指向的仓库生成键，而存在却不指向可用仓库的标记会终止这次向上查找。没有可用标记时，键为 `dir:` 加规范工作目录；`GIT_DIR` 被忽略，因为该键指向持有该会话自身目录的仓库。

`list(agent)` 读取 `$DSH_HOME/peers/presence/` 下的存在记录，保留仓库键与调用方相同的记录，去掉调用方自身，其余按名称、再按会话 id 排序。一条记录就是一个名为 `<sha256(sessionId)>.json` 的文件，在本进程观察到每次生命周期变化以及标题或审批变化时重写，并在 agent 被 dispose 时删除。读取方只有在记录中的 pid 以 `process.kill(pid, 0)` 探测返回 `ESRCH` 时才清除该记录，因此没有心跳、也没有时效阈值会把存活的会话从列表中移除。

`status` 是该会话 agent loop 的存活状态，由持有它的进程最后一次发布。`awaiting-user` 表示正在运行的轮次有未决的审批询问或进行中的 `user-questions/request`，它是存在记录的取值，而不是第三种 agent 状态。

```ts type-equiv
/** One other top-level session in the calling session's repository. */
interface PeerEntry {
  /** Discriminant reserved for later peer kinds; every current entry is a session. */
  readonly kind: 'session'
  /** Session identity to address in `send` and `notifyIdle`. */
  readonly id: SessionId
  /** Display name the session chose, or its session id while the log records no title. */
  readonly name: string
  /** Liveness of that session's agent loop. */
  readonly status: PeerStatus
  /** Working directory that session was created in, so the model sees which worktree it occupies. */
  readonly cwd: string
  /** Provider route of that session, when its agent options set one. */
  readonly provider?: string
  /** Model id of that session, when its agent options set one. */
  readonly model?: string
}
```

## 文件信箱

`send(agent, request)` 把一个信封提交到目标的分片 `$DSH_HOME/peers/mail/<sha256(targetId)>/`，写入锁只覆盖上限检查与该次写入。只有把目标作为实时 agent 持有的进程才会排空该分片：它重新应用顶层会话检查与仓库检查，发出 steer 并冲刷会话。不持有目标的进程只写入文件并返回 `queued`，因此不同进程中的对等会话无需共同的父进程即可协同，也不会恢复另一个进程的会话。

投递是对一条 `user/message` 调用 `Agent.steer()`，其 source 携带信封身份，随后冲刷该会话。只有当这次投递已落到目标日志中时，信封文件才会被删除；这一点由仅宿主侧的 `peerDelivery` 投影折叠已记录的 `user/message` 来证明，日志未记录的信封则留在磁盘上等待后续的排空轮次。一次排空轮次把它 steer 过的 id 记入按目标划分的进行中集合，因此并发的排空轮次会放过拼接尚未落盘的信封，而不是重复 steer 它。

当目标进入空闲时，日志未记录为已投递、且 inbox 已不再持有的每个进行中信封都会消耗一次尝试；第三次尝试会删除该信封，并记录一条写明 id 与原因的警告，因此对每一步都拒绝的目标每个进程最多被唤醒三次。其他被丢弃的文件——schema 校验失败、目标不是顶层对等会话、目标指向另一个会话、来自另一个仓库——都在同一轮次中被删除，并各记录一条绝不引用发送方正文的警告。

```ts type-equiv
/** One message to deliver to another top-level session. */
interface SendPeerMessageRequest {
  /** Target session id, or a name that matches exactly one peer in the caller's repository. */
  readonly to: string
  /** Complete message text; the target sees this and the harness frame around it, never the sender's transcript. */
  readonly message: string
}
```

```ts type-equiv
/** Outcome of one {@link SendPeerMessageRequest}. */
interface SendPeerMessageResult {
  /** Envelope identity, matched on the target's log by `source.messageId`. */
  readonly messageId: PeerMessageId
  /**
   * `delivered` when this process steered the message, `queued` while it waits
   * for a process holding a live target, `deferred` while a deferring target is
   * idle.
   */
  readonly status: 'delivered' | 'queued' | 'deferred'
}
```

`delivered` 表示本进程 steer 了该信封，`queued` 表示它在等待持有实时目标的进程，`deferred` 表示配置的 `peerInbound: 'deferred'` 在目标空闲期间暂存了它。`deferred` 是时序延迟而非审核步骤：目标下次运行时消息就进入模型上下文，接收方用户不会先批准它。

## 空闲订阅

`notifyIdle(agent, request)` 在 `$DSH_HOME/peers/watches/<sha256(targetId)>/<sha256(watcherId)>.json` 下为每个观察方与目标写一个订阅文件。被观察的进程在目标下一次进入空闲时向每个观察方自己的信箱入队一条通知信封，并删除它消费掉的每个订阅；被 dispose 或回收的目标只删除订阅而不发出通知，因此对等会话消失时观察方什么都收不到。在调用方当前轮次由空闲通知开启时请求订阅会被 `PEER_IDLE_TURN` 拒绝，因此一条通知无法开启一串订阅。

目标已经空闲时通知立即产生，并由调用方自己的进程投递，因为该信封落在调用方的分片中。`watching` 表示订阅已记录且尚无可发出的通知。

```ts type-equiv
/** One subscription to a peer's next idle transition. */
interface NotifyPeerIdleRequest {
  /** Target session id, or a name that matches exactly one peer in the caller's repository. */
  readonly to: string
}
```

```ts type-equiv
/** Outcome of one {@link NotifyPeerIdleRequest}. */
interface NotifyPeerIdleResult {
  /**
   * `watching` when this call added or found a subscription, `delivered` when
   * the target was already idle, `queued` while the notice waits for a process
   * holding the calling session.
   */
  readonly status: 'watching' | 'delivered' | 'queued'
}
```

<a id="activity"></a>
## 活动

每个有可用工作目录的顶层会话都发布一条活动记录，使在同一仓库中工作的对等会话可以避免互相覆盖对方的文件。该记录为 `$DSH_HOME/peers/activity/<sha256(sessionId)>.json`，与存在记录并列，包含仓库键、工作目录、检出根目录 `root`、作为 `name` 的标题、`status`、`doing`、`files`、pid，以及最近一次发布的时间。当状态、标题、审批询问、todo 列表或文件列表变化时，服务会重写该记录，并在 agent 被 dispose 时删除它。读取方会删除 pid 的 `process.kill(pid, 0)` 探测以 `ESRCH` 失败的记录，对校验失败的记录（包括另一个 `version` 写下的记录）则只跳过、不删除。

`doing` 是该会话自己写下的最新一份 `todo_write` 列表中的第一个 `in_progress` 条目，截断为 120 个字符。只有当 `write`、`edit` 或有修改作用的 `str_replace_editor` 调用报告成功时，路径才会进入 `files`，最新的在前，最多 `maxActivityFiles` 条。当本进程持有从 subagent 到其顶层祖先的每一级父会话，且未超出 subagent 的 header 所记录的 `delegationDepth` 时，subagent 的写入记在该顶层祖先名下。每个路径的键相对于检出根目录，为 `rel:`；位于根目录之外则为 `abs:`。

根目录由 `peerCheckout` 提供。它像 `peerRepoKey` 一样向上查找，`root` 是这次查找停下时所处、持有 `.git` 条目的目录，因此链接的 worktree 报告的是它自己的顶层；`dir:` 回退则报告规范化后的工作目录。以根目录而不是工作目录为基准生成键，使得在 `packages/x` 中启动的会话与在检出目录顶层启动的会话，为同一个文件记录同一个键。

```ts type-equiv
/** One working directory's checkout: the repository key that groups its peers, and the directory the walk stopped at. */
interface PeerCheckout {
  /** Repository key of the checkout; exactly what {@link peerRepoKey} returns for the same directory. */
  readonly key: string
  /**
   * Directory holding the `.git` entry the walk found: the checkout the working
   * directory belongs to, so a linked worktree reports its own top. Every `dir:`
   * fallback reports `canonicalCwd` instead, because a directory whose marker is
   * unusable is its own root.
   */
  readonly root: string
}
```

`activitySnapshot(agent, step)` 为某一步骤渲染调用方的对等会话。它列出调用方所在仓库中每个其他对等会话，只要其状态为 `running` 或 `awaiting-user`，或在 `activityTtlMs` 之内写过文件；排序为 `running`、`awaiting-user`、`idle`，最近发布的在前，最多 `maxActivityPeers` 个。检出根目录与调用方相同的对等会话标为 `shared`；另一个 worktree 中的对等会话以其根目录的最后一段命名。当 `overlap: 'warn'` 时，每个被列出的对等会话，只要写过调用方也写过或尝试写过的路径，`peer:activity` 区块之后就跟随一个针对它的 `peer:overlap` 段落。调用方的路径来自本进程随工具调用与结果到达而维护的列表，因此被文件工具拒绝的尝试写入也算数，记录发布仍在排队的写入则立即算数。

超过 `maxActivityBytes` 个 UTF-8 字节的区块会先从末尾丢弃对等会话，再丢弃最后一个对等会话的文件，最后丢弃其 `doing`，并带上 `"truncated":true`；若仍放不下，快照为空。每个由对等会话选定的字符串，即名称、`doing` 行或路径，无论出现在何处，都经过 JSON 编码，且 `<` 写作 `\u003c`，因此对等会话的文本无法关闭区块。

```ts type-equiv
/** One rendered activity snapshot of the caller's peers, ready to become a `peer-activity` message. */
interface PeerActivitySnapshot {
  /** The section texts joined by a blank line — the complete text of the message that carries the snapshot. */
  readonly text: string
  /** The named sections {@link PeerActivitySnapshot.text} assembles, in order. */
  readonly sections: readonly ContextSnapshotSection[]
  /** Session ids of the peers the block lists, in block order; the message carries them as {@link PeerActivitySource.peerIds}. */
  readonly peerIds: readonly SessionId[]
}
```

工具包把快照作为一条 `user/message` 追加到步骤中，其来源为 `PeerActivitySource`，循环随后将其写入日志。`peerIds` 指明所列出的对等会话，供之后步骤的比较使用，文本从不携带会话 id。该 kind 是限定为归属信息的 kind：未安装本包的构建仍可读取日志。

```ts type-equiv
/** Source of one activity snapshot this session was shown about its peers. */
interface PeerActivitySource {
  readonly kind: 'peer-activity'
  readonly form: 'snapshot'
  /** Named contributions in assembly order: the peer block, then one overlap warning per peer. */
  readonly sections: readonly ContextSnapshotSection[]
  /**
   * Session ids of the peers the block lists, in block order. The rendered text
   * never carries them: a later step compares them with the peers it would list
   * to tell whether one appeared since this message.
   */
  readonly peerIds: readonly SessionId[]
}
```

仅宿主侧使用的 `peerActivity` 投影把已记录的 `peer-activity` 消息折叠为最近一次的文本、其重叠文本，以及所列出的对等会话 id。在一个轮次的步骤 1，展示文本与上一条不同的快照。在之后的步骤，只有出现尚未警告过的重叠，或出现上一条消息没有列出的对等会话时，才展示快照。不带 `error` 的 `compaction/end` 事件会清除该投影，因为摘要在请求中取代了先前的消息；失败的压缩则保留它。快照从不开启轮次，工具包也不会把它追加到不产生模型调用的步骤。读不了 `peers/activity` 时，`activitySnapshot` 会记一条警告并不返回任何内容。

活动只是建议性的。没有任何工具在写入前查询记录，通过 Bash、格式化工具或其他进程做出的写入也不会发布。生成的[配置目录](../config-catalog.zh.md#deepseek-aidsh-experimental-peer-sessions)列出 `activityTtlMs`、`maxActivityFiles`、`maxActivityPeers`、`maxActivityBytes` 与 `overlap`。模型可见的文本及其开销由本包 [README](../../packages/experimental/peer-sessions/README.zh.md#model-experience) 负责。

## 中继上限与安全

中继深度记录本会话在整份日志中从每个对等会话收到过的最深中继层级；一次发送增加一跳，会超过 `PEER_RELAY_DEPTH_LIMIT`（四跳）的发送会被 `PEER_RELAY_LIMIT` 拒绝而不入队。当会话记录一条 source 类型为 `user` 的 `user/message` 时该预算重新开始，那是真人重新参与；调度、webhook、Team 或对等会话生产者都不会重置它。

对等消息不携带任何用户授权。harness 在发送方自己的文字之前为每次投递加上框架，说明发送方是本仓库中的另一个 agent 而非用户，并要求目标拒绝它自己工具已经拒绝的动作；发送方的文字永远无法改动这些行。授权读取调用会话的身份与仓库键，绝不读取显示名，因为对等会话自己选择显示名。

这里不锁定任何文件或 git 引用。信箱锁只串行化一个分片的上限检查与一次写入，此外什么也不锁，因此与从不宣告自身存在的对等会话之间的协同始终不会被强制执行。

## 可选 bundle

[`dsh-experimental-peer-sessions-profile`](../../packages/experimental/peer-sessions-profile/README.zh.md) 是官方挂载这两个包的方式，而交付的组合不挂载它：未在 profile 中启用它的会话不发布存在记录，也列不出任何对等会话。该 bundle 以随附的上限插入本服务与 [`dsh-experimental-tool-peer-sessions`](../../packages/experimental/tool-peer-sessions/README.zh.md)，生成的[配置目录](../config-catalog.zh.md#deepseek-aidsh-experimental-peer-sessions)则给出每个可接受字段及其 JSDoc。

## 已知限制

仓库分组需要可用的 `.git` 标记，因此 `.git` 符号链接、格式错误的 gitfile 或不可读的标记都会回退为 `dir:` 加精确目录，该会话也就不会与其检出目录的任何 worktree 分组。存在记录没有心跳，因此崩溃的对等会话可能一直留在列表中，直到其会话 id 被再次发布；在 Windows 上被回收的 pid 会保留陈旧记录，而其信件一直处于 `queued`。没有任何进程作为实时 agent 持有的会话，其信件会留在分片里，直到某个进程持有该会话，而轮询间隔只限制这段等待，不会丢失消息。活动只覆盖文件工具的写入，对等会话的记录可能落后一步。完整的限制清单由本包 [README](../../packages/experimental/peer-sessions/README.zh.md#known-limitations-and-deferred-work) 负责。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpeers--peerservice"></a>

### `ctx.peers` — `PeerService`

`ctx.peers`: peer discovery, messaging, and idle watches for the top-level sessions one Host process holds.

One instance owns the file provider for every live agent in that process; peers in other processes coordinate only through the mailbox files under the Harness home. Methods take the calling agent explicitly, so authorization follows the caller rather than ambient context.

```ts cordis-catalog
/**
 * List the caller's peers: other top-level sessions in its repository with
 * peer coordination enabled, ordered by name and then session id.
 * @param agent - calling agent, whose cached repository key selects the listed peers.
 * @returns one entry per listed peer, excluding the caller.
 * @throws {PeerError} `PEER_NOT_TOP_LEVEL` for a caller that is not a peer, `PEER_NO_CWD` for a caller with no usable directory.
 */
async list(agent: Agent): Promise<readonly PeerEntry[]>

/**
 * Send one message to a peer, queueing it durably when no process holds a
 * live target.
 * @param agent - calling agent; the message is attributed to its session.
 * @param request - target and complete message text.
 * @returns the envelope identity and how far delivery got.
 * @throws {PeerError} for an unresolved, ambiguous, unauthorized, oversized, or relay-limited send.
 */
async send(agent: Agent, request: SendPeerMessageRequest): Promise<SendPeerMessageResult>

/**
 * Subscribe once to a peer's next idle transition.
 * @param agent - calling agent, which receives the notice in its own mailbox.
 * @param request - target to watch.
 * @returns whether this call added a subscription, or a notice was already due.
 * @throws {PeerError} for an unresolved, unauthorized, full, or idle-turn-limited watch.
 */
async notifyIdle(agent: Agent, request: NotifyPeerIdleRequest): Promise<NotifyPeerIdleResult>

/**
 * Render what the caller's peers published, when this step has something new
 * to show.
 *
 * The block is data about other agents: it is not a user request and grants
 * no authority, which is what the header says in as many words. A session
 * that owns no activity row — a subagent, or one without a working directory
 * — publishes no row, has no dedupe state of its own, and so is shown
 * nothing.
 * @param agent - calling agent, whose repository and checkout scope the listed peers.
 * @param step - step number inside the open turn. Step 1 shows a block whose
 * text changed since the last one this session logged; a later step shows a
 * block only to warn about an overlap it has not warned about yet, or to list
 * a peer the last logged block did not list.
 * @returns the rendered block, its sections, and the ids of the peers it
 * lists, or `undefined` when no peer qualifies, when nothing fits the byte
 * cap, or when this step already saw what it would say.
 */
async activitySnapshot(agent: Agent, step: number): Promise<PeerActivitySnapshot | undefined>
```

Types: [Agent](core.zh.md)

Source: [`packages/experimental/peer-sessions/src/index.ts`](../../packages/experimental/peer-sessions/src/index.ts)
<!-- END GENERATED cordis-surface -->
