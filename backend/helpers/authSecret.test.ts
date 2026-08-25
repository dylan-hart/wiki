import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertValidAuthSecret } from './authSecret.ts'

/**
 * Task 2240: `base.yml` no longer ships a committed default `auth.secret`, and this guard is what
 * turns a missing or too-short secret (a boot-ordering regression, or a code path that skips
 * `loadFromDb()`) into a boot failure instead of a silent downgrade to a guessable/absent value.
 * `index.ts#initHTTPServer()` calls it immediately before registering `@fastify/cookie` and
 * `@fastify/session`, both of which sign with `WIKI.config.auth.secret`.
 */

test('assertValidAuthSecret throws for a missing secret', () => {
  assert.throws(() => assertValidAuthSecret(undefined), /missing or shorter than 32 bytes/)
})

test('assertValidAuthSecret throws for null', () => {
  assert.throws(() => assertValidAuthSecret(null), /missing or shorter than 32 bytes/)
})

test('assertValidAuthSecret throws for an empty string', () => {
  assert.throws(() => assertValidAuthSecret(''), /missing or shorter than 32 bytes/)
})

test('assertValidAuthSecret throws for a non-string value', () => {
  assert.throws(() => assertValidAuthSecret(12345), /missing or shorter than 32 bytes/)
})

test('assertValidAuthSecret throws for a secret shorter than 32 bytes', () => {
  // 31 ASCII bytes -- one short of the floor.
  const shortSecret = 'a'.repeat(31)
  assert.throws(() => assertValidAuthSecret(shortSecret), /missing or shorter than 32 bytes/)
})

test('assertValidAuthSecret accepts a secret exactly 32 bytes long', () => {
  const secret = 'a'.repeat(32)
  assert.doesNotThrow(() => assertValidAuthSecret(secret))
})

test('assertValidAuthSecret accepts a real seeded secret (64 hex chars, as models/settings.ts seeds)', () => {
  const secret = 'f'.repeat(64)
  assert.doesNotThrow(() => assertValidAuthSecret(secret))
})

test('assertValidAuthSecret measures length in bytes, not characters, for multi-byte strings', () => {
  // 20 multi-byte characters (3 bytes each in UTF-8) is 60 bytes but only 20 code points -- must
  // pass on byte length, not `.length`, or a multi-byte secret could be incorrectly rejected.
  const secret = 'é'.repeat(20)
  assert.doesNotThrow(() => assertValidAuthSecret(secret))
})
