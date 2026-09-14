import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomHexToken, randomToken } from './randomToken.ts'

describe('randomToken', () => {
  test('defaults to 16 bytes of entropy, base64url-encoded with no padding', () => {
    const token = randomToken()
    // -> 16 bytes -> ceil(16 * 4 / 3) = 22 base64url characters, no '=' padding
    assert.equal(token.length, 22)
    assert.match(token, /^[A-Za-z0-9_-]+$/)
  })

  test('scales its output length with the requested byte count', () => {
    assert.equal(randomToken(24).length, 32)
    assert.equal(randomToken(30).length, 40)
    assert.equal(randomToken(48).length, 64)
  })

  test('only ever emits URL-safe base64 characters, never "+" or "/" or "="', () => {
    for (let i = 0; i < 200; i++) {
      const token = randomToken(24)
      assert.doesNotMatch(token, /[+/=]/)
    }
  })

  test('draws are unique across many calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      seen.add(randomToken())
    }
    assert.equal(seen.size, 1000)
  })
})

describe('randomHexToken', () => {
  test('defaults to 5 bytes of entropy, rendered as 10 lowercase hex characters', () => {
    const token = randomHexToken()
    assert.equal(token.length, 10)
    assert.match(token, /^[0-9a-f]{10}$/)
  })

  test('scales its output length with the requested byte count', () => {
    assert.equal(randomHexToken(1).length, 2)
    assert.equal(randomHexToken(10).length, 20)
  })

  test('draws are unique across many calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      seen.add(randomHexToken())
    }
    assert.equal(seen.size, 1000)
  })
})
