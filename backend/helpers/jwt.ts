import crypto from 'node:crypto'

/**
 * Only RS256 is accepted on the way in — a token asking for `none`, or for an HMAC algorithm that
 * would turn the public key into a signing secret, is rejected outright.
 */

export interface JwtClaims {
  [claim: string]: any
  aud?: string
  /** Required by `verifyJwt`. */
  exp?: number
  iat?: number
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeSegment(segment: string): any {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

export function epochSeconds(instant: Temporal.Instant = Temporal.Now.instant()): number {
  return Math.floor(instant.epochMilliseconds / 1000)
}

/**
 * @param privateKey A PEM string only works for an unencrypted key. The installation key is
 *                   passphrase-protected, so callers pass a `KeyObject` built with the passphrase.
 */
export function signJwt(claims: JwtClaims, privateKey: crypto.KeyObject | string): string {
  const payload = `${encodeSegment({ alg: 'RS256', typ: 'JWT' })}.${encodeSegment(claims)}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(payload), privateKey)
  return `${payload}.${signature.toString('base64url')}`
}

/** Throws with a specific message on every failure, so callers can log the reason. */
export function verifyJwt(
  token: string,
  publicKey: crypto.KeyObject | string,
  { audience }: { audience?: string } = {}
): JwtClaims {
  const segments = token.split('.')
  if (segments.length !== 3) {
    throw new Error('Token is malformed.')
  }
  const [encodedHeader, encodedClaims, encodedSignature] = segments as [string, string, string]

  let header: any
  let claims: JwtClaims
  try {
    header = decodeSegment(encodedHeader)
    claims = decodeSegment(encodedClaims)
  } catch {
    throw new Error('Token is malformed.')
  }
  if (header?.alg !== 'RS256') {
    throw new Error('Token algorithm is not supported.')
  }
  if (!claims || typeof claims !== 'object') {
    throw new Error('Token is malformed.')
  }

  let isValid = false
  try {
    isValid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      publicKey,
      Buffer.from(encodedSignature, 'base64url')
    )
  } catch {
    // -> `crypto.verify` throws on a malformed signature rather than returning false
    isValid = false
  }
  if (!isValid) {
    throw new Error('Token signature is invalid.')
  }

  // -> A token with no expiry would be valid forever, so its absence is a failure
  if (typeof claims.exp !== 'number') {
    throw new Error('Token has no expiration.')
  }
  if (epochSeconds() >= claims.exp) {
    throw new Error('Token has expired.')
  }
  if (audience && claims.aud !== audience) {
    throw new Error('Token audience does not match.')
  }

  return claims
}
