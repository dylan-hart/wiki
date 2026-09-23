import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { DISCONNECTED_AUTH_KEY, isDisconnected, strategyEntries } from './userAuthEntries.ts'

describe('strategyEntries', () => {
  test('lists every strategy entry and leaves the disconnect record out', () => {
    const auth = {
      local: { password: 'hash' },
      oidc: { id: 'p1' },
      [DISCONNECTED_AUTH_KEY]: { saml: '2026-09-23T00:00:00.000Z' }
    }
    assert.deepEqual(
      strategyEntries(auth).map(([id]) => id),
      ['local', 'oidc']
    )
  })

  test('an absent column is no entries', () => {
    assert.deepEqual(strategyEntries(null), [])
    assert.deepEqual(strategyEntries(undefined), [])
  })
})

describe('isDisconnected', () => {
  const user = { auth: { [DISCONNECTED_AUTH_KEY]: { saml: '2026-09-23T00:00:00.000Z' } } }

  test('answers for the provider the record names', () => {
    assert.equal(isDisconnected(user, 'saml'), true)
  })

  test('and for no other', () => {
    assert.equal(isDisconnected(user, 'oidc'), false)
    assert.equal(isDisconnected({ auth: {} }, 'saml'), false)
    assert.equal(isDisconnected({}, 'saml'), false)
  })
})
