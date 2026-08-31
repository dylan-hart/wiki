import assert from 'node:assert/strict'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { FixedThreadPool } from 'poolifier'
import { eq, inArray } from 'drizzle-orm'
import {
  jobs as jobsTable,
  jobSchedule as jobScheduleTable,
  jobHistory as jobHistoryTable
} from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * Minimal stand-in for the subset of `Temporal.Instant` this file's code under test calls
 * (`Now.instant()`, `.add()`, `.subtract()`, `.toString({ smallestUnit })`, `.epochMilliseconds`).
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
 * v25.9.0, which doesn't expose it (same environment gap noted in tasks 753/756/757/760/761 — not a
 * spec deviation). Stubbing just what these code paths touch keeps the tests independent of that
 * runtime gap without changing what's actually exercised.
 */
function installFakeTemporal(): void {
  const durationToMs = (d: { hours?: number; minutes?: number; seconds?: number }) =>
    (d.hours ?? 0) * 3_600_000 + (d.minutes ?? 0) * 60_000 + (d.seconds ?? 0) * 1_000
  const makeInstant = (epochMs: number): any => ({
    epochMilliseconds: epochMs,
    add: (d: any) => makeInstant(epochMs + durationToMs(d)),
    subtract: (d: any) => makeInstant(epochMs - durationToMs(d)),
    toString: () => new Date(epochMs).toISOString()
  })
  ;(globalThis as any).Temporal = {
    Now: { instant: () => makeInstant(Date.now()) },
    // -> `expireCompletionPromises()` (OpenProject #928) compares two instants with `Instant.compare`,
    //    per CLAUDE.md's own note that Temporal types have no `valueOf` and `<` throws.
    Instant: { compare: (a: any, b: any) => Math.sign(a.epochMilliseconds - b.epochMilliseconds) }
  }
}

let scheduler: any
let previousTemporal: any

before(async () => {
  previousTemporal = (globalThis as any).Temporal
  installFakeTemporal()
  scheduler = (await import('./scheduler.ts')).default
})

after(() => {
  ;(globalThis as any).Temporal = previousTemporal
})

/**
 * Regression test for two coupled pre-existing bugs in `addScheduled()`'s future-job-scheduling loop:
 *
 * 1. `plannedIterations.next()` was read with the old ES-iterator shape (`.value` / `.done`), but
 *    cron-parser v5's `next()` returns the `CronDate` directly — neither property exists on it.
 *    `next.value.getTime()` therefore throws the moment the `existingJobs.some(...)` callback actually
 *    runs (i.e. whenever at least one job is already scheduled for the task), and the throw is
 *    swallowed by the surrounding `catch { break }` — so the loop adds *zero* new jobs instead of the
 *    ones still due. `next.done` is likewise always `undefined` (falsy), so with an empty
 *    `existingJobs` the loop never terminates naturally and only ever stops at the 10-iteration cap.
 * 2. The adjacent `addJob({ ... })` call passed a `useWorker` property that isn't part of
 *    `AddJobOptions` (already re-derived internally by `addJob` from `this.tasks`), and handed
 *    `waitUntil` an ISO string where `AddJobOptions.waitUntil` — and the `timestamp()` column it is
 *    written to — expect a `Date`.
 *
 * This drives the real `addScheduled()` against lightweight fakes for `WIKI.db`, rather than a live
 * Postgres connection or a re-implementation of the loop's logic, so it fails under the pre-fix code
 * and passes only once the actual fix is in place.
 */
