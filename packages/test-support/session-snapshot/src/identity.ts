/** Relationship-preserving identity redaction for committed session snapshots. */

const UUID_FRAGMENT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const LEGACY_TOKEN_RE = /^\{\{(?:sessionId|messageId)\}\}$/
const IDENTITY_KINDS = [
  'session', 'message', 'approval', 'workflow', 'command', 'rpc', 'retry', 'id',
  'worktree', 'commit', 'repoKey', 'reviewCheckout',
] as const
const CANONICAL_TOKEN_RE = new RegExp(String.raw`^\{\{(${IDENTITY_KINDS.join('|')}):([1-9]\d*)\}\}$`)
const ID_KEY_RE = /(?:^id$|Id$|Ids$)/
// A value that IS one of these ids owns that kind even when a generic id-shaped
// key discovers it first, so one relationship never splits across two kinds.
const WORKTREE_ID_RE = /^wt-[0-9a-f]{8}$/
const COMMIT_ID_RE = /^[0-9a-f]{40}$/
// A field that holds a content hash, such as the SHA-1 `digest` of an instruction file. It is a fixed
// function of committed text and has the shape of a commit id, so it keeps its literal value.
const CONTENT_HASH_KEYS: ReadonlySet<string> = new Set(['digest'])

type IdentityKind = typeof IDENTITY_KINDS[number]

interface ParsedLog {
  readonly records: Record<string, unknown>[]
  readonly trailingNewline: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseLog(log: string): ParsedLog {
  return {
    records: log.split(/\r?\n/)
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>),
    trailingNewline: log.endsWith('\n'),
  }
}

function messageId(value: unknown): string | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.role !== 'string'
    || !Array.isArray(value.content)
    || !isRecord(value.source)) return undefined
  return value.id
}

/** The kind a value's own shape claims; `undefined` means its key or a generic scan decides. */
function intrinsicIdentityKind(value: string): IdentityKind | undefined {
  if (WORKTREE_ID_RE.test(value)) return 'worktree'
  if (COMMIT_ID_RE.test(value)) return 'commit'
  return undefined
}

function redactedCandidate(value: string): boolean {
  return UUID_FRAGMENT_RE.test(value)
    || LEGACY_TOKEN_RE.test(value)
    || CANONICAL_TOKEN_RE.test(value)
    || intrinsicIdentityKind(value) !== undefined
}

/**
 * Replace volatile opaque ids while preserving equality relationships across a parent and its child logs.
 * @param logs - one scenario's primary-first session JSONL fixtures.
 * @returns compact JSONL with typed first-seen identity tokens.
 */
export function redactSessionSnapshotIds(logs: readonly string[]): string[] {
  const parsed = logs.map(parseLog)
  const tokenByValue = new Map<string, string>()
  const nextByKind = new Map<IdentityKind, number>()

  const claim = (value: unknown, kind: IdentityKind, always = false): void => {
    if (typeof value !== 'string' || value.length === 0 || tokenByValue.has(value)) return
    if (!always && !redactedCandidate(value)) return
    const canonical = CANONICAL_TOKEN_RE.exec(value)
    if (canonical !== null) {
      const canonicalKind = canonical[1] as IdentityKind
      const ordinal = Number(canonical[2])
      nextByKind.set(canonicalKind, Math.max(nextByKind.get(canonicalKind) ?? 0, ordinal))
      tokenByValue.set(value, value)
      return
    }
    const owned = intrinsicIdentityKind(value) ?? kind
    const next = (nextByKind.get(owned) ?? 0) + 1
    nextByKind.set(owned, next)
    tokenByValue.set(value, `{{${owned}:${next}}}`)
  }

  for (const log of parsed) {
    const header = log.records[0]
    if (header?.type === 'session') claim(header.id, 'session', true)
  }

  const collect = (value: unknown, recordType?: unknown, key = ''): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\bas message ([0-9a-f-]{36})\b/gi)) claim(match[1], 'message')
      for (const match of value.matchAll(/\bAnonymous user: ([0-9a-f-]{36})\b/gi)) claim(match[1], 'id')
      // Word-bounded so a longer id never yields a fragment, and hex-neighbour-bounded
      // so a 40-character window inside a longer digest is not a commit.
      for (const match of value.matchAll(/\bwt-[0-9a-f]{8}\b/g)) claim(match[0], 'worktree')
      if (!CONTENT_HASH_KEYS.has(key)) {
        for (const match of value.matchAll(/(?<![0-9a-fA-F])[0-9a-f]{40}(?![0-9a-fA-F])/g)) claim(match[0], 'commit')
      }
      // The worktree service's per-repository directory name — a sanitized repo
      // basename plus a 12-hex digest of its canonical path (`repoKeyFor` in
      // dsh-subagent-worktree) — changes with the checkout path, so the segment
      // right after the literal `worktrees` directory needs its own token
      // distinct from the `{{cwd}}` prefix that covers the rest of the path.
      // Anchored on that literal directory name, so `always` bypasses the
      // generic shape check the same way a `commandId`/`rpcId` field does.
      for (const match of value.matchAll(/\/worktrees\/([A-Za-z0-9._-]+-[0-9a-f]{12})(?=\/)/g)) claim(match[1], 'repoKey', true)
      // A review checkout directory is the worktree id plus the millisecond clock the
      // service read when the review started (`reviewCheckoutPathFor` in
      // dsh-subagent-worktree), so its whole name changes on every run. Claiming the
      // complete name lets the longer replacement win over the bare worktree id it
      // contains, and anchoring on the literal `reviews` directory keeps any other
      // `wt-` id followed by digits untouched.
      for (const match of value.matchAll(/\/reviews\/(wt-[0-9a-f]{8}-\d+)(?![0-9A-Za-z_-])/g)) claim(match[1], 'reviewCheckout', true)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, recordType, key)
      return
    }
    if (!isRecord(value)) return

    const identifiedMessage = messageId(value)
    if (identifiedMessage !== undefined) claim(identifiedMessage, 'message')
    for (const [childKey, item] of Object.entries(value)) {
      if (recordType === 'approval/asked' || recordType === 'approval/decided') {
        if (childKey === 'id') claim(item, 'approval')
      } else if (childKey === 'commandId') {
        claim(item, 'command', true)
      } else if (childKey === 'rpcId') {
        claim(item, 'rpc', true)
      } else if (childKey === 'retryId') {
        claim(item, 'retry')
      } else if (childKey === 'runId') {
        claim(item, 'workflow')
      } else if (ID_KEY_RE.test(childKey)) {
        claim(item, 'id')
      }
      collect(item, recordType, childKey)
    }
  }
  for (const log of parsed) {
    for (const record of log.records) {
      if (record.type === 'feedback/message-put' && isRecord(record.data) && isRecord(record.data.item)) {
        claim(record.data.item.version, 'id')
      }
      collect(record, record.type)
    }
  }

  const replacements = [...tokenByValue]
    .sort(([left], [right]) => right.length - left.length)
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = tokenByValue.get(value)
      if (exact !== undefined) return exact
      let output = value
      for (const [source, token] of replacements) output = output.split(source).join(token)
      return output
    }
    if (Array.isArray(value)) return value.map(replace)
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    }
    return value
  }

  return parsed.map((log) => {
    const content = log.records.map(record => JSON.stringify(replace(record))).join('\n')
    return log.trailingNewline ? `${content}\n` : content
  })
}
