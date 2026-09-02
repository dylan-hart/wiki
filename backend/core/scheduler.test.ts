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
import { ensureTemporal } from '../test/temporal.ts'
import { getJobExecutionContext } from '../helpers/jobExecutionContext.ts'
import { installTestWiki } from '../test/mocks.ts'

let scheduler: any

before(async () => {
  await ensureTemporal()
  scheduler = (await import('./scheduler.ts')).default
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
  let wikiHandle: { restore(): void }

  // -> Set per-test (default: always succeeds) so the failing-insert test below can make every
  //    `addJob` insert reject without touching the rest of the fixture.
  let insertShouldFail: boolean

  before(() => {
    // -> Shared by both `db.select` and `trx.select` below: OpenProject #1998 requires
    //    `addScheduled()` to read `scheduledJobs`/`existingJobs` through its own transaction (`trx`),
    //    not the ambient `WIKI.db` handle, so the fake `trx` handed to the `transaction()` callback
    //    must expose `select()` too, not just `update().set().where()`.
    const selectImpl = () => ({
      from: (table: any) => {
        if (table === jobScheduleTable) {
          return scheduleJobsMock
        }
        if (table === jobsTable) {
          return { where: async () => existingJobsMock }
        }
        throw new Error(`Unexpected table in test fake: ${String(table)}`)
      }
    })
    wikiHandle = installTestWiki({
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
            }),
            // -> `addScheduled()` now reads both selects through `trx` rather than the ambient
            //    `WIKI.db` pool handle (OpenProject #1998) -- shared `selectImpl`, same fake data,
            //    same table-dispatch shape as `WIKI.db.select()` below.
            select: selectImpl
          }),
        select: selectImpl,
        insert: (_table: any) => ({
          values: async (v: any) => {
            if (insertShouldFail) {
              throw new Error('simulated insert failure')
            }
            insertedJobs.push(v)
            return { id: v.id ?? 'fake-id' }
          }
        })
      }
    })
    // -> Bypass `init()` (worker pool + reading tasks/simple/ off disk): only `this.tasks` is read, by
    //    `addJob()`, to derive `useWorker`.
    scheduler.tasks = {}
  })

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    insertedJobs = []
    insertShouldFail = false
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

  // -> OpenProject #1998: pre-fix, `addScheduled()` fired `this.addJob(...)` without awaiting it, so
  //    `addedFutureJobs`/`totalAdded` were incremented from the call itself rather than its outcome --
  //    a run whose inserts all failed (`addJob` swallows its own errors and returns `undefined`) still
  //    logged "Scheduled N new future planned jobs". Awaiting each call and counting only a returned
  //    `id` means a total insert failure must report zero added rows.
  test('reports zero jobs added when every addJob insert fails', async () => {
    // -> Hourly rather than minutely: keeps the failing-insert loop's iteration count small (it can no
    //    longer stop early via the 10-addition cap, since nothing ever succeeds) while still covering
    //    more than one due iteration in the ~24h05m window.
    scheduleJobsMock = [{ task: 'testTask', cron: '0 * * * *', payload: {} }]
    existingJobsMock = []
    insertShouldFail = true

    await scheduler.addScheduled()

    assert.equal(insertedJobs.length, 0, 'no row should have been inserted')
  })
})

/**
 * OpenProject #2077: the claim subquery in `processJob()` used to `ORDER BY id`, and `id` is a
 * `crypto.randomUUID()` over a `defaultRandom()` column -- no correlation at all with `waitUntil` or
 * `createdAt`. That let an overdue retry (`reapStaleJobs()` sets `waitUntil: new Date()` precisely so
 * a requeued job is claimed next) sit behind an unrelated job whose uuid happened to sort lower, and
 * disagreed with the admin "Upcoming" ordering (`models/jobs.ts#getUpcoming()`:
 * `waitUntil ASC NULLS FIRST, createdAt ASC`).
 *
 * This drives the real `processJob()` against a fake `WIKI.db.transaction`/`trx.delete` and inspects
 * the literal SQL text of the claim subquery's `inArray(...)` condition -- the thing actually sent to
 * postgres -- rather than re-implementing the ordering logic to compare against. `extractSqlText`
 * walks a drizzle `SQL` object's `queryChunks` (each a `{ value: string[] }` literal chunk, a nested
 * `SQL` chunk, or a bound param contributing no literal text) and concatenates the literal chunks, so
 * what it produces is exactly the query string drizzle would send.
 */
