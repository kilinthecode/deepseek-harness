# Memory

[English](memory.md) | 中文

持久记忆存储 [`@deepseek-ai/dsh-memory`](../../packages/memory/memory/README.zh.md) 与其工具消费者 [`@deepseek-ai/dsh-tool-memory`](../../packages/memory/tool-memory/README.zh.md) 共享的类型。[第一方持久记忆 Agent Note](../../.agents/notes/implemented/feature/2026-09-19-first-party-durable-memory.zh.md) 负责存储与工具拆分；[冻结快照与回顾说明](../../.agents/notes/implemented/feature/2026-09-25-frozen-memory-snapshot-and-review.zh.md) 负责冻结、扫描和回顾 fork。本页记录 [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts) 中精确的请求与结果类型，以及 [`src/domain.ts`](../../packages/memory/memory/src/domain.ts) 中的记录布局。`scanMemoryText` 与 `MemoryStore.scan` 位于 [`src/scan.ts`](../../packages/memory/memory/src/scan.ts)；当该服务 JSDoc 变更时，下方生成的 Cordis API 区块由操作方重新生成。

## 记录

一条记忆就是一条记录：匹配 `^[a-z0-9][a-z0-9-]{0,63}$` 的 `name`，取值为 `user`、`feedback`、`project` 或 `reference` 的 `type`，取值为 `global` 或 `project` 的 `scope`，最多 256 个字符的 `description`（写入要求单行：U+000A、U+000D、U+2028 和 U+2029 以 `invalid-description` 失败；持久 zod schema 不拒绝这些换行，因此手工编辑的多行文件仍会加载），不超过存储 `maxRecordBytes` 的 `content`，仅当作用域为 `project` 时存在、至多 32,767 个字符的 `projectRoot`，以及绝不会到达模型的 ISO-8601 UTC `createdAt` 与 `updatedAt` 日期时间。`write` 在序列化之前用 `scanMemoryText` 先扫描描述再扫描内容；发现为 `blocked-content`。快照和回忆把扫描发现渲染为 `[blocked]`，并且不把文件改名为 `.bak`。

## 请求与结果

```ts type-equiv
/** One write request; `cwd` locates the project for `scope: 'project'`. */
interface MemoryWriteRequest {
  /** Memory name matching {@link MEMORY_NAME_RE}; an existing name in the same scope is replaced. */
  readonly name: string
  readonly type: MemoryType
  readonly scope: MemoryScope
  /** One-line summary shown in the catalog; trimmed, 1 to 256 characters, no U+000A, U+000D, U+2028, or U+2029. */
  readonly description: string
  /** The memory body; trimmed, at most `maxRecordBytes` UTF-8 bytes. */
  readonly content: string
  /** Session working directory, when the session has one. */
  readonly cwd?: string | undefined
}
```

```ts type-equiv
/** Outcome of one write. */
interface MemoryWriteResult {
  /** Whether the name was new in its scope or replaced an existing record. */
  readonly outcome: 'created' | 'updated'
  /** The record as stored. */
  readonly record: MemoryRecord
}
```

```ts type-equiv
/** One recall request over the records visible from `cwd`. */
interface MemoryRecallRequest {
  /** Case-insensitive substring matched against name, description, and content; blank matches everything. */
  readonly query?: string | undefined
  /** Maximum records returned. */
  readonly limit: number
  /** Session working directory, when the session has one. */
  readonly cwd?: string | undefined
}
```

```ts type-equiv
/** One forget request. */
interface MemoryForgetRequest {
  readonly name: string
  readonly scope: MemoryScope
  /** Session working directory, when the session has one. */
  readonly cwd?: string | undefined
}
```

```ts type-equiv
/** The records visible from one working directory, in stored order. */
interface MemoryVisible {
  /** Every global record. */
  readonly global: readonly MemoryRecord[]
  /** The current project's records, absent when no project root resolves. */
  readonly project?: {
    readonly root: string
    readonly records: readonly MemoryRecord[]
  }
}
```

