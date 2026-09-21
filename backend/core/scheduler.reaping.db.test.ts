/**
 * `reapStaleJobs()` and `processJob()`'s claim path against a real, migrated Postgres: the SQL's
 * atomicity and row-level locking are under test, which a mocked query builder cannot verify.
 */

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import { jobs as jobsTable, jobHistory as jobHistoryTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'

let scheduler: any

before(async () => {
  await ensureTemporal()
  scheduler = (await import('./scheduler.ts')).default
})

/**
 * `reapStaleJobs()` sweeps every stale row in the table, not just one test's own, so every test
 * deletes the ids it created in `afterEach`.
 */
describe(
  'reapStaleJobs / processJob claim-and-retry (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let historyIds: string[]
    let jobIds: string[]

    before(async () => {
      fixtures = await setupTestDb()
      scheduler.tasks = {}
      scheduler.maxWorkers = 1
      scheduler.activeWorkers = 0
      // -> `taskTimeout: 1` keeps the never-settling in-process task test fast.
      CARDINAL.config = {
        scheduler: { retryBackoff: 0, staleJobTimeout: 1, maxRetries: 2, taskTimeout: 1 }
      }
    })

    after(async () => {
      await teardownTestDb()
    })

    beforeEach(() => {
      historyIds = []
      jobIds = []
    })

    afterEach(async () => {
      if (historyIds.length > 0) {
        await fixtures.db.delete(jobHistoryTable).where(inArray(jobHistoryTable.id, historyIds))
      }
      if (jobIds.length > 0) {
        await fixtures.db.delete(jobsTable).where(inArray(jobsTable.id, jobIds))
      }
    })

    function pastDate(secondsAgo: number): Date {
      return new Date(Date.now() - secondsAgo * 1000)
    }

    async function insertActiveHistory(overrides: Partial<any> = {}) {
      const [row] = await fixtures.db
        .insert(jobHistoryTable)
        .values({
          task: 'stuckTask',
          state: 'active',
          useWorker: false,
          wasScheduled: false,
          payload: {},
          attempt: 1,
          maxRetries: 2,
          executedBy: 'dead-instance',
          createdAt: pastDate(120),
          startedAt: pastDate(120),
          ...overrides
        })
        .returning()
      return row!
    }

    test('leaves a still-fresh active row alone', async () => {
      const row = await insertActiveHistory({ startedAt: new Date() })
      historyIds.push(row.id)

      const requeued = await scheduler.reapStaleJobs()

      assert.equal(requeued, 0)
      const [after1] = await fixtures.db
        .select()
        .from(jobHistoryTable)
        .where(eq(jobHistoryTable.id, row.id))
      assert.equal(after1.state, 'active')
    })

    test('flips a stuck active row to interrupted and requeues it once staleJobTimeout has elapsed', async () => {
      const row = await insertActiveHistory()
      historyIds.push(row.id)

      const requeued = await scheduler.reapStaleJobs()
      jobIds.push(row.id)

      assert.equal(requeued, 1)
      const [after1] = await fixtures.db
        .select()
        .from(jobHistoryTable)
        .where(eq(jobHistoryTable.id, row.id))
      assert.equal(after1.state, 'interrupted')
      assert.match(after1.lastErrorMessage ?? '', /No instance reported on this job/)

      const [requeuedJob] = await fixtures.db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, row.id))
      assert.ok(requeuedJob, 'a fresh row must exist in jobs for the next instance to pick up')
      assert.equal(requeuedJob.task, 'stuckTask')
      assert.ok(
        requeuedJob.waitUntil instanceof Date,
        'a requeued row must carry an explicit waitUntil, never null'
      )
    })

    test('requeues a scheduled job (wasScheduled: true) with a non-null waitUntil', async () => {
      const row = await insertActiveHistory({ wasScheduled: true, task: 'scheduledTask' })
      historyIds.push(row.id)

      await scheduler.reapStaleJobs()
      jobIds.push(row.id)

      const [requeuedJob] = await fixtures.db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, row.id))
      assert.ok(requeuedJob)
      assert.equal(requeuedJob.isScheduled, true)
      assert.ok(
        requeuedJob.waitUntil instanceof Date,
        'a requeued scheduled row must never have a null waitUntil (OpenProject #929)'
      )
    })

    test('does not requeue a stale job that has exhausted its retries', async () => {
      const row = await insertActiveHistory({ attempt: 3, maxRetries: 2 })
      historyIds.push(row.id)

      const requeued = await scheduler.reapStaleJobs()

      assert.equal(requeued, 0)
      const [after1] = await fixtures.db
        .select()
        .from(jobHistoryTable)
        .where(eq(jobHistoryTable.id, row.id))
      // -> The claiming UPDATE ignores attempt count; only the requeue into `jobs` skips this row.
      assert.equal(after1.state, 'interrupted')
      const stillQueued = await fixtures.db.select().from(jobsTable).where(eq(jobsTable.id, row.id))
      assert.equal(stillQueued.length, 0)
    })

    test('an abandoned interrupted job is named at warn, with its attempt out of the total', async () => {
      const row = await insertActiveHistory({ attempt: 3, maxRetries: 2 })
      historyIds.push(row.id)
      const warn = mock.fn()
      const originalWarn = CARDINAL.logger.warn
      CARDINAL.logger.warn = warn as any

      try {
        await scheduler.reapStaleJobs()
      } finally {
        CARDINAL.logger.warn = originalWarn
      }

      const abandoned = warn.mock.calls
        .map((call) => call.arguments as any[])
        .find((args) => args[1] === 'stuckTask interrupted, no attempts left')
      assert.ok(abandoned, 'the abandoned job must be named individually, not only counted')
      assert.equal(abandoned[0], 'jobs')
      assert.deepEqual(abandoned[2], { job: row.id, attempt: '3/3' })

      const roundUp = warn.mock.calls
        .map((call) => call.arguments as any[])
        .find((args) => args[1] === 'requeued interrupted jobs')
      assert.ok(roundUp, 'the sweep still reports what it found')
      assert.equal(roundUp[2].found, 1)
      assert.equal(roundUp[2].requeued, 0, 'found is not requeued: this one was abandoned')
    })

    test('a sweep that found nothing says so at debug, and says nothing at warn', async () => {
      const warn = mock.fn()
      const debug = mock.fn()
      const originalWarn = CARDINAL.logger.warn
      const originalDebug = CARDINAL.logger.debug
      CARDINAL.logger.warn = warn as any
      CARDINAL.logger.debug = debug as any

      try {
        // -> Nothing to find: this test inserts no rows, and every other one deletes its own.
        await scheduler.reapStaleJobs()
      } finally {
        CARDINAL.logger.warn = originalWarn
        CARDINAL.logger.debug = originalDebug
      }

      const idle = debug.mock.calls
        .map((call) => call.arguments as any[])
        .find((args) => args[1] === 'no interrupted jobs found')
      assert.ok(idle, 'the healthy, every-tick case is recorded at debug')
      assert.equal(idle[0], 'jobs')
      assert.equal(
        warn.mock.calls.filter((call) => call.arguments[1] === 'requeued interrupted jobs').length,
        0,
        'an empty sweep must not reach an operator shipping warn'
      )
    })

    /**
     * `CARDINAL.scheduler` is `createSchedulerStub()`'s plain object, not the module under test.
     * `notifier` reads `CARDINAL.scheduler.pubsubClient` on every send, so a fake `query()` there
     * observes the NOTIFY without a real LISTEN/NOTIFY client.
     */
    test('sends a jobCompleted NOTIFY for a job it abandons, since nothing else ever will', async () => {
      const row = await insertActiveHistory({
        attempt: 3,
        maxRetries: 2,
        lastErrorMessage: null
      })
      historyIds.push(row.id)
      let settled = 0
      const query = mock.fn(async (_sql: string, _params?: any[]) => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        settled++
        return {} as any
      })
      CARDINAL.scheduler.pubsubClient = { query } as any

      try {
        await scheduler.reapStaleJobs()
      } finally {
        CARDINAL.scheduler.pubsubClient = null
      }

      assert.equal(query.mock.callCount(), 1)
      assert.equal(settled, 1, 'the sweep returned before its NOTIFY finished')
      const [sql, params] = query.mock.calls[0]!.arguments
      assert.match(sql as string, /pg_notify/)
      const [channel, payload] = params as [string, string]
      assert.equal(channel, 'scheduler')
      const decoded = JSON.parse(payload)
      assert.equal(decoded.event, 'jobCompleted')
      assert.equal(decoded.state, 'failed')
      assert.equal(decoded.id, row.id)
    })

    test('two concurrent sweeps never both requeue the same stranded job', async () => {
      const row = await insertActiveHistory({ maxRetries: 5 })
      historyIds.push(row.id)

      const [a, b] = await Promise.all([scheduler.reapStaleJobs(), scheduler.reapStaleJobs()])
      jobIds.push(row.id)

      assert.equal(
        a + b,
        1,
        'exactly one of the two concurrent sweeps should have claimed the stale row'
      )

      const requeuedRows = await fixtures.db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, row.id))
      assert.equal(requeuedRows.length, 1, 'the job must be requeued exactly once, not duplicated')

      const [after1] = await fixtures.db
        .select()
        .from(jobHistoryTable)
        .where(eq(jobHistoryTable.id, row.id))
      assert.equal(after1.state, 'interrupted')
    })

    test('a job the original runner already requeued is a conflict no-op, not a duplicate-key throw', async () => {
      const row = await insertActiveHistory({ maxRetries: 5 })
      historyIds.push(row.id)
      jobIds.push(row.id)

      // -> Stands in for the still-alive original runner's retry insert, which reuses the job id,
      //    reaching `jobs` first.
      await fixtures.db.insert(jobsTable).values({
        id: row.id,
        task: row.task,
        useWorker: row.useWorker,
        retries: row.attempt,
        maxRetries: row.maxRetries,
        isScheduled: row.wasScheduled,
        waitUntil: new Date(),
        createdBy: 'other-instance'
      })

      const requeued = await scheduler.reapStaleJobs()

      assert.equal(requeued, 0, 'a conflicting id must not be double-counted as requeued')
      const rows = await fixtures.db.select().from(jobsTable).where(eq(jobsTable.id, row.id))
      assert.equal(rows.length, 1, 'the conflict must be a no-op, not a second row or a crash')
      assert.equal(
        rows[0]!.createdBy,
        'other-instance',
        'onConflictDoNothing must leave the existing row untouched'
      )
    })

    test('one job failing to requeue does not strand the stale jobs after it', async () => {
      const rowA = await insertActiveHistory({ task: 'reap2009TaskA' })
      const rowB = await insertActiveHistory({ task: 'reap2009TaskB' })
      const rowC = await insertActiveHistory({ task: 'reap2009TaskC' })
      historyIds.push(rowA.id, rowB.id, rowC.id)
      jobIds.push(rowA.id, rowB.id, rowC.id)

      const originalInsert = CARDINAL.db.insert.bind(CARDINAL.db)
      ;(CARDINAL.db as any).insert = (table: any) => {
        if (table !== jobsTable) return originalInsert(table)
        return {
          values: (vals: any) => {
            if (vals.task === 'reap2009TaskB') {
              return {
                onConflictDoNothing: () => ({
                  returning: () => Promise.reject(new Error('simulated insert failure'))
                })
              }
            }
            return originalInsert(table).values(vals)
          }
        }
      }

      const warnCalls: any[][] = []
      const originalWarn = CARDINAL.logger.warn
      CARDINAL.logger.warn = ((...args: any[]) => {
        warnCalls.push(args)
      }) as any

      let requeued: number
      try {
        requeued = await scheduler.reapStaleJobs()
      } finally {
        CARDINAL.db.insert = originalInsert
        CARDINAL.logger.warn = originalWarn
      }

      assert.equal(requeued, 2, 'only the two successful inserts should count toward the total')

      const queuedA = await fixtures.db.select().from(jobsTable).where(eq(jobsTable.id, rowA.id))
      const queuedB = await fixtures.db.select().from(jobsTable).where(eq(jobsTable.id, rowB.id))
      const queuedC = await fixtures.db.select().from(jobsTable).where(eq(jobsTable.id, rowC.id))
      assert.equal(queuedA.length, 1, 'the job before the failure must still be requeued')
      assert.equal(queuedB.length, 0, 'the failing job itself was never inserted')
      assert.equal(queuedC.length, 1, 'the job after the failure must not be stranded by it')

      const failedRequeue = warnCalls.find((args) => args[1] === 'failed to requeue job')
      assert.ok(failedRequeue, 'the failing job must be reported')
      assert.equal(failedRequeue[0], 'jobs')
      assert.equal(failedRequeue[2].job, rowB.id, 'the warning must name the failing job id')
      assert.equal(failedRequeue[2].task, 'reap2009TaskB')
      assert.equal((failedRequeue[2].error as Error).message, 'simulated insert failure')
    })

    test('an in-process task whose promise never settles is recorded failed and returns activeWorkers to 0', async () => {
      scheduler.tasks = { neverSettles: () => new Promise(() => {}) }
      try {
        const [job] = await fixtures.db
          .insert(jobsTable)
          .values({
            task: 'neverSettles',
            useWorker: false,
            retries: 0,
            maxRetries: 0,
            payload: {},
            createdBy: 'test'
          })
          .returning()
        historyIds.push(job!.id)

        await scheduler.processJob()

        assert.equal(
          scheduler.activeWorkers,
          0,
          'the slot must be returned once runJob settles, even though the task itself never did'
        )

        const [history] = await fixtures.db
          .select()
          .from(jobHistoryTable)
          .where(eq(jobHistoryTable.id, job!.id))
        assert.equal(history.state, 'failed')
      } finally {
        scheduler.tasks = {}
      }
    })

    /**
     * `runJob()` is stubbed to a no-op to model a process killed mid-task: the job is claimed and
     * nothing is ever recorded.
     */
    test('reclaiming after an interruption advances attempt, so maxRetries is eventually honored', async () => {
      const originalRunJob = scheduler.runJob
      scheduler.runJob = async () => {}
      try {
        const [job] = await fixtures.db
          .insert(jobsTable)
          .values({
            task: 'neverFinishes',
            useWorker: false,
            retries: 0,
            maxRetries: 1,
            payload: {},
            createdBy: 'test'
          })
          .returning()
        historyIds.push(job!.id)
        jobIds.push(job!.id)

        await scheduler.processJob()
        await fixtures.db
          .update(jobHistoryTable)
          .set({ startedAt: pastDate(120) })
          .where(eq(jobHistoryTable.id, job!.id))
        const firstReap = await scheduler.reapStaleJobs()
        assert.equal(
          firstReap,
          1,
          'attempt 1 should be requeued: its one retry has not been used yet'
        )

        // The retry reclaims the SAME jobHistory row, which exercises the insert's ON CONFLICT DO
        // UPDATE path.
        await fixtures.db
          .update(jobsTable)
          .set({ waitUntil: pastDate(1) })
          .where(eq(jobsTable.id, job!.id))
        await scheduler.processJob()
        const [reclaimed] = await fixtures.db
          .select()
          .from(jobHistoryTable)
          .where(eq(jobHistoryTable.id, job!.id))
        assert.equal(reclaimed!.state, 'active', 'the retry must have reclaimed the requeued row')
        await fixtures.db
          .update(jobHistoryTable)
          .set({ startedAt: pastDate(120) })
          .where(eq(jobHistoryTable.id, job!.id))
        const secondReap = await scheduler.reapStaleJobs()

        assert.equal(
          secondReap,
          0,
          'maxRetries (1) allows one retry; attempt must have advanced past it by the second interruption'
        )
      } finally {
        scheduler.runJob = originalRunJob
      }
    })

    test('reclaiming after an interruption clears lastErrorMessage once the retry succeeds', async () => {
      const originalTasks = scheduler.tasks
      scheduler.tasks = { retrySucceeds: async () => {} }
      try {
        const [job] = await fixtures.db
          .insert(jobsTable)
          .values({
            task: 'retrySucceeds',
            useWorker: false,
            retries: 0,
            maxRetries: 1,
            payload: {},
            createdBy: 'test'
          })
          .returning()
        historyIds.push(job!.id)
        jobIds.push(job!.id)

        // A no-op `runJob()` models a process killed mid-task: claimed, nothing recorded.
        const originalRunJob = scheduler.runJob
        scheduler.runJob = async () => {}
        try {
          await scheduler.processJob()
        } finally {
          scheduler.runJob = originalRunJob
        }
        await fixtures.db
          .update(jobHistoryTable)
          .set({ startedAt: pastDate(120) })
          .where(eq(jobHistoryTable.id, job!.id))
        const requeued = await scheduler.reapStaleJobs()
        assert.equal(requeued, 1)

        const [interrupted] = await fixtures.db
          .select()
          .from(jobHistoryTable)
          .where(eq(jobHistoryTable.id, job!.id))
        assert.match(interrupted!.lastErrorMessage ?? '', /No instance reported on this job/)

        /*
          `waitUntil` is backdated rather than left as `reapStaleJobs()` wrote it. That value is Node's
          `new Date()`, while `processJob()` claims on `"waitUntil" <= NOW()` and postgres's `NOW()` is
          the claiming transaction's start -- so a requeued row can be a millisecond or two in that
          transaction's future and not be claimed until a later poll.
        */
        await fixtures.db
          .update(jobsTable)
          .set({ waitUntil: pastDate(1) })
          .where(eq(jobsTable.id, job!.id))
        await scheduler.processJob()

        const [after1] = await fixtures.db
          .select()
          .from(jobHistoryTable)
          .where(eq(jobHistoryTable.id, job!.id))
        assert.equal(after1!.state, 'completed')
        assert.equal(after1!.lastErrorMessage, null)
      } finally {
        scheduler.tasks = originalTasks
      }
    })

    /**
     * Deterministic, not a timing race: `Promise.all` starts both calls in one tick, and each runs
     * its synchronous prefix -- reading `activeWorkers` and reserving its slots -- before yielding
     * at its first `await`, so the second call always sees the first's reservation.
     */
    test('two concurrent processJob() calls together claim no more than maxWorkers jobs', async () => {
      const originalRunJob = scheduler.runJob
      const originalMaxWorkers = scheduler.maxWorkers
      scheduler.runJob = async () => {}
      scheduler.maxWorkers = 2
      scheduler.activeWorkers = 0
      try {
        const inserted = await fixtures.db
          .insert(jobsTable)
          .values([
            {
              task: 'raceTask',
              useWorker: false,
              retries: 0,
              maxRetries: 1,
              payload: {},
              createdBy: 'test'
            },
            {
              task: 'raceTask',
              useWorker: false,
              retries: 0,
              maxRetries: 1,
              payload: {},
              createdBy: 'test'
            },
            {
              task: 'raceTask',
              useWorker: false,
              retries: 0,
              maxRetries: 1,
              payload: {},
              createdBy: 'test'
            }
          ])
          .returning()
        for (const job of inserted) {
          historyIds.push(job.id)
          jobIds.push(job.id)
        }

        await Promise.all([scheduler.processJob(), scheduler.processJob()])

        const remaining = await fixtures.db
          .select()
          .from(jobsTable)
          .where(
            inArray(
              jobsTable.id,
              inserted.map((j) => j.id)
            )
          )
        const claimedCount = inserted.length - remaining.length

        assert.equal(
          claimedCount,
          2,
          `expected exactly maxWorkers (2) jobs claimed across both concurrent calls, got ${claimedCount}`
        )
        assert.equal(
          scheduler.activeWorkers,
          0,
          'activeWorkers must return to 0 once both concurrent calls have fully settled'
        )
      } finally {
        scheduler.runJob = originalRunJob
        scheduler.maxWorkers = originalMaxWorkers
      }
    })
  }
)

