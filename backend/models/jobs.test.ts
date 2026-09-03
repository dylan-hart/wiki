import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { JOB_SCHEDULE_SEED, jobs } from './jobs.ts'
import { jobHistory as jobHistoryTable, jobLock as jobLockTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { runWithJobExecutionContext } from '../helpers/jobExecutionContext.ts'

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

test('JOB_SCHEDULE_SEED registers purgeContentSyncState on a valid daily cron, at a minute no other seeded job uses', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgeContentSyncState')
  assert.ok(entry, 'expected a purgeContentSyncState entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  // -> A standard 5-field cron expression, e.g. "40 0 * * *" (once a day)
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)

  const crons: string[] = JOB_SCHEDULE_SEED.filter((e) => e.task !== 'purgeContentSyncState').map(
    (e) => e.cron
  )
  const targetCron: string = entry!.cron
  assert.ok(
    !crons.includes(targetCron),
    `expected purgeContentSyncState's cron minute to be unused by any other seeded job, got a clash on "${targetCron}"`
  )
})

test('JOB_SCHEDULE_SEED registers purgeUserKeys on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgeUserKeys')
  assert.ok(entry, 'expected a purgeUserKeys entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  // -> A standard 5-field cron expression, e.g. "45 0 * * *" (once a day)
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED registers purgePageWatchEvents on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgePageWatchEvents')
  assert.ok(entry, 'expected a purgePageWatchEvents entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  // -> A standard 5-field cron expression, e.g. "50 0 * * *" (once a day)
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED registers purgeSessions on a valid hourly cron, offset from purgeRateLimits', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgeSessions')
  assert.ok(entry, 'expected a purgeSessions entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  // -> A standard 5-field cron expression, e.g. "40 * * * *" (once an hour)
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)

  const rateLimitsEntry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgeRateLimits')
  assert.ok(rateLimitsEntry, 'expected a purgeRateLimits entry in the schedule seed')
  // -> Both run hourly against the same table-growth concern; they must not land on the same minute.
  assert.notEqual(entry!.cron.split(' ')[0], rateLimitsEntry!.cron.split(' ')[0])
})

test('JOB_SCHEDULE_SEED registers purgeGuestPii on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgeGuestPii')
  assert.ok(entry, 'expected a purgeGuestPii entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  // -> A standard 5-field cron expression, e.g. "55 0 * * *" (once a day)
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
      'purgeContentSyncState',
      'purgeExports',
      'purgeGuestPii',
      'purgeImports',
      'purgePageDrafts',
      'purgePageviews',
      'purgePageWatchEvents',
      'purgeRateLimits',
      'purgeSessions',
      'purgeUserKeys',
      'sendWatchDigests',
      'storageDailyBackup',
      'storageSyncTick',
      'updateLocales'
    ].sort()
  )
})

/**
 * Minimal stand-in for the subset of `Temporal` that `isHealthy()` and `cleanHistory()` call between
 * them: `Now.instant()`, `.subtract()`, `Instant.compare()`, plus `Date.prototype.toTemporalInstant`
 * on the read side (`isHealthy()` compares against the `Date` drizzle hands back for the `jobLock`
 * row's `timestamp` column).
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
 * v25.9.0, which doesn't expose it (same environment gap `core/scheduler.test.ts` and
 * `models/users.test.ts` work around, not a spec deviation).
 */
function installFakeTemporal(): void {
  const durationToMs = (d: { minutes?: number; seconds?: number }) =>
    (d.minutes ?? 0) * 60_000 + (d.seconds ?? 0) * 1_000
  const makeInstant = (epochMs: number): any => ({
    epochMilliseconds: epochMs,
    subtract: (d: any) => makeInstant(epochMs - durationToMs(d)),
    toString: () => new Date(epochMs).toISOString()
  })
  ;(globalThis as any).Temporal = {
    Now: { instant: () => makeInstant(Date.now()) },
    Instant: { compare: (a: any, b: any) => Math.sign(a.epochMilliseconds - b.epochMilliseconds) }
  }
  ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
    return makeInstant(this.getTime())
  }
}

function uninstallFakeTemporal(previousTemporal: any): void {
  ;(globalThis as any).Temporal = previousTemporal
  delete (Date.prototype as any).toTemporalInstant
}

