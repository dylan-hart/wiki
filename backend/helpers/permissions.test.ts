import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ALL_PERMISSIONS, GLOBAL_PERMISSIONS, PAGE_PERMISSIONS } from './permissions.ts'

describe('permissions', () => {
  test('GLOBAL_PERMISSIONS matches the exact list the group editor offers', () => {
    assert.deepEqual(GLOBAL_PERMISSIONS, [
      'access:admin',
      'manage:users',
      'manage:groups',
      'manage:navigation',
      'manage:theme',
      'manage:sites',
      'manage:system'
    ])
  })

  test('PAGE_PERMISSIONS matches the exact list page rules can grant', () => {
    assert.deepEqual(PAGE_PERMISSIONS, [
      'read:pages',
      'write:pages',
      'review:pages',
      'manage:pages',
      'delete:pages',
      'write:styles',
      'write:scripts',
      'read:source',
      'read:history',
      'read:assets',
      'write:assets',
      'manage:assets',
      'read:comments',
      'write:comments',
      'manage:comments'
    ])
  })

  test('neither list has an internal duplicate', () => {
    assert.equal(new Set(GLOBAL_PERMISSIONS).size, GLOBAL_PERMISSIONS.length)
    assert.equal(new Set(PAGE_PERMISSIONS).size, PAGE_PERMISSIONS.length)
  })

  test('the two lists are disjoint -- a permission string belongs to exactly one kind', () => {
    const globalSet = new Set(GLOBAL_PERMISSIONS)
    const overlap = PAGE_PERMISSIONS.filter((perm) => globalSet.has(perm))
    assert.deepEqual(overlap, [])
  })

  test('ALL_PERMISSIONS is exactly the union of both lists, in order', () => {
    assert.deepEqual(ALL_PERMISSIONS, [...GLOBAL_PERMISSIONS, ...PAGE_PERMISSIONS])
    assert.equal(ALL_PERMISSIONS.length, GLOBAL_PERMISSIONS.length + PAGE_PERMISSIONS.length)
  })

  test('manage:system is present as a global permission (it bypasses every check everywhere)', () => {
    assert.ok(GLOBAL_PERMISSIONS.includes('manage:system'))
  })
})
