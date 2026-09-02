import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { authSecretSigner } from './authSecretSigner.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * Pure unit coverage for the live-secret signer (OpenProject #2172): no `WIKI` global beyond the one
 * property under test (`config.auth.secret`), no database. `sign()`/`unsign()` are required to read
 * `WIKI.config.auth.secret` at CALL time rather than close over a value handed to them once — this is
 * what lets `models/sessions.ts#rotateSecret()` take effect on a still-running instance without a
 * restart (OpenProject #2172). The DB-backed round trip through the real
 * `rotateSecret()` (delete every session row + swap `WIKI.config.auth.secret`) is `models/sessions.test.ts`'s
 * job; this file locks down the signer mechanism itself.
 */
describe('authSecretSigner', () => {
  beforeEach(() => {
    installTestWiki({ config: { auth: { secret: 'a-very-first-secret-value' } } })
  })

  test('a value signed under the current secret unsigns valid', () => {
    const signed = authSecretSigner.sign('session-id-one')
    const result = authSecretSigner.unsign(signed)
    assert.equal(result.valid, true)
    assert.equal(result.value, 'session-id-one')
  })

  test('changing WIKI.config.auth.secret is picked up on the very next call — no re-registration', () => {
    const signedUnderOldSecret = authSecretSigner.sign('session-id-two')

    // -> Simulates what `rotateSecret()` does to this instance directly, and what
    //    `core/config.ts#loadFromDb()` does to every OTHER instance in response to the `reloadConfig`
    //    event it fans out: `WIKI.config` is replaced wholesale, not mutated in place.
    WIKI.config = { auth: { secret: 'a-brand-new-rotated-secret' } }

    const afterRotation = authSecretSigner.unsign(signedUnderOldSecret)
    assert.equal(
      afterRotation.valid,
      false,
      'a cookie signed under the old secret must stop verifying the moment the secret is replaced'
    )
  })

  test('a value signed AFTER rotation verifies under the new secret', () => {
    authSecretSigner.sign('throwaway') // old secret still in effect here
    WIKI.config = { auth: { secret: 'yet-another-rotated-secret' } }

    const signedUnderNewSecret = authSecretSigner.sign('session-id-three')
    const result = authSecretSigner.unsign(signedUnderNewSecret)
    assert.equal(result.valid, true)
    assert.equal(result.value, 'session-id-three')
  })
})