describe('processJob claim ordering (fake WIKI)', () => {
  let capturedCondition: any
  let wikiHandle: { restore(): void }

  function extractSqlText(node: any): string {
    if (node == null) return ''
    if (Array.isArray(node.value)) return node.value.join('')
    if (Array.isArray(node.queryChunks)) return node.queryChunks.map(extractSqlText).join('')
    return ''
  }

  before(() => {
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      db: {
        transaction: async (fn: any) =>
          fn({
            delete: (_table: any) => ({
              where: (condition: any) => {
                capturedCondition = condition
                return { returning: async () => [] }
              }
            })
          })
      }
    })
    scheduler.maxWorkers = 1
    scheduler.activeWorkers = 0
  })

  after(() => {
    wikiHandle.restore()
  })

  test('claim subquery orders by waitUntil ASC NULLS FIRST, then createdAt ASC -- not by id', async () => {
    await scheduler.processJob()

    const sqlText = extractSqlText(capturedCondition)
    assert.match(
      sqlText,
      /ORDER BY "waitUntil" ASC NULLS FIRST, "createdAt" ASC FOR UPDATE SKIP LOCKED/,
      `claim subquery must order by due time and age, matching getUpcoming(); got: ${sqlText}`
    )
    assert.doesNotMatch(
      sqlText,
      /ORDER BY id\b/,
      'claim subquery must not order by the random-uuid id column'
    )
  })
})

/**
 * OpenProject #1931: `runJob()`'s terminal, retries-exhausted failure must log at `error` so an
 * operator shipping only `error` to alerting actually sees it -- `wikijs_jobs_queued` counts
 * *pending* jobs, so a storm of failing-and-retrying jobs looks identical to a healthy queue from
 * that metric alone. A still-retryable failure must keep logging at `warn`, matching the
 * "Rescheduling new attempt" line right after it.
 *
 * Drives the real `runJob()` against a fake `WIKI.db`/`notifier`-reachable state, not a live
 * Postgres connection -- there is no SQL orchestration worth a real database here, just a branch on
 * `job.retries` vs. `job.maxRetries` deciding which logger method gets called.
 */
