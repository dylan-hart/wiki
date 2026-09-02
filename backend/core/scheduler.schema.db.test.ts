/**
 * The `jobSchedule.task` unique index, asserted against a real, migrated Postgres — the thing under
 * test IS the generated migration's constraint, which a mock of the query builder could not verify.
 *
 * Split out of `core/scheduler.test.ts` (TEST-F14); see that file's header for the whole map.
 */

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { inArray } from 'drizzle-orm'
import { jobSchedule as jobScheduleTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * OpenProject #2051: `jobSchedule.task` needs a unique index as defence in depth behind the
 * boot-time advisory lock (Epic #2037) — this asserts the db itself rejects a duplicate `task`
 * value, not just that the lock happens to prevent one in practice. Run against a real, migrated
 * Postgres (see `test/db.ts`) because the thing under test *is* the generated migration's
 * constraint, which a mock of the query builder couldn't verify.
 */
describe('jobSchedule.task unique index (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let scheduleIds: string[]

  before(async () => {
    fixtures = await setupTestDb()
  })

  after(async () => {
    await teardownTestDb()
  })

  beforeEach(() => {
    scheduleIds = []
  })

  afterEach(async () => {
    if (scheduleIds.length > 0) {
      await fixtures.db.delete(jobScheduleTable).where(inArray(jobScheduleTable.id, scheduleIds))
    }
  })

  test('allows a single jobSchedule row for a given task', async () => {
    const [row] = await fixtures.db
      .insert(jobScheduleTable)
      .values({ task: 'uniqueTaskTest', cron: '0 0 * * *' })
      .returning()
    scheduleIds.push(row!.id)

    assert.equal(row!.task, 'uniqueTaskTest')
  })

  test('rejects inserting a second jobSchedule row with an existing task value', async () => {
    const [row] = await fixtures.db
      .insert(jobScheduleTable)
      .values({ task: 'duplicateTaskTest', cron: '0 0 * * *' })
      .returning()
    scheduleIds.push(row!.id)

    await assert.rejects(
      () =>
        fixtures.db
          .insert(jobScheduleTable)
          .values({ task: 'duplicateTaskTest', cron: '0 12 * * *' }),
      (err: any) => {
        // Postgres unique_violation SQLSTATE, per the `jobSchedule_task_idx` unique index.
        assert.equal(err.code ?? err.cause?.code, '23505')
        return true
      }
    )
  })
})
