import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { authSecretSigner } from './authSecretSigner.ts'
import { installTestWiki } from '../test/mocks.ts'

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

  test('changing CARDINAL.config.auth.secret is picked up on the very next call — no re-registration', () => {
    const signedUnderOldSecret = authSecretSigner.sign('session-id-two')

    // -> Both `rotateSecret()` and `loadFromDb()` replace `CARDINAL.config` wholesale, not in place.
    CARDINAL.config = { auth: { secret: 'a-brand-new-rotated-secret' } }

    const afterRotation = authSecretSigner.unsign(signedUnderOldSecret)
    assert.equal(
      afterRotation.valid,
      false,
      'a cookie signed under the old secret must stop verifying the moment the secret is replaced'
    )
  })

  test('a value signed AFTER rotation verifies under the new secret', () => {
    authSecretSigner.sign('throwaway')
    CARDINAL.config = { auth: { secret: 'yet-another-rotated-secret' } }

    const signedUnderNewSecret = authSecretSigner.sign('session-id-three')
    const result = authSecretSigner.unsign(signedUnderNewSecret)
    assert.equal(result.valid, true)
    assert.equal(result.value, 'session-id-three')
  })
})
