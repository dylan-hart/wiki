import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { COMMENTS_UNMAPPABLE, classifyUserAuthProvider } from './unmappable.ts'

describe('classifyUserAuthProvider', () => {
  for (const providerKey of ['ldap', 'saml', 'cas', 'auth0', 'okta']) {
    test(`flags "${providerKey}" as unmappable (unsupported-auth-provider)`, () => {
      const result = classifyUserAuthProvider({ providerKey, email: 'alice@example.com' })
      assert.ok(result)
      assert.equal(result.reason, 'unsupported-auth-provider')
      assert.equal(result.identifier, 'alice@example.com')
      assert.match(result.detail, new RegExp(providerKey))
    })

    test(`is case-insensitive for "${providerKey.toUpperCase()}"`, () => {
      const result = classifyUserAuthProvider({ providerKey: providerKey.toUpperCase() })
      assert.ok(result)
    })
  }

  for (const providerKey of ['local', 'google', 'github', 'oidc']) {
    test(`does not flag a supported provider ("${providerKey}")`, () => {
      assert.equal(classifyUserAuthProvider({ providerKey }), null)
    })
  }

  test('does not flag an unrecognized provider key', () => {
    assert.equal(classifyUserAuthProvider({ providerKey: 'some-future-provider' }), null)
  })

  test('does not flag a record with no providerKey at all', () => {
    assert.equal(classifyUserAuthProvider({ email: 'alice@example.com' }), null)
  })

  test('falls back to id when email is missing', () => {
    const result = classifyUserAuthProvider({ providerKey: 'okta', id: 42 })
    assert.equal(result?.identifier, '42')
  })
})

describe('COMMENTS_UNMAPPABLE', () => {
  test('is a static no-destination-table entry', () => {
    assert.equal(COMMENTS_UNMAPPABLE.identifier, 'comments')
    assert.equal(COMMENTS_UNMAPPABLE.reason, 'no-destination-table')
    assert.match(COMMENTS_UNMAPPABLE.detail, /comments\(\) generator/)
  })
})
