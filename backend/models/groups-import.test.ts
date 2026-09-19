import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { groups } from './groups.ts'
import { createEventsStub } from '../test/mocks.ts'

/**
 * `Groups` reads the ambient `CARDINAL` global for DB access, so each test installs a minimal fake on
 * `globalThis.CARDINAL` and restores whatever was there before. `reloadCache()` is deliberately left
 * to run for real against the faked `CARDINAL.db.select` chain rather than stubbed out: asserting it
 * actually ran, not just that the insert happened, is part of what this file covers.
 */

function installFakeWiki() {
  const previous = (globalThis as any).CARDINAL
  const insertedRows: any[] = []
  let selectCalls = 0
  ;(globalThis as any).CARDINAL = {
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
      ;(globalThis as any).CARDINAL = previous
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
