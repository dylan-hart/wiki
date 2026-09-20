import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { installTestWiki } from '../test/mocks.ts'
import { users } from './users.ts'

const SYSTEM_ID = '40000000-0000-4000-8000-000000000001'

function installWikiCapturingInsert() {
  const inserted: any[] = []
  const conflictTargets: unknown[] = []
  const handle = installTestWiki({
    data: { systemIds: { systemUserId: SYSTEM_ID } },
    db: {
      insert: mock.fn(() => ({
        values: mock.fn((row: any) => {
          inserted.push(row)
          return {
            onConflictDoNothing: mock.fn(async (config: any) => {
              conflictTargets.push(config?.target)
            })
          }
        })
      }))
    }
  })
  return { restore: handle.restore, inserted, conflictTargets }
}

describe('users.ensureSystemUser', () => {
  test('inserts a non-interactive system row at the fixed id and returns that id', async () => {
    const { restore, inserted } = installWikiCapturingInsert()
    try {
      const id = await users.ensureSystemUser()

      assert.equal(id, SYSTEM_ID)
      assert.equal(inserted.length, 1)
      const row = inserted[0]
      assert.equal(row.id, SYSTEM_ID)
      assert.equal(row.isSystem, true)
      assert.equal(row.isActive, false)
      assert.deepEqual(row.auth, {}, 'no auth strategy, so nothing can sign in as it')
      assert.match(row.email, /\.invalid$/)
    } finally {
      restore()
    }
  })

  test('is idempotent: the insert is a no-op conflict on the id, not a failure', async () => {
    const { restore, conflictTargets } = installWikiCapturingInsert()
    try {
      await users.ensureSystemUser()
      await users.ensureSystemUser()

      assert.equal(conflictTargets.length, 2)
      assert.ok(conflictTargets.every((target) => target !== undefined))
    } finally {
      restore()
    }
  })
})