describe('runJob log level on failure (fake WIKI)', () => {
  let wikiHandle: { restore(): void }
  let logCalls: { level: string; args: any[] }[]

  before(() => {
    scheduler.tasks = {}
  })

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    logCalls = []
    const makeLogFn =
      (level: string) =>
      (...args: any[]) =>
        logCalls.push({ level, args })
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      config: { scheduler: { retryBackoff: 1 } },
      logger: {
        info: makeLogFn('info'),
        warn: makeLogFn('warn'),
        error: makeLogFn('error'),
        debug: makeLogFn('debug')
      },
      db: {
        update: () => ({
          set: () => ({
            where: async () => ({ rowCount: 1 })
          })
        }),
        insert: (_table: any) => ({
          values: async () => ({})
        })
      }
      // -> No `WIKI.scheduler.pubsubClient`: `notifier.send()` reads it fresh on each call, catches the
      //    resulting `TypeError` internally, and logs a `warn` of its own -- fire-and-forget, so it
      //    never surfaces synchronously here. See `helpers/pubsub.ts#createNotifier`.
    })
  })

  test('a still-retryable failure logs the failure message at warn, not error', async () => {
    scheduler.tasks.willFail = async () => {
      throw new Error('transient failure')
    }
    const job = {
      id: 'job-retryable',
      task: 'willFail',
      useWorker: false,
      payload: {},
      retries: 0,
      maxRetries: 3
    }

    await scheduler.runJob(job)

    const failureCalls = logCalls.filter(
      (c) => c.args[0] === 'Failed to complete job job-retryable: willFail [ FAILED ]'
    )
    assert.equal(failureCalls.length, 1, 'the failure message must be logged exactly once')
    assert.equal(failureCalls[0]!.level, 'warn')
    assert.equal(
      logCalls.filter((c) => c.level === 'error').length,
      0,
      'no error-level log for a failure that still has retries left'
    )
  })

  test('a retries-exhausted failure logs the failure message at error, not warn', async () => {
    scheduler.tasks.willFail = async () => {
      throw new Error('permanent failure')
    }
    const job = {
      id: 'job-exhausted',
      task: 'willFail',
      useWorker: false,
      payload: {},
      retries: 3,
      maxRetries: 3
    }

    await scheduler.runJob(job)

    const failureCalls = logCalls.filter(
      (c) => c.args[0] === 'Failed to complete job job-exhausted: willFail [ FAILED ]'
    )
    assert.equal(failureCalls.length, 1, 'the failure message must be logged exactly once')
    assert.equal(failureCalls[0]!.level, 'error')
    assert.equal(
      logCalls.filter((c) => c.level === 'warn' && c.args[0] === failureCalls[0]!.args[0]).length,
      0,
      'the exhausted-retries failure message must not also be logged at warn'
    )
    // -> No reschedule attempted once retries are exhausted, so no "Rescheduling new attempt" line.
    assert.equal(
      logCalls.some(
        (c) => typeof c.args[0] === 'string' && c.args[0].startsWith('Rescheduling new attempt')
      ),
      false
    )
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
  let wikiHandle: { restore(): void }

  before(() => {})

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    scheduler.completionPromises = []
  })

  /**
   * A `CompletionPromise`-shaped entry `ageSeconds` in the past, recording whether/how it settled.
   * `promise` is a real `Promise` wired to `resolve`/`reject`, matching production's
   * `createDeferred()` shape (task 1993) -- `expireCompletionPromises()` attaches a no-op `.catch()`
   * to it before rejecting, so a test entry without a matching live promise would throw calling
   * `.catch()` on `undefined`.
   */
  function makeEntry(ageSeconds: number) {
    const added = (globalThis as any).Temporal.Now.instant().subtract({ seconds: ageSeconds })
    let rejectedWith: Error | undefined
    let resolved = false
    let resolveFn: (value: void) => void
    let rejectFn: (reason?: unknown) => void
    const promise = new Promise<void>((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })
    return {
      entry: {
        id: `job-aged-${ageSeconds}s`,
        added,
        promise,
        resolve: () => {
          resolved = true
          resolveFn()
        },
        reject: (err: Error) => {
          rejectedWith = err
          rejectFn(err)
        }
      },
      getRejection: () => rejectedWith,
      wasResolved: () => resolved
    }
  }

  test('rejects and drops an entry older than 2x staleJobTimeout', () => {
    wikiHandle = installTestWiki({ config: { scheduler: { staleJobTimeout: 10 } } })
    const { entry, getRejection } = makeEntry(25) // -> past the 20s (10 * 2) ceiling
    scheduler.completionPromises.push(entry)

    scheduler.expireCompletionPromises()

    assert.equal(scheduler.completionPromises.length, 0)
    assert.match(getRejection()!.message, /Timed out/)
    assert.match(getRejection()!.message, /job-aged-25s/)
  })

  test('leaves an entry younger than the ceiling untouched', () => {
    wikiHandle = installTestWiki({ config: { scheduler: { staleJobTimeout: 10 } } })
    const { entry, getRejection, wasResolved } = makeEntry(5) // -> well under the 20s ceiling
    scheduler.completionPromises.push(entry)

    scheduler.expireCompletionPromises()

    assert.equal(scheduler.completionPromises.length, 1)
    assert.equal(getRejection(), undefined)
    assert.equal(wasResolved(), false)
  })

  test('falls back to the default stale job timeout (doubled) when nothing is configured', () => {
    wikiHandle = installTestWiki({ config: { scheduler: {} } })
    const { entry } = makeEntry(5) // -> far under the multi-hour default ceiling
    scheduler.completionPromises.push(entry)

    scheduler.expireCompletionPromises()

    assert.equal(scheduler.completionPromises.length, 1)
  })

  test('only removes the expired entries, leaving fresh ones in place', () => {
    wikiHandle = installTestWiki({ config: { scheduler: { staleJobTimeout: 10 } } })
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
 * OpenProject #1993: `addJob({ promise: true })` used to push the `completionPromises` entry
 * *before* `WIKI.db.insert(...)`. If the insert then rejected, the outer `catch` logged and
 * returned `undefined` -- the caller never received `jobDefer.promise`, so nothing was ever
 * attached to it, but the entry stayed tracked in `completionPromises` regardless. Roughly two
 * hours later (`staleJobTimeout` * `COMPLETION_PROMISE_TTL_MULTIPLIER`),
 * `expireCompletionPromises()` rejected that orphaned, handler-less promise -- an unhandled
 * rejection with nothing left in the call stack to explain it, and (per `index.ts`'s
 * `uncaughtException` handler) fatal to the whole instance.
 *
 * The fix moves the push to after a successful insert, so a rejecting insert leaves nothing in
 * `completionPromises` for `expireCompletionPromises()` to ever reject.
 */
describe('addJob (fake WIKI, rejecting insert)', () => {
  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      config: { scheduler: { maxRetries: 3 } },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      db: {
        insert: (_table: any) => ({
          values: async () => {
            throw new Error('insert failed')
          }
        })
      }
    })
    scheduler.tasks = {}
  })

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    scheduler.completionPromises = []
  })

  test('returns undefined and leaves completionPromises empty when the insert rejects', async () => {
    const result = await scheduler.addJob({ task: 'testTask', promise: true })

    assert.equal(result, undefined)
    assert.equal(scheduler.completionPromises.length, 0)
  })

  test('a subsequent expireCompletionPromises() sweep produces no unhandled rejection', async () => {
    let unhandled: unknown
    const onUnhandledRejection = (reason: unknown) => {
      unhandled = reason
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      await scheduler.addJob({ task: 'testTask', promise: true })
      scheduler.expireCompletionPromises()

      // -> Give any unhandled rejection a microtask/macrotask turn to actually fire before asserting
      //    its absence.
      await new Promise((resolve) => setImmediate(resolve))

      assert.equal(scheduler.completionPromises.length, 0)
      assert.equal(
        unhandled,
        undefined,
        'expireCompletionPromises() must not produce an unhandled rejection'
      )
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})

/**
 * OpenProject #1937: `runJob()`'s catch branch used to log a job's failure as two bare strings, with
 * no way to trace which job (or attempt) a given log line was about. This asserts both failure log
 * calls in that branch now carry `{ jobId, task, attempt }` as a sibling context argument, not folded
 * into the message string. `error` and `warn` share one mock here (task #1993's log-level split
 * routes an exhausted-retries failure to `error`, not `warn`) since this test's own concern is the
 * context payload, not which level a given retry count picks.
 */
describe('runJob failure logging (fake WIKI)', () => {
  let wikiHandle: { restore(): void }
  let failureMock: ReturnType<typeof mock.fn>

  before(() => {
    failureMock = mock.fn((..._args: any[]) => {})
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      config: { scheduler: { retryBackoff: 0 } },
      // -> `notifier.send()` (module scope in scheduler.ts) reads `WIKI.scheduler.pubsubClient` on
      //    every send; `null` is a valid, silently-discarded target (`helpers/pubsub.ts`), so this
      //    exercises the catch branch with no real LISTEN/NOTIFY client needed.
      scheduler: { pubsubClient: null },
      logger: { info: () => {}, warn: failureMock, error: failureMock },
      // -> Only the `jobHistory` write in the catch branch's own recording step; letting this
      //    succeed keeps the assertion focused on the two failure-logging calls instead of also
      //    picking up the branch's own "could not record the failure" fallback warn.
      db: {
        update: (_table: any) => ({
          set: (_values: any) => ({
            where: async () => ({})
          })
        })
      }
    })
    scheduler.tasks = {
      boom: async () => {
        throw new Error('task exploded')
      }
    }
  })

  after(() => {
    wikiHandle.restore()
  })

  test('both failure log calls carry { jobId, task, attempt } as sibling context, not concatenated in', async () => {
    failureMock.mock.resetCalls()
    // -> retries === maxRetries: no reschedule branch, so this stays free of the Temporal/db.insert
    //    path that `attempt` here doesn't need. This also means retries are exhausted, so both calls
    //    log at `error` (task #1993) — `failureMock` above is registered for both levels.
    const job = {
      id: 'job-1',
      task: 'boom',
      payload: {},
      useWorker: false,
      retries: 2,
      maxRetries: 2
    }

    await scheduler.runJob(job)

    assert.equal(failureMock.mock.callCount(), 2)
    const expectedContext = { jobId: 'job-1', task: 'boom', attempt: 3 }
    const [firstCall, secondCall] = failureMock.mock.calls

    assert.match(firstCall!.arguments[0] as string, /Failed to complete job job-1: boom/)
    assert.deepEqual(firstCall!.arguments[1], expectedContext)

    assert.ok(secondCall!.arguments[0] instanceof Error)
    assert.deepEqual(secondCall!.arguments[1], expectedContext)
  })
})

