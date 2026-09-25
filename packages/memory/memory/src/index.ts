/**
 * Durable agent memory (`ctx.memory`): cross-session `user`, `feedback`,
 * `project`, and `reference` records kept as one JSON document each under
 * the `memory` storage domain. The store owns validation, the per-scope
 * record caps, and project-root resolution; model-facing tools and the
 * catalog injection live in `@deepseek-ai/dsh-tool-memory`.
 * @module @deepseek-ai/dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  MEMORY_DESCRIPTION_MAX_CHARS,
  MEMORY_NAME_RE,
  MEMORY_SCOPES,
  compareStoredText,
  memoryDomainSpec,
} from './domain.ts'
import type { MemoryDomainSpec, MemoryName, MemoryRecord, MemoryScope, MemoryType, ProjectMemoryKey } from './domain.ts'
import { findProjectRoot, projectMemoryKey } from './project.ts'
import { scanMemoryText } from './scan.ts'
import type { MemoryScanFinding } from './scan.ts'

export {
  MEMORY_DESCRIPTION_MAX_CHARS,
  MEMORY_NAME_RE,
  MEMORY_PROJECT_ROOT_MAX_CHARS,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  compareStoredText,
  memoryDomainSpec,
  memoryRecordSchema,
} from './domain.ts'
export type { MemoryDomainSpec, MemoryName, MemoryRecord, MemoryScope, MemoryType, ProjectMemoryKey } from './domain.ts'
export { findProjectRoot, projectMemoryKey, projectSlug } from './project.ts'
export { MEMORY_THREAT_PATTERNS, scanMemoryText } from './scan.ts'
export type { MemoryScanFinding } from './scan.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryStore
  }
}

/** Project-root markers when a composition names none; mirrors the `agent-instructions` default. */
const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const

/** Store configuration. Invalid values fail plugin load. */
export interface Config {
  /**
   * Cap on records in the global scope and, separately, in each project. A
   * write that would exceed it fails so the agent curates with `forget`. The
   * count covers the records this process has loaded or written.
   */
  maxRecords: number
  /**
   * UTF-8 byte cap on one record's `content`, checked on every write and on
   * every stored record when the store opens; a stored record over the cap is
   * backed up and skipped.
   */
  maxRecordBytes: number
  /**
   * Directory entries that identify a project root while walking upward from
   * the session working directory. Mirrors the `agent-instructions` default so
   * both plugins agree on what the project is. Omitted in a composition, the
   * schemastery field default is `['.git']`; an explicit empty list stays empty.
   */
  projectRootMarkers?: string[]
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxRecords: z.number().step(1).min(1).required(),
  maxRecordBytes: z.number().step(1).min(1).required(),
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
})

/**
 * Why a store operation was rejected.
 * `blocked-content` is a write-time scan finding; `project-key-collision`
 * means this project's key already holds another project's record.
 */
export type MemoryErrorCode =
  | 'invalid-name'
  | 'invalid-description'
  | 'invalid-content'
  | 'over-cap'
  | 'blocked-content'
  | 'project-key-collision'
  | 'project-root-unavailable'
  | 'not-found'

/** A rejected store operation; `message` is stable, model-readable text. */
export class MemoryError extends Error {
  /**
   * @param code - machine-readable rejection reason.
   * @param message - human- and model-readable explanation.
   */
  constructor(readonly code: MemoryErrorCode, message: string) {
    super(message)
    this.name = 'MemoryError'
  }
}

/** One write request; `cwd` locates the project for `scope: 'project'`. */
export interface MemoryWriteRequest {
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

/** Outcome of one write. */
export interface MemoryWriteResult {
  /** Whether the name was new in its scope or replaced an existing record. */
  readonly outcome: 'created' | 'updated'
  /** The record as stored. */
  readonly record: MemoryRecord
}

/** One recall request over the records visible from `cwd`. */
export interface MemoryRecallRequest {
  /** Case-insensitive substring matched against name, description, and content; blank matches everything. */
  readonly query?: string | undefined
  /** Maximum records returned. */
  readonly limit: number
  /** Session working directory, when the session has one. */
  readonly cwd?: string | undefined
}

/** One forget request. */
export interface MemoryForgetRequest {
  readonly name: string
  readonly scope: MemoryScope
  /** Session working directory, when the session has one. */
  readonly cwd?: string | undefined
}

/** The records visible from one working directory, in stored order. */
export interface MemoryVisible {
  /** Every global record. */
  readonly global: readonly MemoryRecord[]
  /** The current project's records, absent when no project root resolves. */
  readonly project?: {
    readonly root: string
    readonly records: readonly MemoryRecord[]
  }
}

const SCOPE_RANK = Object.fromEntries(MEMORY_SCOPES.map((scope, index) => [scope, index])) as Record<MemoryScope, number>

/**
 * Total order of recall results: newest first, then name, then scope
 * (`global` before `project`), each compared by code unit.
 */
function newestFirst(left: MemoryRecord, right: MemoryRecord): number {
  return compareStoredText(right.updatedAt, left.updatedAt)
    || compareStoredText(left.name, right.name)
    || SCOPE_RANK[left.scope] - SCOPE_RANK[right.scope]
}

const noop = (): void => {}

/**
 * The memory store. Opening the domain happens during service init, so every
 * consumer that injects `memory` sees an open store; the domain closes with
 * this service's fiber.
 */
export class MemoryStore extends Service {
  static inject = ['storageDomain']
  static Config = Config

