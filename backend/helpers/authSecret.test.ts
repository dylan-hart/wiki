import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertValidAuthSecret } from './authSecret.ts'

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
  // 20 code points, 40 UTF-8 bytes: clears the 32-byte floor only when measured in bytes.
  const secret = 'é'.repeat(20)
  assert.doesNotThrow(() => assertValidAuthSecret(secret))
})