describe('addScheduled (fake WIKI)', () => {
  let insertedJobs: any[]
  let scheduleJobsMock: any[]
  let existingJobsMock: any[]
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      INSTANCE_ID: 'test-instance',
      config: { scheduler: { maxRetries: 3 } },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      db: {
        transaction: async (fn: any) =>
          fn({
            update: () => ({
              set: () => ({
                where: async () => ({ rowCount: 1 })
              })
            })
          }),
        select: () => ({
          from: (table: any) => {
            if (table === jobScheduleTable) {
              return scheduleJobsMock
            }
            if (table === jobsTable) {
              return { where: async () => existingJobsMock }
            }
            throw new Error(`Unexpected table in test fake: ${String(table)}`)
          }
        }),
        insert: (_table: any) => ({
          values: async (v: any) => {
            insertedJobs.push(v)
            return {}
          }
        })
      }
    }
    // -> Bypass `init()` (worker pool + reading tasks/simple/ off disk): only `this.tasks` is read, by
    //    `addJob()`, to derive `useWorker`.
    scheduler.tasks = {}
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  beforeEach(() => {
    insertedJobs = []
  })

  test('schedules future jobs from a cron even when a job is already scheduled for that task', async () => {
    scheduleJobsMock = [{ task: 'testTask', cron: '* * * * *', payload: { foo: 'bar' } }]
    // -> Non-empty and matching `job.task`, which is what made the pre-fix `.some()` callback run (and
    //    throw) at all. Its `waitUntil` is far in the past so it can never collide with a freshly
    //    computed near-future iteration.
    existingJobsMock = [{ task: 'testTask', waitUntil: new Date(0) }]

    await scheduler.addScheduled()

    // Pre-fix: `.some()`'s callback throws on the very first iteration (existingJobsMock is
    // non-empty), caught by `catch { break }` before any `addJob` call — zero rows inserted.
    // Fixed: a minutely cron over the ~24h05m window has far more than 10 due iterations, so the
    // 10-iteration cap is what stops it.
    assert.equal(insertedJobs.length, 10)

    for (const job of insertedJobs) {
      assert.equal(job.task, 'testTask')
      assert.deepEqual(job.payload, { foo: 'bar' })
      assert.ok(job.waitUntil instanceof Date, 'waitUntil must be a Date, not an ISO string')
      assert.ok(!Number.isNaN(job.waitUntil.getTime()))
      // -> Derived internally by `addJob` from `this.tasks`, not passed as a `useWorker` option (which
      //    `AddJobOptions` does not have).
      assert.equal(job.useWorker, true)
    }

    // Iterations must be strictly increasing in time, with no collisions.
    const times = insertedJobs.map((j) => j.waitUntil.getTime())
    assert.equal(new Set(times).size, times.length)
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] > times[i - 1])
    }
  })

  test('adds no jobs and does not throw when the schedule has no due iterations left', async () => {
    // A cron expression that only fires on Feb 29th never matches inside a 24h05m window unless today
    // happens to be one, reliably exercising the natural (non-cap) loop termination path.
    scheduleJobsMock = [{ task: 'leapTask', cron: '0 0 29 2 *', payload: {} }]
    existingJobsMock = []

    await scheduler.addScheduled()

    assert.equal(insertedJobs.length, 0)
  })

  test('a `*/5 * * * *` cron produces multiple distinct rows capped at 10, and a second call does not duplicate rows already in existingJobs', async () => {
    // Task 573's explicit verification ask: a cron due more than once inside the ~24h05m window (every
    // 5 minutes fires ~289 times) must yield several distinct `jobs` rows on a single `addScheduled()`
    // call, capped at 10 -- and a follow-up call, once those rows are visible via `existingJobs`, must
    // not re-insert any of them. This exercises the real dedup comparison
    // (`j.waitUntil.getTime() === next.getTime()`) rather than just the loop's cap/termination logic
    // covered by the tests above.
    //
    // Note the loop's cap counts *additions*, not iterations examined: once the next 10 due iterations
    // are all already scheduled, it skips past every one of them (proving the dedup check works) and
    // keeps going until it has added 10 genuinely new rows further out in the window -- it does not
    // stop at zero. So the correct assertion for "does not duplicate" is that the two calls' rows never
    // overlap, not that the second call adds nothing.
    scheduleJobsMock = [{ task: 'fiveMinTask', cron: '*/5 * * * *', payload: {} }]
    existingJobsMock = []

    await scheduler.addScheduled()

    assert.equal(insertedJobs.length, 10)
    const firstCallTimes = insertedJobs.map((j) => j.waitUntil.getTime())
    assert.equal(
      new Set(firstCallTimes).size,
      10,
      'all 10 rows from the first call must be distinct'
    )

    // Simulate the rows now being visible to the next lock-holder's `existingJobs` query.
    existingJobsMock = insertedJobs.map((j) => ({ task: j.task, waitUntil: j.waitUntil }))
    insertedJobs = []

    await scheduler.addScheduled()

    assert.equal(
      insertedJobs.length,
      10,
      'the dedup skip must not stop the loop before its 10-addition cap'
    )
    const secondCallTimes = insertedJobs.map((j) => j.waitUntil.getTime())
    assert.equal(
      new Set(secondCallTimes).size,
      10,
      'all 10 rows from the second call must be distinct'
    )
    for (const t of secondCallTimes) {
      assert.ok(
        !firstCallTimes.includes(t),
        'a second call must not duplicate a waitUntil already present in existingJobs'
      )
    }
  })

  // -> OpenProject #929: reapStaleJobs() no longer produces a scheduled row with a null waitUntil
  //    (see core/scheduler.test.ts's DB-backed reapStaleJobs suite), but this loop must not crash if
  //    one exists anyway -- pre-fix, `j.waitUntil.getTime()` throwing on the very first `.some()`
  //    comparison against such a row was silently swallowed by the surrounding `catch { break }`,
  //    which stopped this task's loop before adding a single one of its due iterations.
  test('a null waitUntil among existingJobs does not crash the dedupe check or block scheduling', async () => {
    scheduleJobsMock = [{ task: 'testTask', cron: '* * * * *', payload: {} }]
    existingJobsMock = [{ task: 'testTask', waitUntil: null }]

    await scheduler.addScheduled()

    assert.equal(insertedJobs.length, 10)
    for (const job of insertedJobs) {
      assert.equal(job.task, 'testTask')
      assert.ok(job.waitUntil instanceof Date)
    }
  })
})

