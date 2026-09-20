import { randomBytes } from 'node:crypto'

/**
 * One-time 2FA recovery codes. Crockford's base32 alphabet rather than `helpers/totp.ts`'s RFC 4648
 * one: a TOTP secret only round-trips through a QR code, but a recovery code is read off a screen
 * and typed back in, so the characters misread against one another (`0`/`O`, `1`/`I`/`L`) are gone.
 */

export const RECOVERY_CODE_COUNT = 10

/** 10 bytes = 80 bits = exactly 16 five-bit characters, so `encode` has no partial group to pad. */
const codeBytes = 10

const groupSize = 4

/** Crockford base32: no `I`, `L`, `O`, `U`. */
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** `alphabet` as a character class — keep the two in sync. */
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
  return out
}

function group(raw: string): string {
  const groups: string[] = []
  for (let i = 0; i < raw.length; i += groupSize) {
    groups.push(raw.slice(i, i + groupSize))
  }
  return groups.join('-')
}

export function generateRecoveryCode(): string {
  return group(encode(randomBytes(codeBytes)))
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode())
}

/**
 * Canonical form of a user-typed code. Hashing and matching must both go through this, so a code
 * is recognized with or without its display dashes.
 */
export function normalizeRecoveryCode(value: string): string {
  return value.toUpperCase().replaceAll(/[^0-9A-Z]/g, '')
}

const normalizedLength = (codeBytes * 8) / 5

const normalizedPattern = new RegExp(`^${alphabetClass}{${normalizedLength}}$`)

/** Tells a recovery code apart from a 6-digit TOTP code before either is verified. */
export function isRecoveryCodeShape(value: string): boolean {
  return normalizedPattern.test(normalizeRecoveryCode(value))
}

const displayGroupCount = normalizedLength / groupSize

/** Unanchored regex source for the code as displayed, for embedding in a JSON Schema `pattern`. */
export const recoveryCodeDisplayPattern = `${alphabetClass}{${groupSize}}(?:-${alphabetClass}{${groupSize}}){${displayGroupCount - 1}}`
