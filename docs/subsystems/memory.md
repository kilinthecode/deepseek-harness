# Memory

English | [中文](memory.zh.md)

Types shared by the durable memory store [`@deepseek-ai/dsh-memory`](../../packages/memory/memory/README.md) and its tool consumer [`@deepseek-ai/dsh-tool-memory`](../../packages/memory/tool-memory/README.md). The [first-party durable memory Agent Note](../../.agents/notes/implemented/feature/2026-09-19-first-party-durable-memory.md) owns the design decisions; this page records the exact request and result types from [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts) and the record layout from [`src/domain.ts`](../../packages/memory/memory/src/domain.ts).

## Records

One memory is one record: a `name` matching `^[a-z0-9][a-z0-9-]{0,63}$`, a `type` of `user`, `feedback`, `project`, or `reference`, a `scope` of `global` or `project`, a `description` of at most 256 characters, the `content` within the store's `maxRecordBytes`, a `projectRoot` of at most 32,767 characters present exactly when the scope is `project`, and ISO-8601 UTC `createdAt` and `updatedAt` date-times that never reach the model. `MemoryName` (the global-table key) and `ProjectMemoryKey` (`<project slug>__<name>`) are [branded ids](core.md#branded-ids). Each store builds its `memory` storage domain spec from its `maxRecordBytes`; the domain declares a `global` and a `project` table in the per-record layout with `backup-and-skip` for records that fail the zod schema; on the JSON backend each record is `<root>/memory/<table>/<key>.json` holding `{ "version": 1, "record": … }`.

## Requests and results

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

Every rejection is a `MemoryError` whose `code` names the reason and whose message is written for the model.

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

## Catalog projection

`dsh-tool-memory` registers the `memoryCatalog` session projection, whose state is `{ lastCatalog: string | null }`: the text of this plugin's latest injected catalog, folded from its own `snapshot`-form `user/message` events, which carry the `tool-memory` source kind, and reset to `null` by `compaction/summary`. The `agent/pre-step` listener injects when the projected value is `null` and the store has visible records, or when a turn's first step renders a catalog that differs from it; a store emptied after a catalog reached the model renders as the explicit empty catalog `EMPTY_CATALOG_TEXT`. The decision reads the projection and the store's current visible records; every injected catalog is a logged `user/message`, so replay rebuilds each model request from the log.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
