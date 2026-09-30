/*
 * MIT License
 *
 * Copyright (c) 2025 Nous Research
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Pattern groups adapted from Hermes Agent tools/threat_patterns.py at 4c286ae7a0dcb86e70a7ad8c23c0f05c89e33ec3.
 */
/**
 * Write-time and consumer-facing scan of memory description and content:
 * invisible and bidirectional unicode on the raw text, then case-insensitive
 * threat patterns on an NFKC-normalized, truncated copy. Stored bytes are
 * never modified. C2/promptware and Hermes-specific groups are omitted.
 * @module @deepseek-ai/dsh-memory/src/scan
 */

/** Longest NFKC copy, in UTF-16 code units, that is tested against threat patterns. */
const NFKC_SCAN_MAX_CODE_UNITS = 65_536

const C0_MAX = 0x1F
const C1_MIN = 0x80
const C1_MAX = 0x9F
const TAB = 0x09
const LINE_FEED = 0x0A

const INVISIBLE_OR_BIDI = new Set<number>([
  0x200B, 0x200C, 0x200D, 0x2060, 0x2062, 0x2063, 0x2064, 0xFEFF,
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
  0x2066, 0x2067, 0x2068, 0x2069,
])

/**
 * One rejected scan: `invisible-unicode` or a {@link MEMORY_THREAT_PATTERNS} `id`.
 */
export interface MemoryScanFinding {
  readonly id: string
  readonly message: string
}

/**
 * Threat regexes applied to an NFKC-normalized, truncated copy of the text.
 * Each `pattern` carries the flags it needs; matching is case-insensitive
 * except `secret_quoted_assignment`, which spells its keywords in both cases so
 * it can allow a SHOUTY_SNAKE value: an environment-variable name, not a secret.
 */
export const MEMORY_THREAT_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: 'classic_ignore_previous', pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts)/i },
  { id: 'classic_disregard_previous', pattern: /disregard\s+(?:all\s+)?(?:previous|prior|above|your)\s+(?:instructions|prompts|rules)/i },
  { id: 'classic_forget_instructions', pattern: /forget\s+(?:all\s+)?(?:your\s+)?(?:previous|prior)\s+(?:instructions|prompts|training)/i },
  { id: 'classic_new_instructions', pattern: /(?:new|updated)\s+(?:system\s+)?instructions?\s*:/i },
  { id: 'classic_override_safety', pattern: /override\s+(?:all\s+)?(?:safety|system)\s+(?:guidelines|instructions|rules|filters)/i },
  { id: 'role_you_are_now', pattern: /you\s+are\s+now\s+(?:a|an|my|the)\s+/i },
  { id: 'role_act_as', pattern: /act\s+as\s+(?:if\s+you|a\s+jailbroken|an?\s+unrestricted)/i },
  { id: 'role_from_now_on', pattern: /from\s+now\s+on,?\s+you\s+(?:will|are|must)\s+/i },
  { id: 'leak_reveal_system_prompt', pattern: /(?:repeat|reveal|print|show|output|display|dump)\s+(?:your|the)\s+(?:full\s+)?(?:system\s+)?(?:prompt|instructions)/i },
  { id: 'leak_what_is_prompt', pattern: /what\s+(?:is|are)\s+your\s+(?:system\s+)?(?:prompt|instructions)/i },
  { id: 'exfil_curl_secret', pattern: /\bcurl\s[^\n]{0,2048}\$\{?[a-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i },
  { id: 'exfil_wget_secret', pattern: /\bwget\s[^\n]{0,2048}\$\{?[a-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i },
  { id: 'exfil_read_env', pattern: /\bcat\s+[^\n]{0,2048}(?:\.env\b|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i },
  { id: 'exfil_send_context', pattern: /\b(?:send|post|upload|transmit)\s[^\n]{0,200}\b(?:conversation|context|transcript|chat\s+history|system\s+prompt)\b[^\n]{0,200}\s(?:to|at)\s+https?:\/\//i },
  { id: 'persist_authorized_keys', pattern: /(?:>>|tee\b).{0,80}authorized_keys/i },
  { id: 'persist_ssh_write', pattern: /(?:>>|tee\b).{0,80}\.ssh\//i },
  { id: 'persist_agent_instructions', pattern: /(?:>>|tee\b).{0,80}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules)/i },
  { id: 'secret_quoted_assignment', pattern: /(?:[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd])\s*[=:]\s*['"](?![A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+['"])[A-Za-z0-9+/=_-]{20,}/ },
]

function hexCodePoint(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
}

function isBlockedControl(code: number): boolean {
  if (code <= C0_MAX) return code !== TAB && code !== LINE_FEED
  if (code >= C1_MIN && code <= C1_MAX) return true
  return INVISIBLE_OR_BIDI.has(code)
}

/** Every blocked code point is in the Basic Multilingual Plane, so UTF-16 code units suffice. */
function findInvisible(text: string): MemoryScanFinding | undefined {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (isBlockedControl(code)) {
      return {
        id: 'invisible-unicode',
        message: `Blocked: content contains invisible unicode character ${hexCodePoint(code)} (possible injection).`,
      }
    }
  }
  return undefined
}

/**
 * Scan one memory description or body for invisible unicode and threat patterns.
 * @param text - raw description or content; stored bytes are not modified.
 * @returns the first finding, or `undefined` when the text is allowed.
 */
export function scanMemoryText(text: string): MemoryScanFinding | undefined {
  const invisible = findInvisible(text)
  if (invisible !== undefined) return invisible
  const normalized = text.normalize('NFKC').slice(0, NFKC_SCAN_MAX_CODE_UNITS)
  for (const { id, pattern } of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(normalized)) {
      return { id, message: `Blocked: content matches threat pattern ${id}.` }
    }
  }
  return undefined
}