/**
 * OpenProject #1653: both `isHealthy()` and `cleanHistory()` read a `timestamp` (no time zone) column
 * back through drizzle/`pg`, whose default parser reconstructs the resulting `Date` using the Node
 * process's *local* `TZ` for a value that carries no offset of its own -- see
 * `docs/audit-2026-08-24/correctness-data-schema.md` §2, and the epic this work package is part of
 * (converting every such column to `timestamptz`). The defect is invisible on a UTC host, which is
 * exactly why it needs coverage that runs off UTC: every test below runs under `TZ=America/New_York`
 * for its duration, alongside an identical run implied by the rest of this suite already passing
 * under whatever `TZ` CI and a UTC dev host run as.
 */
describe('jobs TZ regression (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let previousTemporal: any
  let previousTz: string | undefined

  before(async () => {
    previousTz = process.env.TZ
    process.env.TZ = 'America/New_York'
    previousTemporal = (globalThis as any).Temporal
    installFakeTemporal()
    fixtures = await setupTestDb()
  })

  after(async () => {
    await teardownTestDb()
    uninstallFakeTemporal(previousTemporal)
    if (previousTz === undefined) {
      delete process.env.TZ
    } else {
      process.env.TZ = previousTz
    }
  })

  describe('isHealthy (isSchedulerAlive)', () => {
    test('stays true for a heartbeat written seconds ago, even off UTC', async () => {
      await fixtures.db
        .insert(jobLockTable)
        .values({ key: 'cron', lastCheckedBy: 'test-instance' })
        .onConflictDoUpdate({
          target: jobLockTable.key,
          set: { lastCheckedBy: 'test-instance', lastCheckedAt: new Date() }
        })

      const healthy = await jobs.isHealthy()

      assert.equal(healthy, true)
    })

    test('reports unhealthy for a heartbeat older than 15 minutes, even off UTC', async () => {
      await fixtures.db
        .insert(jobLockTable)
        .values({
          key: 'cron',
          lastCheckedBy: 'test-instance',
          lastCheckedAt: new Date(Date.now() - 20 * 60 * 1000)
        })
        .onConflictDoUpdate({
          target: jobLockTable.key,
          set: {
            lastCheckedBy: 'test-instance',
            lastCheckedAt: new Date(Date.now() - 20 * 60 * 1000)
          }
        })

      const healthy = await jobs.isHealthy()

      assert.equal(healthy, false)
    })
  })

  describe('cleanHistory (retention cutoff)', () => {
    test('selects the same rows for deletion as it would under UTC', async () => {
      WIKI.config = { scheduler: { historyExpiration: 3600 } } // 1 hour retention

      await fixtures.db.insert(jobHistoryTable).values({
        task: 'staleHistoryTask',
        state: 'completed',
        useWorker: false,
        wasScheduled: false,
        payload: {},
        attempt: 1,
        maxRetries: 0,
        createdAt: new Date(Date.now() - 7200 * 1000),
        startedAt: new Date(Date.now() - 7200 * 1000) // 2 hours ago -> past retention
      })

      const [freshRow] = await fixtures.db
        .insert(jobHistoryTable)
        .values({
          task: 'freshHistoryTask',
          state: 'completed',
          useWorker: false,
          wasScheduled: false,
          payload: {},
          attempt: 1,
          maxRetries: 0,
          createdAt: new Date(Date.now() - 10 * 1000),
          startedAt: new Date(Date.now() - 10 * 1000) // 10 seconds ago -> well within retention
        })
        .returning()

      const [activeRow] = await fixtures.db
        .insert(jobHistoryTable)
        .values({
          task: 'staleButActiveTask',
          state: 'active',
          useWorker: false,
          wasScheduled: false,
          payload: {},
          attempt: 1,
          maxRetries: 0,
          createdAt: new Date(Date.now() - 7200 * 1000),
          startedAt: new Date(Date.now() - 7200 * 1000) // 2 hours ago, but still active -> kept
        })
        .returning()

      await jobs.cleanHistory()

      const remaining = await fixtures.db
        .select({ id: jobHistoryTable.id })
        .from(jobHistoryTable)
        .where(eq(jobHistoryTable.task, 'staleHistoryTask'))
      assert.equal(remaining.length, 0, 'a row past the retention window must be deleted')

      const [stillFresh] = await fixtures.db
        .select({ id: jobHistoryTable.id })
        .from(jobHistoryTable)
        .where(eq(jobHistoryTable.id, freshRow!.id))
      assert.ok(stillFresh, 'a row well within the retention window must survive')

      const [stillActive] = await fixtures.db
        .select({ id: jobHistoryTable.id })
        .from(jobHistoryTable)
        .where(eq(jobHistoryTable.id, activeRow!.id))
      assert.ok(stillActive, 'an active row must never be purged regardless of age')
    })
  })
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

/**
 * OpenProject #2351: `setResult()` fences its write against `helpers/jobExecutionContext.ts`'s
 * attempt number so a stale, timed-out `executeInProcess` task's late call cannot clobber a later
 * retry's result. See `core/scheduler.test.ts`'s `executeInProcess (fake WIKI)` suite for coverage
 * of the context itself surviving a stale continuation; this suite covers the actual `UPDATE`
 * fencing against the database.
 */
describe('setResult (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
  })

  after(async () => {
    await teardownTestDb()
  })

  test('writes the result when the calling context has no captured job id', async () => {
    const [row] = await fixtures.db
      .insert(jobHistoryTable)
      .values({
        task: 'exportContent',
        state: 'active',
        useWorker: false,
        wasScheduled: false,
        attempt: 1,
        maxRetries: 0,
        createdAt: new Date()
      })
      .returning()

    await jobs.setResult(row!.id, { fileSize: 42 })

    const [after] = await fixtures.db
      .select({ result: jobHistoryTable.result })
      .from(jobHistoryTable)
      .where(eq(jobHistoryTable.id, row!.id))
    assert.deepEqual(after!.result, { fileSize: 42 })
  })

  test('writes the result when the captured attempt still matches jobHistory.attempt', async () => {
    const [row] = await fixtures.db
      .insert(jobHistoryTable)
      .values({
        task: 'exportContent',
        state: 'active',
        useWorker: false,
        wasScheduled: false,
        attempt: 2,
        maxRetries: 3,
        createdAt: new Date()
      })
      .returning()

    await runWithJobExecutionContext({ jobId: row!.id, attempt: 2 }, () =>
      jobs.setResult(row!.id, { fileSize: 7 })
    )

    const [after] = await fixtures.db
      .select({ result: jobHistoryTable.result })
      .from(jobHistoryTable)
      .where(eq(jobHistoryTable.id, row!.id))
    assert.deepEqual(after!.result, { fileSize: 7 })
  })

  test('drops a stale write once a later reclaim has moved jobHistory.attempt past it', async () => {
    const [row] = await fixtures.db
      .insert(jobHistoryTable)
      .values({
        task: 'exportContent',
        state: 'active',
        useWorker: false,
        wasScheduled: false,
        // -> Models `processJob`'s reclaim: the row started at attempt 1, timed out, and was
        //    reclaimed and completed as attempt 2 -- carrying that attempt's real result -- before
        //    the abandoned attempt-1 task's own, stale `setResult()` call ever arrives.
        attempt: 2,
        maxRetries: 3,
        createdAt: new Date(),
        result: { fileSize: 999 }
      })
      .returning()

    // -> The stale task was launched under attempt 1, so its captured context still says 1 even
    //    though the row has since moved to 2.
    await runWithJobExecutionContext({ jobId: row!.id, attempt: 1 }, () =>
      jobs.setResult(row!.id, { fileSize: 1 })
    )

    const [after] = await fixtures.db
      .select({ result: jobHistoryTable.result })
      .from(jobHistoryTable)
      .where(eq(jobHistoryTable.id, row!.id))
    assert.deepEqual(
      after!.result,
      { fileSize: 999 },
      'the later retry result must survive the stale write'
    )
  })

  test('a stale write for one job id never touches a different job id', async () => {
    const [row] = await fixtures.db
      .insert(jobHistoryTable)
      .values({
        task: 'exportContent',
        state: 'active',
        useWorker: false,
        wasScheduled: false,
        attempt: 1,
        maxRetries: 0,
        createdAt: new Date()
      })
      .returning()

    // -> A context captured for some other job id must not fence (or otherwise affect) a write
    //    aimed at this one.
    await runWithJobExecutionContext({ jobId: 'unrelated-job-id', attempt: 1 }, () =>
      jobs.setResult(row!.id, { fileSize: 5 })
    )

    const [after] = await fixtures.db
      .select({ result: jobHistoryTable.result })
      .from(jobHistoryTable)
      .where(eq(jobHistoryTable.id, row!.id))
    assert.deepEqual(after!.result, { fileSize: 5 })
  })
})