/**
 * Task 704 (a): `executeOnWorker`'s two timeout ceilings, verified against a REAL poolifier worker
 * thread rather than a mock of one — see `test/fixtures/schedulerCrashWorker.ts` for why a worker
 * thread's own `process.exit()` is the faithful in-process equivalent of `kill -9`-ing it.
 */
describe('executeOnWorker (real worker pool)', () => {
  let wikiHandle: { restore(): void }
  let pool: any

  before(() => {
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      // -> 1s: short enough to keep the suite fast, long enough that the two ceilings (taskTimeout
      //    alone vs. taskTimeout + the fixed 5s TASK_TIMEOUT_GRACE) land clearly apart in wall time.
      config: { scheduler: { taskTimeout: 1 } },
      logger: { info: () => {}, warn: () => {}, debug: () => {} }
    })
  })

  after(() => {
    wikiHandle.restore()
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
 * 2026-08-24 audit finding §2: `executeInProcess` gives an in-process task the same `taskTimeout`
 * ceiling `executeOnWorker` already has for a worker-thread one. A pure-unit test, unlike
 * `executeOnWorker`'s real-worker-pool suite above: there is no thread to crash here, only the
 * scheduler's own bookkeeping to keep finite, so a task whose promise simply never resolves is
 * enough to exercise it.
 */
describe('executeInProcess (fake WIKI)', () => {
  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      // -> Short enough to keep the suite fast.
      config: { scheduler: { taskTimeout: 0.05 } },
      logger: { info: () => {}, warn: () => {}, debug: () => {} }
    })
  })

  after(() => {
    wikiHandle.restore()
  })

  test('a task whose promise never settles is abandoned at the taskTimeout ceiling', async () => {
    scheduler.tasks = {
      // -> Never resolves or rejects, modeling `withAdvisoryLock` blocking forever on an
      //    unavailable lock -- the documented real-world case (audit finding §2).
      neverSettles: () => new Promise(() => {})
    }
    const start = Date.now()
    await assert.rejects(
      scheduler.executeInProcess({ task: 'neverSettles', payload: {}, id: 'job-1' }),
      /did not complete within/
    )
    const elapsed = Date.now() - start
    assert.ok(elapsed < 2000, `expected the taskTimeout ceiling (~50ms) to fire, took ${elapsed}ms`)
  })

  test('a task that resolves before the ceiling is not treated as timed out', async () => {
    scheduler.tasks = {
      quick: async () => {}
    }
    await assert.doesNotReject(
      scheduler.executeInProcess({ task: 'quick', payload: {}, id: 'job-2' })
    )
  })

  /**
   * OpenProject #2351: `executeInProcess` must make the claim's attempt number available to the
   * task via `helpers/jobExecutionContext.ts`, and a stale task's continuation -- still running
   * after the timeout has already abandoned it -- must keep seeing the attempt it actually started
   * under, not whatever a later reclaim of the same job id has since bumped it to.
   */
  test('the task runs with a job execution context carrying the claim id and attempt', async () => {
    let seen: ReturnType<typeof getJobExecutionContext>
    scheduler.tasks = {
      readsContext: async () => {
        seen = getJobExecutionContext()
      }
    }
    await scheduler.executeInProcess({ task: 'readsContext', payload: {}, id: 'job-3', retries: 2 })
    assert.deepEqual(seen, { jobId: 'job-3', attempt: 3 })
  })

  test('a stale task abandoned at the ceiling keeps its own captured attempt in its background continuation', async () => {
    let seenByStaleContinuation: ReturnType<typeof getJobExecutionContext>
    scheduler.tasks = {
      // -> Resolves well after the ~50ms taskTimeout ceiling has already rejected the race below.
      staleTask: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150))
        seenByStaleContinuation = getJobExecutionContext()
      }
    }

    await assert.rejects(
      scheduler.executeInProcess({ task: 'staleTask', payload: {}, id: 'job-4', retries: 0 }),
      /did not complete within/
    )

    // -> Simulates the real scenario: the same job id gets reclaimed and completes its own, later
    //    attempt while the stale continuation above is still running in the background.
    scheduler.tasks.quickTask = async () => {}
    await scheduler.executeInProcess({ task: 'quickTask', payload: {}, id: 'job-4', retries: 1 })

    // -> Give the stale continuation time to resume and read the context back.
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.deepEqual(seenByStaleContinuation, { jobId: 'job-4', attempt: 1 })
  })
})

