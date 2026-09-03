import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { syncRevocableGroupIds } from './groupSync.ts'

describe('syncRevocableGroupIds', () => {
  const guarded = { guestsGroupId: 'guests', systemGroupIds: [] as string[] }

  test('an empty mappableGroups allow-list revokes nothing', () => {
    assert.deepEqual(
      syncRevocableGroupIds({ mappableGroups: [], autoEnrollGroups: [] }, guarded),
      []
    )
  })

  test('an ordinary mappable group is revocable', () => {
    assert.deepEqual(
      syncRevocableGroupIds({ mappableGroups: ['editors'], autoEnrollGroups: [] }, guarded),
      ['editors']
    )
  })

  test('the guests group is never revocable, even if allow-listed', () => {
    assert.deepEqual(
      syncRevocableGroupIds({ mappableGroups: ['guests'], autoEnrollGroups: [] }, guarded),
      []
    )
  })

  test('a group also granted by autoEnrollGroups is not revocable', () => {
    assert.deepEqual(
      syncRevocableGroupIds(
        { mappableGroups: ['editors'], autoEnrollGroups: ['editors'] },
        guarded
      ),
      []
    )
  })

  test('a group carrying manage:system is never revocable, even if allow-listed', () => {
    assert.deepEqual(
      syncRevocableGroupIds(
        { mappableGroups: ['admins'], autoEnrollGroups: [] },
        { ...guarded, systemGroupIds: ['admins'] }
      ),
      []
    )
  })

  test('the configured root administrators group is never revocable, even if allow-listed', () => {
    assert.deepEqual(
      syncRevocableGroupIds(
        { mappableGroups: ['root-admins'], autoEnrollGroups: [] },
        { ...guarded, rootAdminGroupId: 'root-admins' }
      ),
      []
    )
  })

  test('mixes revocable and protected groups in one allow-list', () => {
    assert.deepEqual(
      syncRevocableGroupIds(
        { mappableGroups: ['editors', 'guests', 'reviewers'], autoEnrollGroups: ['reviewers'] },
        guarded
      ),
      ['editors']
    )
  })

  test('a missing mappableGroups/autoEnrollGroups is treated as empty, matching the real column default', () => {
    assert.deepEqual(syncRevocableGroupIds({}, guarded), [])
  })
})
