import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { JOB_SCHEDULE_SEED, jobs } from './jobs.ts'
import {
  jobHistory as jobHistoryTable,
  jobLock as jobLockTable,
  jobSchedule as jobScheduleTable
} from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { runWithJobExecutionContext } from '../helpers/jobExecutionContext.ts'

test('JOB_SCHEDULE_SEED registers storageSyncTick on a short, valid cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'storageSyncTick')
  assert.ok(entry, 'expected a storageSyncTick entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED registers storageDailyBackup on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'storageDailyBackup')
  assert.ok(entry, 'expected a storageDailyBackup entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED registers cleanAuditLog on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'cleanAuditLog')
  assert.ok(entry, 'expected a cleanAuditLog entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED registers purgePageviews on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgePageviews')
  assert.ok(entry, 'expected a purgePageviews entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED never claims two tasks on the same cron expression (OpenProject #2059)', () => {
  // -> Two entries sharing a cron are claimed in the same `processJob` batch, where one task's
  //    write to shared config can race the other's read of it.
  const crons = JOB_SCHEDULE_SEED.map((e) => e.cron)
  assert.deepEqual(crons, [...new Set(crons)], 'expected every JOB_SCHEDULE_SEED cron to be unique')
})

test('JOB_SCHEDULE_SEED registers purgeContentSyncState on a valid daily cron, at a minute no other seeded job uses', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgeContentSyncState')
  assert.ok(entry, 'expected a purgeContentSyncState entry in the schedule seed')
  assert.equal(entry!.type, 'system')
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
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test("JOB_SCHEDULE_SEED registers replicationTick on a 5-minute cron, not storageSyncTick's every-minute one (OpenProject #2437)", () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'replicationTick')
  assert.ok(entry, 'expected a replicationTick entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  assert.equal(entry!.cron, '*/5 * * * *')
})

test('JOB_SCHEDULE_SEED registers purgePageWatchEvents on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgePageWatchEvents')
  assert.ok(entry, 'expected a purgePageWatchEvents entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)
})

test('JOB_SCHEDULE_SEED registers purgePageDrafts on a valid daily cron, at a minute no other seeded job uses', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgePageDrafts')
  assert.ok(entry, 'expected a purgePageDrafts entry in the schedule seed (OpenProject #2454)')
  assert.equal(entry!.type, 'system')
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)

  const crons: string[] = JOB_SCHEDULE_SEED.filter((e) => e.task !== 'purgePageDrafts').map(
    (e) => e.cron
  )
  const targetCron: string = entry!.cron
  assert.ok(
    !crons.includes(targetCron),
    `expected purgePageDrafts's cron minute to be unused by any other seeded job, got a clash on "${targetCron}"`
  )
})

test('JOB_SCHEDULE_SEED registers purgeSessions on a valid hourly cron, offset from purgeRateLimits', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgeSessions')
  assert.ok(entry, 'expected a purgeSessions entry in the schedule seed')
  assert.equal(entry!.type, 'system')
  assert.match(entry!.cron, /^(\S+\s+){4}\S+$/)

  const rateLimitsEntry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgeRateLimits')
  assert.ok(rateLimitsEntry, 'expected a purgeRateLimits entry in the schedule seed')
  assert.notEqual(entry!.cron.split(' ')[0], rateLimitsEntry!.cron.split(' ')[0])
})

test('JOB_SCHEDULE_SEED registers purgeGuestPii on a valid daily cron', () => {
  const entry = JOB_SCHEDULE_SEED.find((e) => e.task === 'purgeGuestPii')
  assert.ok(entry, 'expected a purgeGuestPii entry in the schedule seed')
  assert.equal(entry!.type, 'system')
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
      'replicationTick',
      'sendWatchDigests',
      'storageDailyBackup',
      'storageSyncTick',
      'updateLocales'
    ].sort()
  )
})