/**
 * `stop()`'s bounded drain of in-flight jobs, OpenProject #2019. `processJob()` tracks each
 * `runJob` promise in `inFlightJobs`; `stop()` must (1) clear `pollingRef`/`scheduledRef`
 * synchronously, before it starts waiting on anything, so no new job is claimed mid-shutdown, (2)
 * actually await whatever was already in flight rather than dropping it, and (3) not let a job that
 * never settles on its own hold shutdown open past a bound.
 *
 * Drives the real `stop()` against a fake `workerPool`/`listenerHandle` (no real pool, no pubsub) so
 * only the drain behavior itself is under test.
 */
describe('stop (fake WIKI)', () => {
  let wikiHandle: { restore(): void }
  let destroyCalls: number

  before(() => {})

  beforeEach(() => {
    destroyCalls = 0
    wikiHandle = installTestWiki({
      // -> 0.05s taskTimeout + the fixed 1s SHUTDOWN_DRAIN_GRACE = a ~1.05s bound: short enough to
      //    keep this suite fast, long enough to clearly separate "waited out the bound" from
      //    "resolved immediately".
      config: { scheduler: { taskTimeout: 0.05 } },
      logger: { info: () => {}, warn: () => {}, debug: () => {} }
    })
    scheduler.pollingRef = setInterval(() => {}, 1_000_000)
    scheduler.scheduledRef = setInterval(() => {}, 1_000_000)
    scheduler.workerPool = {
      destroy: async () => {
        destroyCalls++
      }
    }
    scheduler.listenerHandle = null
    scheduler.inFlightJobs = new Set()
  })

  after(() => {
    wikiHandle.restore()
    scheduler.workerPool = null
    scheduler.pollingRef = null
    scheduler.scheduledRef = null
    scheduler.inFlightJobs = new Set()
  })

  test('clears pollingRef and scheduledRef synchronously, before anything is awaited', () => {
    assert.ok(scheduler.pollingRef, 'test setup sanity check')
    assert.ok(scheduler.scheduledRef, 'test setup sanity check')

    const stopPromise = scheduler.stop()

    // -> `stop()` runs synchronously up to its first `await` -- by the time control returns here,
    //    both refs must already be nulled, regardless of how long the drain that follows takes.
    assert.equal(scheduler.pollingRef, null)
    assert.equal(scheduler.scheduledRef, null)

    return stopPromise
  })

  test('awaits an in-flight job rather than dropping it', async () => {
    let settled = false
    const job: Promise<void> = new Promise((resolve) =>
      setTimeout(() => {
        settled = true
        resolve()
      }, 100)
    )
    scheduler.inFlightJobs.add(job)

    await scheduler.stop()

    assert.equal(settled, true, 'stop() must not resolve before the in-flight job settled')
    assert.equal(destroyCalls, 1, 'the worker pool must still be destroyed after the drain')
  })

  test('a never-settling in-flight job does not prevent stop() from resolving within the bound', async () => {
    scheduler.inFlightJobs.add(new Promise<void>(() => {})) // -> deliberately never settles

    const start = Date.now()
    await scheduler.stop()
    const elapsed = Date.now() - start

    // Bound is taskTimeout (0.05s) + SHUTDOWN_DRAIN_GRACE (1s) = ~1.05s.
    assert.ok(elapsed < 3000, `expected stop() to resolve within the bound, took ${elapsed}ms`)
    assert.ok(
      elapsed >= 900,
      `expected stop() to wait out most of the bound rather than short-circuiting, took ${elapsed}ms`
    )
    assert.equal(destroyCalls, 1, 'the worker pool must still be destroyed once the bound elapses')
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
      //    `executeInProcess()`'s ceiling, only `staleJobTimeout`/`retryBackoff`/`maxRetries`).
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
     * OpenProject #2009: `.onConflictDoNothing({ target: jobsTable.id })` is what makes a job the
     * original (still-alive) runner already re-queued a silent no-op instead of a duplicate-key
     * throw. `runJob`'s own retry insert (line ~492) spreads `...job` and therefore reuses the same
     * id, so a runner finishing its retry-scheduling just as this sweep claims the same history row
     * is a real race, not a hypothetical one.
     */
    test('a job the original runner already requeued is a conflict no-op, not a duplicate-key throw', async () => {
      const row = await insertActiveHistory({ maxRetries: 5 })
      historyIds.push(row.id)
      jobIds.push(row.id)

      // -> Stands in for the still-alive original runner's own retry insert reaching `jobs` first.
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

    /**
     * OpenProject #2009: before this fix, the whole per-job requeue loop and the initial claiming
     * `UPDATE` shared one outer `try`/`catch` -- a single failing insert aborted the loop, silently
     * stranding every job after it in the array (marked `interrupted` in history, absent from `jobs`,
     * and invisible to a later sweep, which only ever looks at `state = 'active'` rows).
     *
     * `WIKI.db.insert` is temporarily wrapped to reject only the middle job's insert, modelling
     * whatever real failure (a constraint violation, a dropped connection) the outer catch used to
     * treat as fatal for the whole batch.
     */
    test('one job failing to requeue does not strand the stale jobs after it', async () => {
      const rowA = await insertActiveHistory({ task: 'reap2009TaskA' })
      const rowB = await insertActiveHistory({ task: 'reap2009TaskB' })
      const rowC = await insertActiveHistory({ task: 'reap2009TaskC' })
      historyIds.push(rowA.id, rowB.id, rowC.id)
      jobIds.push(rowA.id, rowB.id, rowC.id)

      const originalInsert = WIKI.db.insert.bind(WIKI.db)
      ;(WIKI.db as any).insert = (table: any) => {
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

      const warnCalls: string[] = []
      const originalWarn = WIKI.logger.warn
      WIKI.logger.warn = ((msg: string) => {
        warnCalls.push(String(msg))
      }) as any

      let requeued: number
      try {
        requeued = await scheduler.reapStaleJobs()
      } finally {
        WIKI.db.insert = originalInsert
        WIKI.logger.warn = originalWarn
      }

      assert.equal(requeued, 2, 'only the two successful inserts should count toward the total')

      const queuedA = await fixtures.db.select().from(jobsTable).where(eq(jobsTable.id, rowA.id))
      const queuedB = await fixtures.db.select().from(jobsTable).where(eq(jobsTable.id, rowB.id))
      const queuedC = await fixtures.db.select().from(jobsTable).where(eq(jobsTable.id, rowC.id))
      assert.equal(queuedA.length, 1, 'the job before the failure must still be requeued')
      assert.equal(queuedB.length, 0, 'the failing job itself was never inserted')
      assert.equal(queuedC.length, 1, 'the job after the failure must not be stranded by it')

      assert.ok(
        warnCalls.some((msg) => msg.includes(rowB.id) && msg.includes('simulated insert failure')),
        'the warning must name the failing job id'
      )
    })

    /**
     * OpenProject #1996: `runJob()`'s in-process branch used to `await` the task call directly, with
     * no ceiling -- unlike `executeOnWorker()`, which already races against `taskTimeout`. A task
     * whose promise never settles left `runJob()` (and therefore `processJob()`'s
     * `Promise.allSettled`) pending forever, so `activeWorkers` was never returned and, after enough
     * wedged jobs, the instance stopped claiming any further job at all. `executeInProcess()` gives
     * the in-process branch the same race-against-a-timer shape, so `runJob()` always settles and
     * this bookkeeping always completes. This is a DB-backed integration test of that fix through the
     * full `processJob()` claim path, complementing the pure-unit `executeInProcess (fake WIKI)` suite
     * above, which exercises the same ceiling in isolation.
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

    /**
     * OpenProject #2084: the reclaim upsert's `set` clause refreshed `state`/`executedBy`/`startedAt`/
     * `attempt` but left `lastErrorMessage` untouched, so a job interrupted, requeued, reclaimed and
     * then *succeeded* on retry still carried `reapStaleJobs()`'s stale-instance message forever —
     * `runJob()`'s own success path only ever sets `state`/`completedAt`, never touching the column
     * either. A reclaim must start the row as clean as a fresh claim.
     */
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

        // Attempt 1: claimed, then the process "dies" before recording anything (runJob stubbed), so
        // reapStaleJobs() flips the row to 'interrupted' and stamps a stale-instance lastErrorMessage.
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

        // Attempt 2 (the retry): reclaimed via the SAME jobHistory row — this exercises the ON
        // CONFLICT DO UPDATE path — and this time the task actually runs to completion.
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
     * OpenProject #2072: `processJob()` read `activeWorkers` and only incremented it *after* awaiting
     * the whole claim transaction, so two overlapping callers (the polling interval and a burst of
     * `newJob` NOTIFYs both call this, unsynchronized) could both compute the same `availableWorkers`
     * and each claim up to `maxWorkers` jobs of their own -- `maxWorkers` bounded nothing.
     *
     * `Promise.all` fires both calls back-to-back in the same tick: JS runs each call's synchronous
     * prefix -- reading `activeWorkers`, and (once fixed) reserving the slots -- to completion before
     * yielding at its first `await`, so the second call's synchronous prefix always runs before the
     * first call's claim transaction has even started. That makes the outcome deterministic rather
     * than a timing race: fixed, the second call always sees the first call's reservation already
     * made and returns immediately having claimed nothing; unfixed, it always sees the pre-reservation
     * `activeWorkers` and proceeds to claim its own batch regardless.
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

/**
 * OpenProject #1653: `reapStaleJobs()`'s cutoff comparison (`lt(jobHistoryTable.startedAt, cutoff)`)
 * runs entirely server-side -- both the `startedAt` values written above and the `cutoff` computed
 * from `Temporal.Now.instant()` are sent to postgres as parameters and compared there, never
 * round-tripped back through the `pg` driver's own `Date` reconstruction -- so it should select the
 * same rows regardless of the Node process's local `TZ`. See
 * `docs/audit-2026-08-24/correctness-data-schema.md` §2 for the read-side counterpart of this defect
 * (`models/jobs.ts#isHealthy`/`#cleanHistory`, `models/users.ts#validateToken`) that this suite does
 * NOT exercise here, precisely because `reapStaleJobs()`'s own cutoff never reads a `timestamp` column
 * back into JS before comparing it. This is regression coverage that the stale-job cutoff keeps
 * selecting the right rows even off UTC, gated the same way the DB-backed suite above is.
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
      WIKI.config = { scheduler: { retryBackoff: 0, staleJobTimeout: 1, maxRetries: 2 } }
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
