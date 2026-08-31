import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { jobHistory as jobHistoryTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { JOB_SCHEDULE_SEED, jobs } from './jobs.ts'

/**
 * `JOB_SCHEDULE_SEED` is what `init()` inserts into `jobSchedule` on first boot -- asserted on
 * directly here, without a database, since `init()` itself is a straight `db.insert` of this array.
 */

test('JOB_SCHEDULE_SEED registers storageSyncTick on a short, valid cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'storageSyncTick')
  assert.ok(entry, 'expected a storageSyncTick entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  // -> A standard 5-field cron expression, e.g. "* * * * *" (every minute)
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED registers storageDailyBackup on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'storageDailyBackup')
  assert.ok(entry, 'expected a storageDailyBackup entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  // -> A standard 5-field cron expression, e.g. "30 2 * * *" (once a day)
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED registers cleanAuditLog on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'cleanAuditLog')
  assert.ok(entry, 'expected a cleanAuditLog entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  // -> A standard 5-field cron expression, e.g. "35 0 * * *" (once a day)
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED registers purgePageviews on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgePageviews')
  assert.ok(entry, 'expected a purgePageviews entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  // -> A standard 5-field cron expression, e.g. "25 0 * * *" (once a day)
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED still registers every pre-existing system task', () => {
  const tasks = JOB_SCHEDULE_SEED.map((e) => e.task)
  assert.deepEqual(
    [...tasks].sort(),
    [
      'checkVersion',
      'cleanAuditLog',
      'cleanJobHistory',
      'purgeExports',
      'purgeImports',
      'purgePageviews',
      'purgeRateLimits',
      'sendWatchDigests',
      'storageDailyBackup',
      'storageSyncTick',
      'updateLocales'
    ].sort()
  )
})

describe('countFailed (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
  })

  after(async () => {
    await teardownTestDb()
  })

  test('counts only jobHistory rows in the failed state', async () => {
    await fixtures.db.insert(jobHistoryTable).values([
      { task: 'testTask', state: 'failed', createdAt: new Date() },
      { task: 'testTask', state: 'failed', createdAt: new Date() },
      { task: 'testTask', state: 'completed', createdAt: new Date() },
      { task: 'testTask', state: 'active', createdAt: new Date() },
      { task: 'testTask', state: 'interrupted', createdAt: new Date() }
    ])

    assert.equal(await jobs.countFailed(), 2)
  })
})
