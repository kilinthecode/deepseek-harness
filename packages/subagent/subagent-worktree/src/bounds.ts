/**
 * Byte- and line-bounding helpers for the durable and model-facing text this
 * service produces: the reviewer diff (a byte-bounded prefix that must not
 * split a multibyte UTF-8 character), check/merge diagnostics (a bounded
 * character tail), and the base checkout's dirty-status summary (a bounded
 * line prefix plus its total count).
 *
 * @module @deepseek-ai/dsh-subagent-worktree/bounds
 */

/** Character bound applied to check-command and blocked-merge diagnostics. */
export const DIAGNOSTIC_TAIL_CHARS = 4000

/** Line bound applied to the base checkout's dirty-status summary. */
export const BASE_DIRTY_MAX_ENTRIES = 20

/**
 * Keep the trailing `maxChars` UTF-16 code units of `text`. Used only for
 * short diagnostic text (git stderr, check-command output), where splitting a
 * surrogate pair or combining character is an acceptable cost for staying
 * within a plain character count.
 * @param text - candidate diagnostic text.
 * @param maxChars - maximum retained length.
 * @returns `text` unchanged when short enough, otherwise its trailing `maxChars` characters.
 */
export function tailChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars)
}

/** A leading-byte truncation result. */
export interface TruncatedText {
  /** The retained prefix, valid UTF-8 text. */
  readonly text: string
  /** Whether `text` is shorter than the original because of the byte bound. */
  readonly truncated: boolean
}

/**
 * Keep a leading byte budget of `text`, cut only on a UTF-8 character
 * boundary. The cut lands inside a multibyte character exactly when the first
 * excluded byte is a UTF-8 continuation byte (`10xxxxxx`); this walks the cut
 * point back to that character's start so the retained prefix decodes cleanly
 * with no replacement characters.
 * @param text - candidate text, encoded as UTF-8 for the bound.
 * @param maxBytes - maximum retained byte length.
 * @returns the retained prefix and whether it was truncated.
 */
export function truncateUtf8Prefix(text: string, maxBytes: number): TruncatedText {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

/** A bounded line listing plus the unbounded total. */
export interface BoundedLines {
  /** Leading non-empty lines, at most the configured bound. */
  readonly entries: readonly string[]
  /** Total number of non-empty lines. */
  readonly total: number
}

/**
 * Split `text` into non-empty lines and keep only the leading `maxLines`,
 * alongside the true total. Empty trailing artifacts from a final newline are
 * dropped rather than counted as an entry.
 * @param text - newline-separated report, such as `git status --porcelain` output.
 * @param maxLines - maximum retained leading line count.
 * @returns the bounded leading lines and the total line count.
 */
export function boundedLines(text: string, maxLines: number): BoundedLines {
  const lines = text.split('\n').filter(line => line.length > 0)
  return { entries: lines.slice(0, maxLines), total: lines.length }
}
