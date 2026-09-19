/**
 * The memory domain declaration: the record schema, the branded name and
 * project-key types, and the `memory` spec the store opens through
 * `ctx.storageDomain`. The zod schema validates every record at the durable
 * boundary, so a hand-edited file that no longer parses is backed up and
 * skipped instead of failing the open.
 * @module @deepseek-ai/dsh-memory/src/domain
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

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

/** A validated memory name; the global-table key. */
export type MemoryName = Branded<'MemoryName'>

/** The project-table key: `<project slug>__<memory name>`. */
export type ProjectMemoryKey = Branded<'ProjectMemoryKey'>

/**
 * Durable shape of one memory record. `projectRoot` is present exactly when
 * `scope` is `project` and holds the absolute root the record belongs to.
 * Timestamps are ISO-8601 strings and never reach the model.
 */
export const memoryRecord = z.object({
  name: z.string().regex(MEMORY_NAME_RE).transform(value => brandString<MemoryName>(value)),
  type: z.enum(MEMORY_TYPES),
  scope: z.enum(MEMORY_SCOPES),
  description: z.string().min(1).max(MEMORY_DESCRIPTION_MAX_CHARS),
  content: z.string().min(1),
  projectRoot: z.string().min(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).superRefine((record, context) => {
  if ((record.scope === 'project') !== (record.projectRoot !== undefined)) {
    context.addIssue({ code: 'custom', message: 'projectRoot is present exactly when scope is project' })
  }
})

/** One stored memory record, inferred from {@link memoryRecord}. */
export type MemoryRecord = z.infer<typeof memoryRecord>

/**
 * The memory domain spec: a `global` table keyed by {@link MemoryName} and a
 * `project` table keyed by {@link ProjectMemoryKey}, one JSON document per
 * record. A record that fails the schema is backed up and skipped at open so
 * one bad hand edit never hides every other memory.
 */
export const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    global: domainTable<MemoryName, MemoryRecord>(memoryRecord),
    project: domainTable<ProjectMemoryKey, MemoryRecord>(memoryRecord),
  },
})

/** The opened memory domain's static type. */
export type MemoryDomainSpec = typeof memoryDomainSpec