  private domain?: Domain<MemoryDomainSpec>
  private readonly maxRecords: number
  private readonly maxRecordBytes: number
  private readonly markers: readonly string[]
  /** Tail of the store's single writer section; every link settles, so one rejected write never blocks the next. */
  private writes: Promise<void> = Promise.resolve()

  /**
   * @param ctx - owning context; the domain handle closes with it.
   * @param config - validated store configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'memory')
    this.maxRecords = config.maxRecords
    this.maxRecordBytes = config.maxRecordBytes
    this.markers = config.projectRootMarkers ?? []
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(memoryDomainSpec(this.maxRecordBytes))
    this.ctx.effect(() => () => domain.close(), 'memory.domainClose')
    this.domain = domain
  }

  /**
   * Run one mutation after every earlier write and forget of this store has
   * settled, so mutations run in call order and each one's project-root
   * lookup, existence check, and capacity check see the committed results of
   * the earlier calls.
   */
  private serialized<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(mutation)
    this.writes = result.then(noop, noop)
    return result
  }

  private requireDomain(): Domain<MemoryDomainSpec> {
    if (this.domain === undefined) throw new Error('memory store is not open')
    return this.domain
  }

  private globalTable(): KvTable<MemoryName, MemoryRecord> {
    return this.requireDomain().table('global')
  }

  private projectTable(): KvTable<ProjectMemoryKey, MemoryRecord> {
    return this.requireDomain().table('project')
  }

  /**
   * Resolve the project root of one working directory.
   * @param cwd - session working directory; `undefined` when the session has none.
   * @returns the absolute root, or `undefined` when there is no cwd or no marker above it.
   */
  async resolveProjectRoot(cwd: string | undefined): Promise<string | undefined> {
    if (cwd === undefined) return undefined
    return findProjectRoot(cwd, this.markers)
  }

  private async requireProjectRoot(cwd: string | undefined): Promise<string> {
    const root = await this.resolveProjectRoot(cwd)
    if (root === undefined) {
      throw new MemoryError(
        'project-root-unavailable',
        `project scope is unavailable: the session has no working directory inside a project (no ${this.markers.join(' or ')} above it); use scope "global"`,
      )
    }
    return root
  }

  private projectRecords(root: string): MemoryRecord[] {
    const records: MemoryRecord[] = []
    for (const [, record] of this.projectTable().entries()) {
      if (record.projectRoot === root) records.push(record)
    }
    return records
  }

  /**
   * Every record visible from one working directory: all global records plus
   * the current project's records when a root resolves.
   * @param cwd - session working directory, when the session has one.
   * @returns the visible records in stored order.
   */
  async visible(cwd: string | undefined): Promise<MemoryVisible> {
    const global = [...this.globalTable().entries()].map(([, record]) => record)
    const root = await this.resolveProjectRoot(cwd)
    if (root === undefined) return { global }
    return { global, project: { root, records: this.projectRecords(root) } }
  }

