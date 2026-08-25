import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { jobLock as jobLockTable } from '../db/schema.ts'
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

/**
 * Non-UTC process TZ regression coverage (OpenProject #1639) -- `jobLock.lastCheckedAt` is now a
 * `timestamptz` column, so `isHealthy()`'s `lastCheckedAt.toTemporalInstant()` reads the same instant
 * regardless of the Node process's local zone. Before the conversion, a naive `timestamp` column was
 * decoded through the *process's* zone, so a heartbeat written seconds ago could appear to be hours in
 * the past or future depending on the host's offset -- `isHealthy()` would then wrongly report `false`
 * for a scheduler that is, in fact, alive.
 */
describe(
  'jobs.isHealthy under a non-UTC process TZ (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let jobsModel: typeof import('./jobs.ts').jobs
    let originalTz: string | undefined

    before(async () => {
      fixtures = await setupTestDb()
      ;({ jobs: jobsModel } = await import('./jobs.ts'))
      originalTz = process.env.TZ
    })

    after(async () => {
      process.env.TZ = originalTz
      await teardownTestDb()
    })

    test('reports healthy for a heartbeat written seconds ago', async () => {
      process.env.TZ = 'America/New_York'
      try {
        await fixtures.db
          .insert(jobLockTable)
          .values({ key: 'cron', lastCheckedAt: new Date() })
          .onConflictDoUpdate({
            target: jobLockTable.key,
            set: { lastCheckedAt: new Date() }
          })

        assert.equal(await jobsModel.isHealthy(), true)
      } finally {
        process.env.TZ = originalTz
      }
    })

    test('reports unhealthy for a heartbeat older than 15 minutes, identically under UTC', async () => {
      const staleAt = new Date(Date.now() - 20 * 60 * 1000)
      const writeAndCheck = async (tz: string): Promise<boolean> => {
        process.env.TZ = tz
        try {
          await fixtures.db
            .insert(jobLockTable)
            .values({ key: 'cron', lastCheckedAt: staleAt })
            .onConflictDoUpdate({
              target: jobLockTable.key,
              set: { lastCheckedAt: staleAt }
            })
          return jobsModel.isHealthy()
        } finally {
          process.env.TZ = originalTz
        }
      }

      assert.equal(await writeAndCheck('UTC'), false)
      assert.equal(await writeAndCheck('America/New_York'), false)
      await fixtures.db.delete(jobLockTable).where(eq(jobLockTable.key, 'cron'))
    })
  }
)
