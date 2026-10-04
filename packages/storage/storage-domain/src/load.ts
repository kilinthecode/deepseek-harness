/**
 * Shared open and refresh snapshot loading for storage domains.
 * @module @deepseek-ai/dsh-storage-domain/src/load
 */

import type { Context } from '@deepseek-ai/cordis'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { DomainError } from './error.ts'
import type { DomainSpec } from './spec.ts'

/** Validated in-memory projection of one KV unit snapshot. */
export interface DomainSnapshot {
  /** One map for every declared table, including empty tables. */
  readonly tables: Map<string, Map<string, unknown>>
  /** Validated global value, its declared initial value, or `undefined`. */
  readonly globalValue: unknown
}

/**
 * Load and validate a complete snapshot using the domain's open-time policy.
 * @param ctx - Context used to report records skipped by backup policy.
 * @param spec - Domain declarations and validation policy.
 * @param unit - Open backend unit to read.
 * @returns Fully validated table and global state.
 */
export async function loadDomainSnapshot(
  ctx: Context,
  spec: DomainSpec,
  unit: KvUnit,
): Promise<DomainSnapshot> {
  const snapshot = await unit.loadAll()
  const tables = new Map<string, Map<string, unknown>>()
  for (const [table, tableSpec] of Object.entries(spec.tables)) {
    const records = new Map<string, unknown>()
    for (const [key, raw] of Object.entries(snapshot.tables[table] ?? {})) {
      let parsed: unknown
      try {
        parsed = parseRecord(spec.name, table, key, () => tableSpec.valueSchema.parse(raw))
      } catch (error) {
        if (spec.invalidRecords !== 'backup-and-skip' || unit.backupRecord === undefined) throw error
        const moved = await unit.backupRecord(table, key)
        ctx.logger.error(
          `domain '${spec.name}': stored record '${key}' in table '${table}' failed schema validation; `
          + `moved to '${moved}' and treated as absent. Cause: ${String((error as DomainError).cause)}`,
        )
        continue
      }
      records.set(key, parsed)
    }
    tables.set(table, records)
  }
  const globalSpec = spec.global
  const globalValue = globalSpec === undefined
    ? undefined
    : snapshot.global === null
      ? globalSpec.initial
      : parseRecord(spec.name, '', '', () => globalSpec.schema.parse(snapshot.global))
  return { tables, globalValue }
}

/** Translate a schema failure to `invalid-record` with its location. */
function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`
    throw new DomainError(
      'invalid-record',
      `domain '${domain}': stored ${slot} does not match its schema`,
      { detail: { table, key }, cause: error },
    )
  }
}