每次拒绝都是 `MemoryError`，其 `code` 说明原因，其消息面向模型书写。

```ts type-equiv
/**
 * Why a store operation was rejected.
 * `blocked-content` is a write-time scan finding; `project-key-collision`
 * means this project's key already holds another project's record.
 */
type MemoryErrorCode =
  | 'invalid-name'
  | 'invalid-description'
  | 'invalid-content'
  | 'over-cap'
  | 'blocked-content'
  | 'project-key-collision'
  | 'project-root-unavailable'
  | 'not-found'
```

## 目录投影

`dsh-tool-memory` 注册 `memoryCatalog` 会话投影，`stateVersion: 2`，状态为 `{ taken: boolean }`，`init: () => ({ taken: false })`。它将 `step/start` 折叠为 `{ taken: true }`，将本插件自身 `source.kind === 'tool-memory'` 且 `form === 'snapshot'` 的 `user/message` 折叠为 `{ taken: true }`，将 `compaction/summary` 折叠为 `{ taken: false }`。前置的 `agent/pre-step` 监听器先 `await next()`，然后在 `taken` 为 false 时每个 surface generation 至多注入一次：它通过 `renderSnapshot` 和 `MemoryStore.scan` 渲染 `visible(cwd)`，并在已认领的用户批次之后追加一条带 source 的 `user/message`。该第一步时为空的存储不注入。每份注入的快照都是一条已记录的 `user/message`，因此回放可以从日志重建每个模型请求。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memorystore"></a>

### `ctx.memory` — `MemoryStore`

The memory store. Opening the domain happens during service init, so every consumer that injects `memory` sees an open store; the domain closes with this service's fiber.

```ts cordis-catalog
/**
 * Resolve the project root of one working directory.
 * @param cwd - session working directory; `undefined` when the session has none.
 * @returns the absolute root, or `undefined` when there is no cwd or no marker above it.
 */
async resolveProjectRoot(cwd: string | undefined): Promise<string | undefined>

/**
 * Every record visible from one working directory: all global records plus
 * the current project's records when a root resolves.
 * @param cwd - session working directory, when the session has one.
 * @returns the visible records in stored order.
 */
async visible(cwd: string | undefined): Promise<MemoryVisible>

/**
 * Scan one memory description or body using the store's fixed threat checks.
 * @param text - raw description or content.
 * @returns the first finding, or `undefined` when the text is allowed.
 */
scan(text: string): MemoryScanFinding | undefined

/**
 * Insert or replace one record durably. Writes and forgets of one store run
 * one at a time in call order, from the project-root lookup to the durable
 * put, so overlapping calls never exceed the cap and a same-name overlap
 * reports `created` for the earlier call and keeps its `createdAt`. The cap
 * counts the records this process has loaded or written.
 * @param request - the memory to store.
 * @returns whether the record was created or updated, and the stored record.
 * @throws {@link MemoryError} for an invalid name, description, or content,
 * blocked description or content, a project scope without a project root, a
 * project key occupied by another project's record, or a cap reached in the
 * target scope.
 */
async write(request: MemoryWriteRequest): Promise<MemoryWriteResult>

/**
 * Find visible records by substring, newest first, then by name, then with
 * `global` before `project`. A request without a resolvable project root
 * searches the global records only.
 * @param request - query, result cap, and working directory.
 * @returns at most `limit` matching records.
 */
async recall(request: MemoryRecallRequest): Promise<MemoryRecord[]>

/**
 * Delete one record durably, in the same one-at-a-time call order as writes.
 * @param request - name, scope, and working directory.
 * @throws {@link MemoryError} when the name is invalid, the project root is
 * unavailable, no such record exists in the scope, or a project key is
 * occupied by another project's record.
 */
async forget(request: MemoryForgetRequest): Promise<void>
```

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
