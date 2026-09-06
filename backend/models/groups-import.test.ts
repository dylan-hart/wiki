import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { groups } from './groups.ts'
import { createEventsStub } from '../test/mocks.ts'

/**
 * Coverage for `Groups.createGroupFromImport()` (Feature 414, Task 730): the import-capable group
 * creation path that takes already-converted `permissions`/`rules` instead of seeding the same
 * starting defaults every brand-new group gets.
 *
 * `Groups` reads the ambient `WIKI` global for DB access, so each test installs a minimal fake on
 * `globalThis.WIKI` and restores whatever was there before — same approach as
 * `models/users-import.test.ts`. `reloadCache()` is a real method on the same singleton and is left
 * to run for real against the faked `WIKI.db.select` chain, rather than being stubbed out, since
 * asserting it actually ran (not just that the insert happened) is part of what this test covers.
 * `events` is `test/mocks.ts`'s stub: `createGroupFromImport()`'s write path also calls
 * `broadcastReload()`, which emits `reloadGroups` on `WIKI.events.outbound` after reloading — a real
 * `WIKI.events` is never needed here since no test in this file asserts on the emitted event.
 */

function installFakeWiki() {
  const previous = (globalThis as any).WIKI
  const insertedRows: any[] = []
  let selectCalls = 0
  ;(globalThis as any).WIKI = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    events: createEventsStub(),
    db: {
      insert() {
        return {
          values(row: any) {
            insertedRows.push(row)
            return {
              async returning() {
                return [{ id: 'new-group-uuid' }]
              }
            }
          }
        }
      },
      select() {
        selectCalls++
        return {
          from() {
            return Promise.resolve([])
          }
        }
      }
    }
  }
  return {
    insertedRows,
    selectCallCount: () => selectCalls,
    restore: () => {
      ;(globalThis as any).WIKI = previous
    }
  }
}

let restoreWiki: (() => void) | undefined

afterEach(() => {
  restoreWiki?.()
  restoreWiki = undefined
})

describe('Groups.createGroupFromImport', () => {
  test('writes the supplied permissions/rules verbatim, always non-system, and returns the new id', async () => {
    const fake = installFakeWiki()
    restoreWiki = fake.restore

    const rules = [
      {
        id: 'rule-uuid',
        name: 'Imported Rule 1',
        roles: ['read:pages'],
        match: 'START' as const,
        mode: 'ALLOW' as const,
        path: '',
        locales: [],
        sites: []
      }
    ]

    const id = await groups.createGroupFromImport({
      name: 'Editors',
      permissions: ['manage:navigation'],
      rules
    })

    assert.equal(id, 'new-group-uuid')
    assert.equal(fake.insertedRows.length, 1)
    assert.deepEqual(fake.insertedRows[0], {
      name: 'Editors',
      permissions: ['manage:navigation'],
      rules,
      isSystem: false
    })
  })

  test('reloads the rules cache after inserting', async () => {
    const fake = installFakeWiki()
    restoreWiki = fake.restore

    await groups.createGroupFromImport({ name: 'Editors', permissions: [], rules: [] })

    assert.equal(fake.selectCallCount(), 1)
  })
})