/**
 * `expireCompletionPromises()`, OpenProject #928: the only way an `addJob({ promise: true })` deferred
 * ever otherwise settled was a `jobCompleted` NOTIFY -- and postgres NOTIFY is not durable, so one
 * missed during a LISTEN reconnect left the deferred, and everything awaiting it, pending forever. This
 * sweep rejects (and stops tracking) any entry older than its ceiling, driven entirely by
 * `completionPromises`/`WIKI.config` -- no database or real timers involved, so it runs as a fast fake-
 * WIKI unit test rather than needing the DB-backed fixture below.
 */
describe('expireCompletionPromises (fake WIKI)', () => {
  let previousWiki: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  beforeEach(() => {
    scheduler.completionPromises = []
  })

  /** A `CompletionPromise`-shaped entry `ageSeconds` in the past, recording whether/how it settled. */
  function makeEntry(ageSeconds: number) {
    const added = (globalThis as any).Temporal.Now.instant().subtract({ seconds: ageSeconds })
    let rejectedWith: Error | undefined
    let resolved = false
    return {
      entry: {
        id: `job-aged-${ageSeconds}s`,
        added,
        resolve: () => {
          resolved = true
        },
        reject: (err: Error) => {
          rejectedWith = err
        }
      },
      getRejection: () => rejectedWith,
      wasResolved: () => resolved
    }
  }

  test('rejects and drops an entry older than 2x staleJobTimeout', () => {
    ;(globalThis as any).WIKI = { config: { scheduler: { staleJobTimeout: 10 } } }
    const { entry, getRejection } = makeEntry(25) // -> past the 20s (10 * 2) ceiling
    scheduler.completionPromises.push(entry)

    scheduler.expireCompletionPromises()

    assert.equal(scheduler.completionPromises.length, 0)
    assert.match(getRejection()!.message, /Timed out/)
    assert.match(getRejection()!.message, /job-aged-25s/)
  })

  test('leaves an entry younger than the ceiling untouched', () => {
    ;(globalThis as any).WIKI = { config: { scheduler: { staleJobTimeout: 10 } } }
    const { entry, getRejection, wasResolved } = makeEntry(5) // -> well under the 20s ceiling
    scheduler.completionPromises.push(entry)

    scheduler.expireCompletionPromises()

    assert.equal(scheduler.completionPromises.length, 1)
    assert.equal(getRejection(), undefined)
    assert.equal(wasResolved(), false)
  })

  test('falls back to the default stale job timeout (doubled) when nothing is configured', () => {
    ;(globalThis as any).WIKI = { config: { scheduler: {} } }
    const { entry } = makeEntry(5) // -> far under the multi-hour default ceiling
    scheduler.completionPromises.push(entry)

    scheduler.expireCompletionPromises()

    assert.equal(scheduler.completionPromises.length, 1)
  })

  test('only removes the expired entries, leaving fresh ones in place', () => {
    ;(globalThis as any).WIKI = { config: { scheduler: { staleJobTimeout: 10 } } }
    const stale = makeEntry(25)
    const fresh = makeEntry(1)
    scheduler.completionPromises.push(stale.entry, fresh.entry)

    scheduler.expireCompletionPromises()

    assert.deepEqual(
      scheduler.completionPromises.map((p: any) => p.id),
      [fresh.entry.id]
    )
    assert.ok(stale.getRejection())
  })
})

