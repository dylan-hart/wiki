import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Time-based one-time passwords (RFC 6238): HMAC-SHA1 over a 30-second counter, truncated to six
 * digits, keyed by a base32 secret. Hand-written rather than taken from a package because the
 * algorithm and the base32 codec it needs are a few dozen lines together.
 *
 * The parameters below are deliberately not configurable: they are what an `otpauth://` URI means
 * when it omits them, and an authenticator app reading a QR code cannot be told anything else.
 */

const codeDigits = 6

const periodSeconds = 30

/**
 * Periods either side of the current one that are also accepted. Clocks drift, and a user typing
 * six digits routinely crosses a window boundary.
 */
const allowedDrift = 1

/**
 * 20 bytes is SHA-1's own digest length and encodes to exactly 32 base32 characters with no
 * padding, which is what authenticator apps expect to be handed.
 */
const secretBytes = 20

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Unpadded base32 (RFC 4648), the encoding `otpauth://` URIs use for secrets. */
function base32Encode(bytes: Buffer): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += base32Alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  // -> A trailing group of fewer than 5 bits still carries data; pad it with zeroes on the right
  if (bits > 0) {
    out += base32Alphabet[(value << (5 - bits)) & 31]
  }
  return out
}

/**
 * Case-insensitive, and separators a user may have typed are ignored: the secret is displayed for
 * manual entry as well as scanned.
 */
function base32Decode(value: string): Buffer {
  const normalized = value.toUpperCase().replaceAll(/[\s-]/g, '').replaceAll('=', '')
  const bytes: number[] = []
  let bits = 0
  let acc = 0
  for (const char of normalized) {
    const index = base32Alphabet.indexOf(char)
    if (index < 0) {
      throw new Error(`Not a base32 character: ${char}`)
    }
    acc = (acc << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

function codeAt(secret: Buffer, counter: number): string {
  const counterBytes = Buffer.alloc(8)
  counterBytes.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(counterBytes).digest()
  // -> Dynamic truncation: the low nibble of the last byte picks where in the digest to read from
  const offset = digest[digest.length - 1]! & 0x0f
  const binary = digest.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** codeDigits).padStart(codeDigits, '0')
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(secretBytes))
}

/**
 * The label is `issuer:account` and the issuer is repeated as a parameter, which is what
 * authenticator apps actually key their entries on. Both are URI-encoded; a wiki title containing a
 * `:` or a `?` would otherwise produce a URI that parses as something else.
 */
export function buildTotpUri({
  secret,
  account,
  issuer
}: {
  secret: string
  account: string
  issuer: string
}): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(codeDigits),
    period: String(periodSeconds)
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/**
 * Answers with the matched *counter* rather than a boolean so a caller can record it and refuse a
 * code whose counter has already been accepted — RFC 6238 §5.2's replay requirement.
 *
 * @returns The counter the code matched, or -1 for no match, anything that is not six digits, or a
 *          secret that will not decode
 */
export function verifyTotpCode(secret: string, code: string): number {
  if (!secret || !/^[0-9]{6}$/.test(code)) {
    return -1
  }

  let secretKey: Buffer
  try {
    secretKey = base32Decode(secret)
  } catch {
    return -1
  }
  if (secretKey.length < 1) {
    return -1
  }

  const expected = Buffer.from(code, 'utf8')
  const counter = Math.floor(Date.now() / 1000 / periodSeconds)
  let matchedCounter = -1
  for (let drift = -allowedDrift; drift <= allowedDrift; drift++) {
    // -> Every candidate is compared, rather than returning on the first hit, so that the work done
    //    does not depend on which window the code came from
    const candidateCounter = counter + drift
    if (timingSafeEqual(Buffer.from(codeAt(secretKey, candidateCounter), 'utf8'), expected)) {
      matchedCounter = candidateCounter
    }
  }
  return matchedCounter
}
