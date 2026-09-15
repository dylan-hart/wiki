import { randomBytes } from 'node:crypto'

/**
 * Cryptographically-random tokens over `node:crypto`, replacing the small third-party token
 * library this codebase used to depend on (removed — single maintainer, three HIGH advisories in
 * 2026 on its older major lines, and unnecessary here since `node:crypto` is always present and
 * cryptographically equivalent; `docs/audits/2026-09-13-dependency-audit.md` §3/A). Every call
 * site this replaced is sized to keep at least as much entropy as it had before — that library's
 * default 64-character alphabet was exactly 6 bits/char, so a call requesting `n` characters
 * carried `n * 6` bits.
 */

/**
 * A random, URL- and cookie-safe token: `bytes` bytes of entropy, base64url-encoded (RFC 4648,
 * no `+`/`/`/`=`). `Buffer#toString('base64url')` never pads, so the output is exactly
 * `ceil(bytes * 4 / 3)` characters long.
 *
 * The 16-byte default is 128 bits, at or above the ~126 bits (21 chars * 6 bits) the library this
 * replaced gave by default — the same default this helper's callers reach for when they don't
 * have a specific former entropy figure to match.
 */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * A random lowercase-hex id: `bytes` bytes of entropy, hex-encoded (2 characters per byte). For
 * the one former call site — `CARDINAL.INSTANCE_ID` in `index.ts` — that needs the old
 * hex-alphabet-only shape rather than base64url; the 5-byte default reproduces that exact
 * 10-character, 40-bit output.
 */
export function randomHexToken(bytes = 5): string {
  return randomBytes(bytes).toString('hex')
}