/**
 * Task 704 (a): `executeOnWorker`'s two timeout ceilings, verified against a REAL poolifier worker
 * thread rather than a mock of one — see `test/fixtures/schedulerCrashWorker.ts` for why a worker
 * thread's own `process.exit()` is the faithful in-process equivalent of `kill -9`-ing it.
 */
describe('executeOnWorker (real worker pool)', () => {
  let previousWiki: any
  let pool: any

  before(() => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      INSTANCE_ID: 'test-instance',
      // -> 1s: short enough to keep the suite fast, long enough that the two ceilings (taskTimeout
      //    alone vs. taskTimeout + the fixed 5s TASK_TIMEOUT_GRACE) land clearly apart in wall time.
      config: { scheduler: { taskTimeout: 1 } },
      logger: { info: () => {}, warn: () => {}, debug: () => {} }
    }
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  afterEach(async () => {
    await pool?.destroy()
    pool = null
  })

  /**
   * A fresh, single-worker pool per test — not shared across the two — so each task is dispatched to
   * a worker that has not just been aborted/replaced by the other test. `FixedThreadPool`, matching
   * the fix in `scheduler.ts#init()`: poolifier 5.x's `DynamicThreadPool` refuses a minimum equal to
   * its maximum.
   */
  function freshPool(): any {
    pool = new FixedThreadPool(
      1,
      path.join(import.meta.dirname, '../test/fixtures/schedulerCrashWorker.ts'),
      {
        errorHandler: () => {},
        exitHandler: () => {}
      }
    )
    scheduler.workerPool = pool
    return pool
  }

  test('a hung-but-alive task is aborted at the taskTimeout ceiling, well before the backup timer', async () => {
    freshPool()
    const start = Date.now()
    await assert.rejects(scheduler.executeOnWorker({ task: 'x', payload: { mode: 'hang' } }))
    const elapsed = Date.now() - start
    // -> taskTimeout is 1s; the backup timer would not fire until 1s + 5s grace = 6s. Rejecting well
    //    before that means the abort signal — not the backup timer — is what ended it.
    assert.ok(elapsed < 4000, `expected the abort ceiling (~1s) to fire, took ${elapsed}ms`)
  })

  test('a worker that exits mid-task is caught only by the backup timer, after taskTimeout + grace', async () => {
    freshPool()
    const start = Date.now()
    await assert.rejects(scheduler.executeOnWorker({ task: 'x', payload: { mode: 'crash' } }))
    const elapsed = Date.now() - start
    // -> The worker is gone before the abort signal has anything left to abort, so only the backup
    //    `setTimeout` at taskTimeout + TASK_TIMEOUT_GRACE (1s + 5s = 6s) rejects this.
    assert.ok(elapsed >= 5500, `expected the backup timer (~6s) to fire, took ${elapsed}ms`)
  })
})

