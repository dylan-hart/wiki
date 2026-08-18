import { randomBytes } from 'node:crypto'

/**
 * One-time 2FA recovery codes: a fixed set issued when 2FA is enabled, each usable once as a
 * fallback for a lost authenticator.
 *
 * Generated the same way `helpers/totp.ts` generates a secret — `randomBytes` plus an encoding meant
 * to be read and typed by a human — but with its own alphabet rather than reusing base32. The base32
 * alphabet in `totp.ts` keeps every letter and digit in play because a secret only ever round-trips
 * through an authenticator app scanning a QR code; a recovery code is *only* ever read off a screen
 * (or a downloaded file) and typed back in later, so the characters that get misread against one
 * another — `0`/`O`, `1`/`I`/`L` — are dropped instead. This is Crockford's base32 alphabet, chosen
 * for exactly that property.
 */

/** How many codes a fresh set contains. */
export const RECOVERY_CODE_COUNT = 10

/** Bytes of entropy per code. 10 bytes = 80 bits, which is exactly 16 five-bit groups — no padding. */
const codeBytes = 10

/** Characters per dash-separated group in the displayed/typed code. */
const groupSize = 4

/** Crockford base32: the 10 digits plus 22 letters, excluding `I`, `L`, `O`, `U`. */
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** The alphabet as a character class, shared by the shape-matching regex below. */
const alphabetClass = '[0-9A-HJKMNPQRSTVWXYZ]'

function encode(bytes: Buffer): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  // -> 80 bits / 5 = exactly 16 groups, so there is never a leftover partial group to pad here,
  //    unlike `totp.ts`'s `base32Encode` which has to handle one.
  return out
}

function group(raw: string): string {
  const groups: string[] = []
  for (let i = 0; i < raw.length; i += groupSize) {
    groups.push(raw.slice(i, i + groupSize))
  }
  return groups.join('-')
}

/** A single fresh recovery code, formatted for display as four dash-separated groups of four. */
export function generateRecoveryCode(): string {
  return group(encode(randomBytes(codeBytes)))
}

/** A fresh set of `RECOVERY_CODE_COUNT` recovery codes. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode())
}

/**
 * Canonical form of a user-typed code: uppercased, with dashes and any other stray characters (a
 * pasted space, a copy that picked up a line break) stripped. Hashing and matching both go through
 * this, so a code is recognized the same way whether or not it still carries its display dashes.
 */
export function normalizeRecoveryCode(value: string): string {
  return value.toUpperCase().replaceAll(/[^0-9A-Z]/g, '')
}

/** How many characters a normalized code has: `codeBytes` bytes at 5 bits per character. */
const normalizedLength = (codeBytes * 8) / 5

/** Matches a normalized code: exactly the characters `generateRecoveryCode()` produces. */
const normalizedPattern = new RegExp(`^${alphabetClass}{${normalizedLength}}$`)

/**
 * Whether a value is shaped like a recovery code — with or without its display dashes. Used to tell
 * a recovery code apart from a 6-digit TOTP code before attempting to verify either.
 */
export function isRecoveryCodeShape(value: string): boolean {
  return normalizedPattern.test(normalizeRecoveryCode(value))
}

/** How many dash-separated groups a displayed code has. */
const displayGroupCount = normalizedLength / groupSize

/**
 * Regex source (no anchors) for the code exactly as displayed — dash-separated groups of four. For
 * embedding in a JSON Schema `pattern`, alongside the 6-digit TOTP shape, on the routes that accept
 * either.
 */
export const recoveryCodeDisplayPattern = `${alphabetClass}{${groupSize}}(?:-${alphabetClass}{${groupSize}}){${displayGroupCount - 1}}`
