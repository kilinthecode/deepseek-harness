/**
 * Structural type guards shared by the record reader, which validates a stored
 * JSON record, and the reviewer-result validator, which validates a model's
 * structured output. Both start from a parsed JSON value of unknown shape.
 *
 * @module @deepseek-ai/dsh-subagent-worktree/guards
 */

/**
 * Whether a parsed JSON value is an object that is neither `null` nor an array.
 * @param value - a parsed JSON value.
 * @returns whether `value` is a plain object, so its fields can be read by name.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a parsed JSON value is an array whose every entry is a string.
 * @param value - a parsed JSON value.
 * @returns whether `value` is a string array.
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
