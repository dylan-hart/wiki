import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JOB_SCHEDULE_SEED } from './jobs.ts'

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

test('JOB_SCHEDULE_SEED never claims two tasks on the same cron expression (OpenProject #2059)', () => {
  // -> Two entries sharing a cron are claimed in the same `processJob` batch; checkVersion and
  //    updateLocales sharing '0 0 * * *' was how `WIKI.config.update.locales` got silently dropped.
  const crons = JOB_SCHEDULE_SEED.map((e) => e.cron)
  assert.deepEqual(crons, [...new Set(crons)], 'expected every JOB_SCHEDULE_SEED cron to be unique')
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