/**
 * `reapStaleJobs()`'s cutoff comparison runs server-side -- `startedAt` and `cutoff` both reach
 * postgres as parameters and are never read back through the `pg` driver's `Date` reconstruction --
 * so it must select the same rows whatever the Node process's `TZ`.
 */
describe(
  'reapStaleJobs stale-cutoff correctness under a non-UTC TZ (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let historyIds: string[]
    let jobIds: string[]
    let previousTz: string | undefined

    before(async () => {
      previousTz = process.env.TZ
      process.env.TZ = 'America/New_York'
      fixtures = await setupTestDb()
      scheduler.tasks = {}
      scheduler.maxWorkers = 1
      scheduler.activeWorkers = 0
      CARDINAL.config = { scheduler: { retryBackoff: 0, staleJobTimeout: 1, maxRetries: 2 } }
    })

    after(async () => {
      await teardownTestDb()
      if (previousTz === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previousTz
      }
    })

    beforeEach(() => {
      historyIds = []
      jobIds = []
    })

    afterEach(async () => {
      if (historyIds.length > 0) {
        await fixtures.db.delete(jobHistoryTable).where(inArray(jobHistoryTable.id, historyIds))
      }
      if (jobIds.length > 0) {
        await fixtures.db.delete(jobsTable).where(inArray(jobsTable.id, jobIds))
      }
    })

    function pastDate(secondsAgo: number): Date {
      return new Date(Date.now() - secondsAgo * 1000)
    }

    async function insertActiveHistory(overrides: Partial<any> = {}) {
      const [row] = await fixtures.db
        .insert(jobHistoryTable)
        .values({
          task: 'stuckTaskTz',
          state: 'active',
          useWorker: false,
          wasScheduled: false,
          payload: {},
          attempt: 1,
          maxRetries: 2,
          executedBy: 'dead-instance',
          createdAt: pastDate(120),
          startedAt: pastDate(120),
          ...overrides
        })
        .returning()
      return row!
    }

    test('leaves a still-fresh active row alone, identically under TZ=America/New_York', async () => {
      const row = await insertActiveHistory({ startedAt: new Date() })
      historyIds.push(row.id)

      const requeued = await scheduler.reapStaleJobs()

      assert.equal(requeued, 0)
      const [after1] = await fixtures.db
        .select()
        .from(jobHistoryTable)
        .where(eq(jobHistoryTable.id, row.id))
      assert.equal(after1.state, 'active')
    })

    test('flips a stuck active row to interrupted once staleJobTimeout has elapsed, identically under TZ=America/New_York', async () => {
      const row = await insertActiveHistory()
      historyIds.push(row.id)

      const requeued = await scheduler.reapStaleJobs()
      jobIds.push(row.id)

      assert.equal(requeued, 1)
      const [after1] = await fixtures.db
        .select()
        .from(jobHistoryTable)
        .where(eq(jobHistoryTable.id, row.id))
      assert.equal(after1.state, 'interrupted')
    })
  }
)
