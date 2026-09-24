/**
 * The memory domain declaration: the record schema, the branded name and
 * project-key types, and the `memory` spec the store opens through
 * `ctx.storageDomain`. The zod schema bounds every field of every record at
 * the durable boundary, so a hand-edited file that no longer parses, or that
 * exceeds a bound, is backed up and skipped instead of failing the open.
 * @module @deepseek-ai/dsh-memory/src/domain
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainSpec, DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'

/** Memory kinds, in catalog order: who the user is, how to work, project facts, external pointers. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

/** One of {@link MEMORY_TYPES}. */
export type MemoryType = (typeof MEMORY_TYPES)[number]

/** Where a memory is visible: every session under one harness home, or sessions inside one project root. */
export const MEMORY_SCOPES = ['global', 'project'] as const

/** One of {@link MEMORY_SCOPES}. */
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * Accepted memory names: lowercase kebab-case, 1 to 64 characters. A name is
 * also the record's file name, so the set stays path-safe on every OS.
 */
export const MEMORY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Upper bound of a description, the one-line catalog summary. Protocol constant, not configuration. */
export const MEMORY_DESCRIPTION_MAX_CHARS = 256

/**
 * Upper bound of a stored `projectRoot`: 32,767 UTF-16 code units, the
 * longest path any supported OS accepts (a Windows extended-length path).
 * External limit, not configuration.
 */
export const MEMORY_PROJECT_ROOT_MAX_CHARS = 32_767

/**
 * Compare two stored text values by code unit instead of locale collation, so
 * every order the store and its consumers produce is identical on every host
 * and ICU build.
 * @param left - first value.
 * @param right - second value.
 * @returns a negative number, zero, or a positive number per the comparator contract.
 */
export function compareStoredText(left: string, right: string): number {
  return Number(left > right) - Number(left < right)
}

/** A validated memory name; the global-table key. */
export type MemoryName = Branded<'MemoryName'>

/** The project-table key: `<project slug>__<memory name>`. */
export type ProjectMemoryKey = Branded<'ProjectMemoryKey'>

/**
 * One stored memory record; {@link memoryRecordSchema} states the bound of
 * every field. Timestamps are UTC ISO-8601 date-times and never reach the model.
 */
export interface MemoryRecord {
  readonly name: MemoryName
  readonly type: MemoryType
  readonly scope: MemoryScope
  /** One-line catalog summary. */
  readonly description: string
  readonly content: string
  /** Absolute root of the project the record belongs to; present exactly when `scope` is `project`. */
  readonly projectRoot?: string | undefined
  readonly createdAt: string
  readonly updatedAt: string
}

/** Field bounds of one durable record; {@link memoryRecordSchema} adds the cross-field and content-size rules. */
const memoryRecordFields = z.object({
  name: z.string().regex(MEMORY_NAME_RE).transform(value => brandString<MemoryName>(value)),
  type: z.enum(MEMORY_TYPES),
  scope: z.enum(MEMORY_SCOPES),
  description: z.string().min(1).max(MEMORY_DESCRIPTION_MAX_CHARS),
  content: z.string().min(1),
  projectRoot: z.string().min(1).max(MEMORY_PROJECT_ROOT_MAX_CHARS).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}) satisfies ZodType<MemoryRecord>

/**
 * Build the durable schema of one memory record for one store. Every field is
 * bounded: the name by {@link MEMORY_NAME_RE}, the description by
 * {@link MEMORY_DESCRIPTION_MAX_CHARS}, the content by the store's
 * `maxRecordBytes`, the project root by {@link MEMORY_PROJECT_ROOT_MAX_CHARS},
 * and the timestamps by the ISO-8601 date-time format.
 * @param maxContentBytes - the store's UTF-8 byte cap on `content`.
 * @returns the zod schema that validates a record read from the medium.
 */
export function memoryRecordSchema(maxContentBytes: number): ZodType<MemoryRecord> {
  return memoryRecordFields.superRefine((record, context) => {
    if ((record.scope === 'project') !== (record.projectRoot !== undefined)) {
      context.addIssue({ code: 'custom', message: 'projectRoot is present exactly when scope is project' })
    }
    const bytes = Buffer.byteLength(record.content, 'utf8')
    if (bytes > maxContentBytes) {
      context.addIssue({ code: 'custom', message: `content is ${bytes} UTF-8 bytes; the cap is ${maxContentBytes}` })
    }
  })
}

/**
 * Build the memory domain spec for one store: a `global` table keyed by
 * {@link MemoryName} and a `project` table keyed by {@link ProjectMemoryKey},
 * one JSON document per record. A record that fails the schema, including one
 * whose content exceeds the store's current byte cap, is backed up and
 * skipped at open so one bad hand edit never hides every other memory.
 * @param maxContentBytes - the store's UTF-8 byte cap on `content`.
 * @returns the spec the store opens through `ctx.storageDomain`.
 */
export function memoryDomainSpec(maxContentBytes: number): MemoryDomainSpec {
  const record = memoryRecordSchema(maxContentBytes)
  return defineDomain({
    name: 'memory',
    version: 1,
    layout: 'per-record',
    invalidRecords: 'backup-and-skip',
    tables: {
      global: domainTable<MemoryName, MemoryRecord>(record),
      project: domainTable<ProjectMemoryKey, MemoryRecord>(record),
    },
  })
}

/** The memory domain spec's static type: the `global` and `project` tables and their key and record types. */
export interface MemoryDomainSpec extends DomainSpec {
  readonly tables: {
    readonly global: DomainTableSpec<MemoryName, MemoryRecord>
    readonly project: DomainTableSpec<ProjectMemoryKey, MemoryRecord>
  }
}
