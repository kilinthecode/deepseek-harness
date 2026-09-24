# Memory

[English](memory.md) | 中文

持久记忆存储 [`@deepseek-ai/dsh-memory`](../../packages/memory/memory/README.zh.md) 与其工具消费者 [`@deepseek-ai/dsh-tool-memory`](../../packages/memory/tool-memory/README.zh.md) 共享的类型。[第一方持久记忆 Agent Note](../../.agents/notes/implemented/feature/2026-09-19-first-party-durable-memory.zh.md) 拥有设计决策；本页记录 [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts) 中精确的请求与结果类型，以及 [`src/domain.ts`](../../packages/memory/memory/src/domain.ts) 中的记录布局。

## 记录

一条记忆就是一条记录：匹配 `^[a-z0-9][a-z0-9-]{0,63}$` 的 `name`，取值为 `user`、`feedback`、`project` 或 `reference` 的 `type`，取值为 `global` 或 `project` 的 `scope`，最多 256 个字符的 `description`，不超过存储 `maxRecordBytes` 的 `content`，仅当作用域为 `project` 时存在、至多 32,767 个字符的 `projectRoot`，以及绝不会到达模型的 ISO-8601 UTC `createdAt` 与 `updatedAt` 日期时间。`MemoryName`（全局表的键）与 `ProjectMemoryKey`（`<project slug>__<name>`）是[品牌化 id](core.zh.md#branded-ids)。每个存储根据自己的 `maxRecordBytes` 构建 `memory` 存储 domain 规范；该 domain 以逐记录布局声明 `global` 与 `project` 两张表，对未通过 zod schema 的记录采用 `backup-and-skip`；在 JSON 后端上，每条记录是保存 `{ "version": 1, "record": … }` 的 `<root>/memory/<table>/<key>.json`。

## 请求与结果

```ts type-equiv
/** One write request; `cwd` locates the project for `scope: 'project'`. */
interface MemoryWriteRequest {
  /** Memory name matching {@link MEMORY_NAME_RE}; an existing name in the same scope is replaced. */
  readonly name: string
  readonly type: MemoryType
  readonly scope: MemoryScope
  /** One-line summary shown in the catalog; trimmed, at most {@link MEMORY_DESCRIPTION_MAX_CHARS}. */
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
/** Why a store operation was rejected. */
type MemoryErrorCode =
  | 'invalid-name'
  | 'invalid-description'
  | 'invalid-content'
  | 'over-cap'
  | 'project-root-unavailable'
  | 'not-found'
```

## 目录投影

`dsh-tool-memory` 注册 `memoryCatalog` 会话投影，其状态为 `{ lastCatalog: string | null }`：本插件最近一次注入的目录文本，由其自身 `snapshot` 形式、source kind 为 `tool-memory` 的 `user/message` 事件折叠而来，并在 `compaction/summary` 时重置为 `null`。`agent/pre-step` 监听器在投影值为 `null` 且存储有可见记录时，或某轮第一步渲染出与之不同的目录时注入；在目录已送达模型之后被清空的存储渲染为显式的空目录 `EMPTY_CATALOG_TEXT`。该决定读取投影以及存储当前的可见记录；每份注入的目录都是一条已记录的 `user/message`，因此回放可以从日志重建每个模型请求。

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
 * Insert or replace one record durably. Writes and forgets of one store run
 * one at a time in call order, from the project-root lookup to the durable
 * put, so overlapping calls never exceed the cap and a same-name overlap
 * reports `created` for the earlier call and keeps its `createdAt`. The cap
 * counts the records this process has loaded or written.
 * @param request - the memory to store.
 * @returns whether the record was created or updated, and the stored record.
 * @throws {@link MemoryError} for an invalid name, description, or content, a
 * project scope without a project root, or a cap reached in the target scope.
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
 * unavailable, or no such record exists in the scope.
 */
async forget(request: MemoryForgetRequest): Promise<void>
```

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
