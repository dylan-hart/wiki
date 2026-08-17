import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { narrowToScope } from './apiKeys.ts'

/**
 * `narrowToScope` is the intersection at the heart of API key scoping: a scope can only take
 * permissions away from what the key's groups grant, never hand it one the groups didn't already
 * hold. It touches neither `WIKI` nor the database, so this is a pure unit test — the DB-backed
 * wiring in `resolvePermissions()` (which groups' permissions get fetched from Postgres) is
 * unchanged by this feature and already exercised elsewhere; this suite covers only the new
 * narrowing behavior itself.
 */
describe('apiKeys.narrowToScope', () => {
  test('passes the group-derived permissions through unmodified when scope is null', () => {
    const permissions = ['read:pages', 'write:pages', 'manage:system']
    assert.deepEqual(narrowToScope(permissions, null), permissions)
  })

  test('narrows to the intersection when a scope is set', () => {
    const permissions = ['read:pages', 'write:pages', 'manage:system']
    assert.deepEqual(narrowToScope(permissions, ['read:pages', 'manage:system']), [
      'read:pages',
      'manage:system'
    ])
  })

  test('never grants a permission the groups did not already hold', () => {
    // -> The scope names a permission ('manage:users') none of the key's groups actually grant.
    //    A scope can only narrow, so the result must not contain it even though it is in the scope.
    const permissions = ['read:pages']
    assert.deepEqual(narrowToScope(permissions, ['read:pages', 'manage:users']), ['read:pages'])
  })

  test('an empty scope narrows the key down to nothing', () => {
    assert.deepEqual(narrowToScope(['read:pages', 'write:pages'], []), [])
  })
})
