/**
 * The `jobSchedule.task` unique index, asserted against a real, migrated Postgres — the thing under
 * test IS the generated migration's constraint, which a mock of the query builder could not verify.
 */

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { inArray } from 'drizzle-orm'
import { jobSchedule as jobScheduleTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

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
        // Postgres `unique_violation`.
        assert.equal(err.code ?? err.cause?.code, '23505')
        return true
      }
    )
  })
})