/**
 * Stand-in for the `Temporal` subset `isHealthy()` and `cleanHistory()` use, for a V8 build
 * compiled without native `Temporal`. `Date.prototype.toTemporalInstant` is part of it because
 * `isHealthy()` reads the `jobLock` row's `timestamp` column back as a `Date`.
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
 * `isHealthy()` and `cleanHistory()` both read a `timestamp` (no time zone) column back through
 * drizzle/`pg`, whose parser reconstructs the `Date` using the process's *local* `TZ` for a value
 * carrying no offset of its own. A mismatch is invisible on a UTC host, so these run pinned to a
 * non-UTC `TZ`.
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
      CARDINAL.config = { scheduler: { historyExpiration: 3600 } }

      await fixtures.db.insert(jobHistoryTable).values({
        task: 'staleHistoryTask',
        state: 'completed',
        useWorker: false,
        wasScheduled: false,
        payload: {},
        attempt: 1,
        maxRetries: 0,
        createdAt: new Date(Date.now() - 7200 * 1000),
        startedAt: new Date(Date.now() - 7200 * 1000)
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
          startedAt: new Date(Date.now() - 10 * 1000)
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
          startedAt: new Date(Date.now() - 7200 * 1000)
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
        // -> Models `processJob`'s reclaim: started at attempt 1, timed out, then reclaimed and
        //    completed as attempt 2 with that attempt's real result.
        attempt: 2,
        maxRetries: 3,
        createdAt: new Date(),
        result: { fileSize: 999 }
      })
      .returning()

    // -> The abandoned task was launched under attempt 1, so its captured context still says 1.
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

describe('reconcileSchedule (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
  })

  after(async () => {
    await teardownTestDb()
  })

  async function scheduleByTask() {
    const rows = await fixtures.db.select().from(jobScheduleTable)
    return new Map(rows.map((row) => [row.task, row]))
  }

  test('inserts every seeded task into an empty table', async () => {
    await fixtures.db.delete(jobScheduleTable)

    const result = await jobs.reconcileSchedule()

    assert.deepEqual(result, { inserted: JOB_SCHEDULE_SEED.length, updated: 0, removed: 0 })
    const rows = await scheduleByTask()
    assert.deepEqual([...rows.keys()].sort(), JOB_SCHEDULE_SEED.map((e) => e.task).sort())
    for (const entry of JOB_SCHEDULE_SEED) {
      assert.equal(rows.get(entry.task)!.cron, entry.cron)
      assert.equal(rows.get(entry.task)!.type, 'system')
    }
  })

  test('backfills only the missing tasks and leaves present rows untouched', async () => {
    await fixtures.db.delete(jobScheduleTable)
    await jobs.reconcileSchedule()
    const before = await scheduleByTask()
    await fixtures.db.delete(jobScheduleTable).where(eq(jobScheduleTable.task, 'purgePageDrafts'))

    const result = await jobs.reconcileSchedule()

    assert.deepEqual(result, { inserted: 1, updated: 0, removed: 0 })
    const after = await scheduleByTask()
    assert.ok(after.has('purgePageDrafts'))
    assert.deepEqual(
      after.get('checkVersion')!.updatedAt,
      before.get('checkVersion')!.updatedAt,
      'an unchanged row must not have its updatedAt bumped'
    )
    assert.equal(after.get('checkVersion')!.id, before.get('checkVersion')!.id)
  })

  test('is a no-op when the table already matches the seed', async () => {
    await fixtures.db.delete(jobScheduleTable)
    await jobs.reconcileSchedule()

    assert.deepEqual(await jobs.reconcileSchedule(), { inserted: 0, updated: 0, removed: 0 })
  })

  test('rewrites a changed cron and payload on a system row, keeping its id', async () => {
    await fixtures.db.delete(jobScheduleTable)
    await jobs.reconcileSchedule()
    const before = (await scheduleByTask()).get('cleanAuditLog')!
    await fixtures.db
      .update(jobScheduleTable)
      .set({ cron: '1 2 3 4 5', payload: { stale: true } })
      .where(eq(jobScheduleTable.task, 'cleanAuditLog'))

    const result = await jobs.reconcileSchedule()

    assert.deepEqual(result, { inserted: 0, updated: 1, removed: 0 })
    const after = (await scheduleByTask()).get('cleanAuditLog')!
    const seeded = JOB_SCHEDULE_SEED.find((e) => e.task === 'cleanAuditLog')!
    assert.equal(after.cron, seeded.cron)
    assert.equal(after.payload, null)
    assert.equal(after.id, before.id)
  })

  test('deletes system rows for tasks no longer in the seed', async () => {
    await fixtures.db.delete(jobScheduleTable)
    await jobs.reconcileSchedule()
    await fixtures.db
      .insert(jobScheduleTable)
      .values({ task: 'removedFromSeed', cron: '0 1 * * *', type: 'system' })

    const result = await jobs.reconcileSchedule()

    assert.deepEqual(result, { inserted: 0, updated: 0, removed: 1 })
    assert.equal((await scheduleByTask()).has('removedFromSeed'), false)
  })

  test('never touches rows that are not type system', async () => {
    await fixtures.db.delete(jobScheduleTable)
    await jobs.reconcileSchedule()
    await fixtures.db
      .insert(jobScheduleTable)
      .values({ task: 'customTask', cron: '0 3 * * *', type: 'custom' })
    await fixtures.db
      .update(jobScheduleTable)
      .set({ type: 'custom', cron: '9 9 * * *' })
      .where(eq(jobScheduleTable.task, 'checkVersion'))

    const result = await jobs.reconcileSchedule()

    assert.deepEqual(result, { inserted: 0, updated: 0, removed: 0 })
    const rows = await scheduleByTask()
    assert.equal(rows.get('customTask')!.cron, '0 3 * * *')
    assert.equal(rows.get('checkVersion')!.cron, '9 9 * * *')
    assert.equal(rows.get('checkVersion')!.type, 'custom')
  })
})
