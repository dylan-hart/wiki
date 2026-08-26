import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  COMMENTS_UNMAPPABLE,
  UNSUPPORTED_AUTH_PROVIDERS,
  classifyUserAuthProvider
} from './unmappable.ts'

describe('classifyUserAuthProvider', () => {
  for (const providerKey of ['azure', 'dropbox', 'facebook', 'firebase', 'rocketchat']) {
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

  // -> These five all have a real backend/modules/authentication/<key>/ directory (confirmed by the
  //    cross-check below), so a 2.x account on any of them is mappable, not flagged.
  for (const providerKey of [
    'ldap',
    'saml',
    'cas',
    'auth0',
    'okta',
    'local',
    'google',
    'github',
    'oidc'
  ]) {
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
    const result = classifyUserAuthProvider({ providerKey: 'rocketchat', id: 42 })
    assert.equal(result?.identifier, '42')
  })
})

describe('UNSUPPORTED_AUTH_PROVIDERS', () => {
  test('is disjoint from the real backend/modules/authentication/ directory listing', async () => {
    const authPath = path.join(import.meta.dirname, '..', 'modules', 'authentication')
    const onDisk = new Set(
      (await fs.readdir(authPath, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    )
    for (const providerKey of UNSUPPORTED_AUTH_PROVIDERS) {
      assert.ok(
        !onDisk.has(providerKey),
        `'${providerKey}' is listed as unmappable but backend/modules/authentication/${providerKey}/ ` +
          'exists on disk — remove it from UNSUPPORTED_AUTH_PROVIDERS'
      )
    }
  })
})

describe('COMMENTS_UNMAPPABLE', () => {
  test('is a static no-destination-table entry', () => {
    assert.equal(COMMENTS_UNMAPPABLE.identifier, 'comments')
    assert.equal(COMMENTS_UNMAPPABLE.reason, 'no-destination-table')
    assert.match(COMMENTS_UNMAPPABLE.detail, /Epic 335/)
  })
})