/**
 * Task 704 (b)/(c): `reapStaleJobs()`'s stale-claim recovery and its concurrency guarantee, plus a
 * regression for a bug this verification turned up in `processJob()`'s reclaim path — all run against
 * a real, migrated Postgres (see `test/db.ts`), not a mock of the query builder: the thing under test
 * *is* the SQL's atomicity and row-level locking, which a mock would only be re-describing.
 *
 * Every test tracks the ids it creates and deletes them in `afterEach`, so `reapStaleJobs()` — which
 * sweeps every stale row in the table, not just one test's own — never sees another test's leftovers.
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
      // -> `taskTimeout: 1`: short enough to keep the new "in-process task that never settles" test
      //    below fast, and otherwise unused by every other test in this block (none of them exercise
      //    `runInProcess()`'s ceiling, only `staleJobTimeout`/`retryBackoff`/`maxRetries`).
      WIKI.config = {
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
      // -> OpenProject #929: a null waitUntil here crashes addScheduled()'s dedupe check
      //    (`j.waitUntil.getTime()`) the next time it runs, for any scheduled row of the same task.
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
      // -> Still marked interrupted (the UPDATE claim doesn't discriminate on attempt count) — it is
      //    only the requeue-into-`jobs` step that skips it.
      assert.equal(after1.state, 'interrupted')
      const stillQueued = await fixtures.db.select().from(jobsTable).where(eq(jobsTable.id, row.id))
      assert.equal(stillQueued.length, 0)
    })

    /**
     * OpenProject #928: a job that is abandoned outright (no attempts left) is never picked up and run
     * again by anything, so `runJob()`'s own `jobCompleted` NOTIFY -- the ordinary way a completion
     * promise settles -- is never going to fire for it. `reapStaleJobs()` must send that NOTIFY itself
     * for exactly this case, or the only thing standing between an `addJob({ promise: true })` caller
     * and hanging forever is `expireCompletionPromises()`'s much longer ceiling.
     *
     * `WIKI.scheduler` here is `createSchedulerStub()`'s plain object (`test/db.ts`), not the real
     * `scheduler` module under test -- `notifier` (module-scope in `scheduler.ts`) reads
     * `WIKI.scheduler.pubsubClient` on every send, so handing that stub object a fake `query()` is what
     * lets a NOTIFY attempt be observed without a second, real LISTEN/NOTIFY client.
     */
    test('sends a jobCompleted NOTIFY for a job it abandons, since nothing else ever will', async () => {
      const row = await insertActiveHistory({
        attempt: 3,
        maxRetries: 2,
        lastErrorMessage: null
      })
      historyIds.push(row.id)
      const query = mock.fn(async (_sql: string, _params?: any[]) => ({}) as any)
      WIKI.scheduler.pubsubClient = { query } as any

      try {
        await scheduler.reapStaleJobs()
        // -> `notifier.send()` (helpers/pubsub.ts) is deliberately fire-and-forget -- queued behind a
        //    promise chain `reapStaleJobs()` itself never awaits -- so a beat is needed for the queued
        //    `query()` call to actually run before it can be asserted against.
        await new Promise((resolve) => setTimeout(resolve, 50))
      } finally {
        WIKI.scheduler.pubsubClient = null
      }

      assert.equal(query.mock.callCount(), 1)
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

    /**
     * OpenProject #1996: `runJob()`'s in-process branch used to `await` the task call directly, with
     * no ceiling -- unlike `executeOnWorker()`, which already races against `taskTimeout`. A task
     * whose promise never settles left `runJob()` (and therefore `processJob()`'s
     * `Promise.allSettled`) pending forever, so `activeWorkers` was never returned and, after enough
     * wedged jobs, the instance stopped claiming any further job at all. `runInProcess()` gives the
     * in-process branch the same race-against-a-timer shape, so `runJob()` always settles and this
     * bookkeeping always completes.
     */
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
     * Bug found by this verification task: `processJob()`'s claim step re-inserts a `jobHistory` row
     * with a fresh `attempt` count, but on a *reclaim* (the row already exists — exactly the case right
     * after `reapStaleJobs()` has interrupted it) that insert conflicts, and the `onConflictDoUpdate`
     * only wrote `state`/`executedBy`/`startedAt` — never `attempt`. A job whose worker or process keeps
     * dying before `runJob()`'s own bookkeeping ever runs (the scenario `reapStaleJobs()` exists for)
     * therefore has its `jobHistory.attempt` frozen at whatever it was on the very first claim, so the
     * `job.attempt > job.maxRetries` cutoff in `reapStaleJobs()` never trips: `maxRetries` stops being
     * honored, and the job is requeued forever instead of being abandoned.
     *
     * `runJob()` is stubbed to a no-op here to model exactly that: claimed, then the process disappears
     * before it can record anything — the same state a `kill -9` mid-task leaves behind.
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

        // Attempt 1: claimed, then the process "dies" (runJob stubbed) before recording anything.
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

        // Attempt 2 (the retry): reclaimed via the SAME jobHistory row from attempt 1 — this is what
        // exercises the insert's ON CONFLICT DO UPDATE path specifically.
        await scheduler.processJob()
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
  }
)
