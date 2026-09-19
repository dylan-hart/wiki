import { randomBytes } from 'node:crypto'

/**
 * URL- and cookie-safe: `base64url` never pads, so the output is exactly `ceil(bytes * 4 / 3)`
 * characters. The 16-byte default is 128 bits of entropy.
 */
export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url')
}

export function randomHexToken(bytes = 5): string {
  return randomBytes(bytes).toString('hex')
}