  /**
   * Scan one memory description or body using the store's fixed threat checks.
   * @param text - raw description or content.
   * @returns the first finding, or `undefined` when the text is allowed.
   */
  scan(text: string): MemoryScanFinding | undefined {
    return scanMemoryText(text)
  }

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
  async write(request: MemoryWriteRequest): Promise<MemoryWriteResult> {
    const name = validateName(request.name)
    const description = request.description.trim()
    if (
      description.length === 0
      || description.length > MEMORY_DESCRIPTION_MAX_CHARS
      || /[\n\r\u2028\u2029]/.test(description)
    ) {
      throw new MemoryError(
        'invalid-description',
        'description must be a single line of 1 to 256 characters after trimming',
      )
    }
    const content = request.content.trim()
    if (content.length === 0) throw new MemoryError('invalid-content', 'content must not be empty')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.maxRecordBytes) {
      throw new MemoryError('invalid-content', `content is ${bytes} UTF-8 bytes; the cap is ${this.maxRecordBytes}`)
    }
    const blocked = this.scan(description) ?? this.scan(content)
    if (blocked !== undefined) throw new MemoryError('blocked-content', blocked.message)
    switch (request.scope) {
      case 'global': {
        const table = this.globalTable()
        return this.serialized(async () => {
          const existing = table.get(name)
          this.assertCapacity(existing, table.size, 'global')
          const now = new Date().toISOString()
          const record: MemoryRecord = {
            name, type: request.type, scope: 'global', description, content,
            createdAt: existing?.createdAt ?? now, updatedAt: now,
          }
          await table.put(name, record)
          return { outcome: existing === undefined ? 'created' : 'updated', record }
        })
      }
      case 'project': {
        const table = this.projectTable()
        return this.serialized(async () => {
          const root = await this.requireProjectRoot(request.cwd)
          const key = projectMemoryKey(root, name)
          const existing = table.get(key)
          this.assertProjectKeyOwner(existing, root, name, 'write')
          this.assertCapacity(existing, this.projectRecords(root).length, 'project')
          const now = new Date().toISOString()
          const record: MemoryRecord = {
            name, type: request.type, scope: 'project', description, content, projectRoot: root,
            createdAt: existing?.createdAt ?? now, updatedAt: now,
          }
          await table.put(key, record)
          return { outcome: existing === undefined ? 'created' : 'updated', record }
        })
      }
      /* v8 ignore next 2 -- MemoryScope is closed; the tool schema enum rejects other scopes */
      default:
        return assertNever(request.scope)
    }
  }

  private assertProjectKeyOwner(
    existing: MemoryRecord | undefined,
    root: string,
    name: MemoryName,
    action: 'write' | 'forget',
  ): void {
    if (existing !== undefined && existing.projectRoot !== root) {
      throw new MemoryError(
        'project-key-collision',
        action === 'write'
          ? `cannot write project memory "${name}": another project's record already occupies this key`
          : `cannot forget project memory "${name}": another project's record occupies this key`,
      )
    }
  }

  private assertCapacity(existing: MemoryRecord | undefined, count: number, scopeLabel: string): void {
    if (existing === undefined && count >= this.maxRecords) {
      throw new MemoryError(
        'over-cap',
        `the ${scopeLabel} scope already holds ${count} memories (cap ${this.maxRecords}); forget one before writing`,
      )
    }
  }

  /**
   * Find visible records by substring, newest first, then by name, then with
   * `global` before `project`. A request without a resolvable project root
   * searches the global records only.
   * @param request - query, result cap, and working directory.
   * @returns at most `limit` matching records.
   */
  async recall(request: MemoryRecallRequest): Promise<MemoryRecord[]> {
    const visible = await this.visible(request.cwd)
    const query = (request.query ?? '').trim().toLowerCase()
    const candidates = [...visible.global, ...visible.project?.records ?? []]
    const matches = query.length === 0
      ? candidates
      : candidates.filter(record =>
        record.name.includes(query)
        || record.description.toLowerCase().includes(query)
        || record.content.toLowerCase().includes(query))
    return matches.sort(newestFirst).slice(0, Math.max(0, request.limit))
  }

  /**
   * Delete one record durably, in the same one-at-a-time call order as writes.
   * @param request - name, scope, and working directory.
   * @throws {@link MemoryError} when the name is invalid, the project root is
   * unavailable, no such record exists in the scope, or a project key is
   * occupied by another project's record.
   */
  async forget(request: MemoryForgetRequest): Promise<void> {
    const name = validateName(request.name)
    switch (request.scope) {
      case 'global': {
        const table = this.globalTable()
        return this.serialized(async () => {
          if (!await table.delete(name)) throw notFound(name, 'global')
        })
      }
      case 'project': {
        const table = this.projectTable()
        return this.serialized(async () => {
          const root = await this.requireProjectRoot(request.cwd)
          const key = projectMemoryKey(root, name)
          this.assertProjectKeyOwner(table.get(key), root, name, 'forget')
          if (!await table.delete(key)) throw notFound(name, 'project')
        })
      }
      /* v8 ignore next 2 -- MemoryScope is closed; the tool schema enum rejects other scopes */
      default:
        return assertNever(request.scope)
    }
  }
}

function validateName(name: string): MemoryName {
  if (!MEMORY_NAME_RE.test(name)) {
    throw new MemoryError('invalid-name', `name must match ${MEMORY_NAME_RE} (lowercase kebab-case, 1 to 64 characters)`)
  }
  return name as MemoryName
}

function notFound(name: MemoryName, scope: MemoryScope): MemoryError {
  return new MemoryError('not-found', `no ${scope} memory named "${name}"`)
}

/* v8 ignore next 3 -- closed-union backstop; unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new Error(`unreachable memory scope: ${String(value)}`)
}

export default MemoryStore
