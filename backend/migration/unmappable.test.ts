import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import { KNOWN_3_0_AUTH_MODULES, classifyUserAuthProvider } from './unmappable.ts'

describe('KNOWN_3_0_AUTH_MODULES', () => {
  test('matches the real backend/modules/authentication/ directory listing exactly', async () => {
    const authPath = path.join(import.meta.dirname, '..', 'modules', 'authentication')
    const onDisk = (await fs.readdir(authPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    assert.deepEqual([...KNOWN_3_0_AUTH_MODULES].sort(), onDisk)
  })
})

describe('classifyUserAuthProvider', () => {
  // -> Confirmed no-destination five (docs/migration/2.5x-settings-auth-storage-field-mapping.md's
  //    "Confirmed no-destination 2.x auth providers" section): 2.x ships these, 3.0 has no matching
  //    module directory for any of them.
  for (const providerKey of ['azure', 'dropbox', 'facebook', 'firebase', 'rocketchat']) {
    test(`flags "${providerKey}" as unmappable (unsupported-auth-provider)`, () => {
      const result = classifyUserAuthProvider({ providerKey, email: 'alice@example.com' })
      assert.ok(result)
      assert.equal(result.reason, 'unsupported-auth-provider')
      assert.equal(result.identifier, 'alice@example.com')
      assert.match(result.detail, new RegExp(providerKey))
      assert.ok(
        !KNOWN_3_0_AUTH_MODULES.has(providerKey),
        `${providerKey} must not be a real 3.0 module`
      )
    })

    test(`is case-insensitive for "${providerKey.toUpperCase()}"`, () => {
      const result = classifyUserAuthProvider({ providerKey: providerKey.toUpperCase() })
      assert.ok(result)
    })
  }

  // -> Every real 3.0 module — including the twelve that gained a module directory since this set was
  //    last hardcoded (ldap/saml/cas/auth0/okta among them) — must NOT be flagged: they are mappable,
  //    even though their config prop-name mapping may still be unverified (that's the mapper's job,
  //    not this classifier's).
  for (const providerKey of KNOWN_3_0_AUTH_MODULES) {
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
    const result = classifyUserAuthProvider({ providerKey: 'firebase', id: 42 })
    assert.equal(result?.identifier, '42')
  })
})
