import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { userKeys as userKeysTable } from '../../db/schema.ts'

describe('purge-user-keys.task (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let task: typeof import('./purge-user-keys.ts').task

  before(async () => {
    fixtures = await setupTestDb()
    ;({ task } = await import('./purge-user-keys.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  async function seedKey(kind: string, hoursFromNow: number): Promise<string> {
    const validUntil = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000)
    const [row] = await fixtures.db
      .insert(userKeysTable)
      .values({
        kind,
        token: `${kind}-${hoursFromNow}-${Math.random().toString(36).slice(2)}`,
        meta: {},
        validUntil,
        userId: fixtures.userId
      })
      .returning({ id: userKeysTable.id })
    return row!.id
  }

  test('removes only the expired key, leaving the still-valid one', async () => {
    const expiredId = await seedKey('resetPwd', -1)
    const validId = await seedKey('resetPwd', 24)

    assert.deepEqual(await task(), { summary: 'purged expired user keys', purged: 1 })

    const [expiredRow] = await fixtures.db
      .select()
      .from(userKeysTable)
      .where(eq(userKeysTable.id, expiredId))
    assert.equal(expiredRow, undefined)

    const [validRow] = await fixtures.db
      .select()
      .from(userKeysTable)
      .where(eq(userKeysTable.id, validId))
    assert.ok(validRow, 'expected the still-valid key to survive the purge')
  })

  test('does nothing, and reports nothing, when there is nothing expired', async () => {
    const validId = await seedKey('emailVerify', 24)

    // -> Nothing swept returns nothing, which is what keeps an empty nightly sweep out of an
    //    operator's `info` log.
    assert.equal(await task(), undefined)

    const [validRow] = await fixtures.db
      .select()
      .from(userKeysTable)
      .where(eq(userKeysTable.id, validId))
    assert.ok(validRow, 'expected the still-valid key to survive the purge')
  })
})
