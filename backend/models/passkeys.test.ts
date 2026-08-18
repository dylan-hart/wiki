import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOrigin } from './passkeys.ts'

/**
 * Unit coverage for `resolveOrigin()`, the function that ties a WebAuthn ceremony's `expectedOrigin`
 * to the hostname the request was addressed to (see `docs/security-reviews/` for the full review this
 * grew out of — task 435, feature 356).
 *
 * These are pure-function tests: no `WIKI` global, no db. `resolveOrigin` never touches either.
 */
describe('models/passkeys resolveOrigin', () => {
  test('a matching https origin is echoed back verbatim', () => {
    assert.equal(
      resolveOrigin('https://wiki.example.com', 'wiki.example.com'),
      'https://wiki.example.com'
    )
  })

  test('a matching https origin with a non-default port is preserved', () => {
    assert.equal(
      resolveOrigin('https://wiki.example.com:8443', 'wiki.example.com'),
      'https://wiki.example.com:8443'
    )
  })

  test('no Origin header at all is assumed to be the canonical https origin for the hostname', () => {
    assert.equal(resolveOrigin(undefined, 'wiki.example.com'), 'https://wiki.example.com')
  })

  test('http is accepted on localhost, 127.0.0.1 and [::1] without a mismatch', () => {
    assert.equal(resolveOrigin('http://localhost:3001', 'localhost'), 'http://localhost:3001')
    assert.equal(resolveOrigin('http://127.0.0.1:3001', '127.0.0.1'), 'http://127.0.0.1:3001')
  })

  test('http on a real hostname is rejected as ERR_PK_INSECURE_ORIGIN, not a mismatch', () => {
    assert.throws(
      () => resolveOrigin('http://wiki.example.com', 'wiki.example.com'),
      /ERR_PK_INSECURE_ORIGIN/
    )
  })

  test('an origin whose hostname disagrees with the request is rejected as ERR_PK_ORIGIN_MISMATCH', () => {
    // -> This is the shape a spoofed/degraded `req.hostname` produces: the browser's real Origin
    //    header says one thing, the value the ceremony was started against says another. Distinct
    //    from ERR_PK_INSECURE_ORIGIN so an admin debugging a trustProxy/reverse-proxy hostname
    //    mismatch isn't sent chasing a nonexistent TLS problem instead.
    assert.throws(
      () => resolveOrigin('https://attacker.example.com', 'wiki.example.com'),
      /ERR_PK_ORIGIN_MISMATCH/
    )
  })

  test('a value that does not parse as a URL is rejected as ERR_PK_INSECURE_ORIGIN', () => {
    assert.throws(() => resolveOrigin('not a url', 'wiki.example.com'), /ERR_PK_INSECURE_ORIGIN/)
  })
})
