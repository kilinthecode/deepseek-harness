/**
 * Durable agent memory (`ctx.memory`): cross-session `user`, `feedback`,
 * `project`, and `reference` records kept as one JSON document each under
 * the `memory` storage domain. The store owns validation, the per-scope
 * record caps, and project-root resolution; model-facing tools and the
 * snapshot injection live in `@deepseek-ai/dsh-tool-memory`.
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
   * count covers the refreshed snapshot; simultaneous writes by another
   * process are outside this process's serialized capacity check.
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
 * means this project's key already holds another project's record;
 * `already-exists` is an `ifAbsent` write naming a record already in that
 * scope; `disposing` is an operation begun after disposal starts.
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
  | 'already-exists'
  | 'disposing'

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
  /** One-line summary shown in the snapshot; trimmed, 1 to 256 characters, no U+000A, U+000D, U+2028, or U+2029. */
  readonly description: string
  /** The memory body; trimmed, at most `maxRecordBytes` UTF-8 bytes. */
  readonly content: string
  /** Session working directory, when the session has one. */
  readonly cwd?: string | undefined
  /**
   * When true, create only: an existing record with this name and scope is
   * rejected with `already-exists` instead of replaced. Checked inside the
   * store's serialized operation, immediately after the existence
   * lookup, so a same-name write that commits between this call's argument
   * validation and its turn in that section still loses to whichever write
   * reaches the section first.
   */
  readonly ifAbsent?: boolean
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
  /**
   * Lowercased and trimmed phrase or unique whitespace-separated terms matched
   * against name, description, and content; blank matches everything.
   */
  readonly query?: string | undefined
  /** Maximum records returned. */
  readonly limit: number
  /** Session working directory, when the session has one. */
  readonly cwd?: string | undefined
  /** Restrict results to one memory scope. */
  readonly scope?: MemoryScope | undefined
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
  /** UTF-8 byte cap on a memory body; consumers use it to check that one complete recall block fits its configured budget. */
  readonly maxRecordBytes: number
  private readonly markers: readonly string[]
  /** Tail of the store's operation queue; every link settles, so one rejection never blocks the next. */
  private operations: Promise<void> = Promise.resolve()
  /** Set at the start of disposal; serialized operations reject new work. */
  private disposing = false

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
    this.ctx.effect(() => () => this.closeDomain(domain), 'memory.domainClose')
    this.domain = domain
  }

  /**
   * Stop accepting new operations, drain queued reads and mutations, then release the domain. Draining first
   * means queued work is never rejected by a closed-domain
   * error instead of its own outcome.
   * @param domain - the open domain handle to release once the queue drains.
   */
  private async closeDomain(domain: Domain<MemoryDomainSpec>): Promise<void> {
    this.disposing = true
    await this.operations
    await domain.close()
  }

  /**
   * Run one operation after earlier operations settle. Refreshing at its queue
   * slot makes external completed writes visible before the operation reads.
   * Rejects immediately once disposal has begun.
   */
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposing) {
      return Promise.reject(new MemoryError('disposing', 'memory store is disposing: no new reads or writes are accepted'))
    }
    const result = this.operations.then(async () => {
      await this.requireDomain().refresh()
      return operation()
    })
    this.operations = result.then(noop, noop)
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
   * @returns the visible records in a refreshed snapshot.
   * @throws {@link MemoryError} with code `disposing` when disposal has begun.
   */
  async visible(cwd: string | undefined): Promise<MemoryVisible> {
    return this.serialized(() => this.visibleSnapshot(cwd))
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
   * one at a time in call order, from refresh and project-root lookup to the durable
   * put, so overlapping calls never exceed the cap and a same-name overlap
   * reports `created` for the earlier call and keeps its `createdAt`. The cap
   * counts the refreshed snapshot; simultaneous writes by another process
   * are outside this process's serialized capacity check.
   * @param request - the memory to store.
   * @returns whether the record was created or updated, and the stored record.
   * @throws {@link MemoryError} for an invalid name, description, or content,
   * blocked description or content, a project scope without a project root, a
   * project key occupied by another project's record, a cap reached in the
   * target scope, (`request.ifAbsent`) an existing record with that name
   * and scope, or a write begun after disposal starts.
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
          if (request.ifAbsent === true && existing !== undefined) throw alreadyExists(name, 'global')
          this.assertCapacity(existing, table.size, 'global')
          if (existing !== undefined && sameContent(existing, {
            name, type: request.type, scope: 'global', description, content,
          })) return { outcome: 'updated', record: existing }
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
          if (request.ifAbsent === true && existing !== undefined) throw alreadyExists(name, 'project')
          this.assertCapacity(existing, this.projectRecords(root).length, 'project')
          if (existing !== undefined && sameContent(existing, {
            name, type: request.type, scope: 'project', description, content, projectRoot: root,
          })) return { outcome: 'updated', record: existing }
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
   * Find visible records by phrase or all query terms, ranked by name and text
   * relevance before the existing newest/name/scope order. A request without a
   * resolvable project root searches global records only.
   * @param request - query, result cap, working directory, and optional scope filter.
   * @returns at most `limit` matching records.
   * @throws {@link MemoryError} with code `disposing` when disposal has begun.
   */
  async recall(request: MemoryRecallRequest): Promise<MemoryRecord[]> {
    return this.serialized(async () => {
      const visible = await this.visibleSnapshot(request.cwd)
      const candidates = [...visible.global, ...visible.project?.records ?? []]
        .filter(record => request.scope === undefined || record.scope === request.scope)
      const query = (request.query ?? '').trim().toLowerCase()
      const terms = [...new Set(query.split(/\s+/).filter(Boolean))]
      if (query.length === 0) return candidates.sort(newestFirst).slice(0, Math.max(0, request.limit))
      const ranked = candidates
        .map(record => ({ record, score: relevance(record, query, terms) }))
        .filter((entry): entry is { record: MemoryRecord; score: Relevance } => entry.score !== undefined)
        .sort((left, right) => compareRelevance(left.score, right.score) || newestFirst(left.record, right.record))
      return ranked.slice(0, Math.max(0, request.limit)).map(entry => entry.record)
    })
  }

  private async visibleSnapshot(cwd: string | undefined): Promise<MemoryVisible> {
    const root = await this.resolveProjectRoot(cwd)
    const global = [...this.globalTable().entries()].map(([, record]) => record)
    if (root === undefined) return { global }
    return { global, project: { root, records: this.projectRecords(root) } }
  }

  /**
   * Delete one record durably, in the same one-at-a-time call order as writes.
   * @param request - name, scope, and working directory.
   * @throws {@link MemoryError} when the name is invalid, the project root is
   * unavailable, no such record exists in the scope, a project key is
   * occupied by another project's record, or the forget began after the
   * disposal started.
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

type Relevance = readonly [number, number, number, number, number, number, number]

function relevance(record: MemoryRecord, query: string, terms: readonly string[]): Relevance | undefined {
  const fields = [record.name.toLowerCase(), record.description.toLowerCase(), record.content.toLowerCase()] as const
  const phrase = fields.map(field => field.includes(query))
  const countTerms = (field: string) => terms.filter(term => field.includes(term)).length
  if (!phrase.some(Boolean) && !terms.every(term => fields.some(field => field.includes(term)))) return undefined
  return [
    record.name.toLowerCase() === query ? 1 : 0,
    phrase[0] ? 1 : 0,
    phrase[1] ? 1 : 0,
    phrase[2] ? 1 : 0,
    countTerms(fields[0]), countTerms(fields[1]), countTerms(fields[2]),
  ]
}

function compareRelevance(left: Relevance, right: Relevance): number {
  for (const index of [0, 1, 2, 3, 4, 5, 6] as const) {
    const difference = right[index] - left[index]
    if (difference !== 0) return difference
  }
  return 0
}

function sameContent(existing: MemoryRecord, next: Pick<MemoryRecord, 'name' | 'type' | 'scope' | 'description' | 'content' | 'projectRoot'>): boolean {
  return existing.name === next.name
    && existing.scope === next.scope
    && existing.type === next.type
    && existing.description === next.description
    && existing.content === next.content
    && existing.projectRoot === next.projectRoot
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

function alreadyExists(name: MemoryName, scope: MemoryScope): MemoryError {
  return new MemoryError('already-exists', `a ${scope} memory named "${name}" already exists; choose a different name`)
}

/* v8 ignore next 3 -- closed-union backstop; unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new Error(`unreachable memory scope: ${String(value)}`)
}

export default MemoryStore
