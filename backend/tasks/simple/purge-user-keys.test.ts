import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { userKeys as userKeysTable } from '../../db/schema.ts'

/**
 * `task()` is the daily `purgeUserKeys` scheduled job (OpenProject #1684): it deletes `userKeys` rows
 * whose `validUntil` has passed, behind `models/userCredentials.ts#purgeExpiredKeys()`. This is a
 * suite -- a real row round-tripping through Postgres -- since the thing under test is the SQL
 * comparison against `now()`, matching how `purge-pageviews.ts` and `update-locales.ts` cover their
 * own scheduled-job siblings.
 */
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

  /** Inserts a userKeys row `hoursFromNow` hours from now and returns its id. */
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

    await task()

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

  test('does nothing when there is nothing expired', async () => {
    const validId = await seedKey('emailVerify', 24)

    await assert.doesNotReject(task())

    const [validRow] = await fixtures.db
      .select()
      .from(userKeysTable)
      .where(eq(userKeysTable.id, validId))
    assert.ok(validRow, 'expected the still-valid key to survive the purge')
  })
})
