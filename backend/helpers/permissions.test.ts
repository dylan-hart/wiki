import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ALL_PERMISSIONS, GLOBAL_PERMISSIONS, PAGE_PERMISSIONS } from './permissions.ts'

describe('helpers/permissions', () => {
  test('GLOBAL_PERMISSIONS matches the exact set the group editor offers', () => {
    assert.deepEqual(
      [...GLOBAL_PERMISSIONS].sort(),
      [
        'access:admin',
        'read:users',
        'manage:users',
        'read:groups',
        'manage:groups',
        'manage:navigation',
        'manage:theme',
        'manage:sites',
        'manage:system'
      ].sort()
    )
  })

  test('GLOBAL_PERMISSIONS and PAGE_PERMISSIONS are disjoint', () => {
    const overlap = GLOBAL_PERMISSIONS.filter((p) => PAGE_PERMISSIONS.includes(p))
    assert.deepEqual(overlap, [])
  })

  test('ALL_PERMISSIONS is the union of both closed lists, with no ungrantable 2.x names', () => {
    assert.equal(ALL_PERMISSIONS.length, GLOBAL_PERMISSIONS.length + PAGE_PERMISSIONS.length)
    for (const stale of ['read:sites', 'create:sites', 'create:users', 'write:groups']) {
      assert.ok(!ALL_PERMISSIONS.includes(stale), `${stale} must not be in the closed vocabulary`)
    }
  })
})
