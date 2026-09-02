/**
 * `core/scheduler.ts`'s job bookkeeping: queueing (`addScheduled`, `addJob`), the completion-promise
 * map, and shutdown. Pure — no database, no worker pool.
 *
 * The rest of this module's coverage lives in three siblings, split out of one 1,682-line file
 * (TEST-F14) so the pure/DB boundary is a filename property rather than something a reader has to
 * derive from a `{ skip }` option per describe: `scheduler.execution.test.ts` (running a job, in
 * process and on a worker), `scheduler.reaping.db.test.ts` and `scheduler.schema.db.test.ts`.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { jobs as jobsTable, jobSchedule as jobScheduleTable } from '../db/schema.ts'
import { ensureTemporal } from '../test/temporal.ts'
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
 * `expireCompletionPromises()`, OpenProject #928: the only way an `addJob({ promise: true })` deferred
 * ever otherwise settled was a `jobCompleted` NOTIFY -- and postgres NOTIFY is not durable, so one
 * missed during a LISTEN reconnect left the deferred, and everything awaiting it, pending forever. This
 * sweep rejects (and stops tracking) any entry older than its ceiling, driven entirely by
 * `completionPromises`/`WIKI.config` -- no database or real timers involved, so it runs as a fast fake-
 * WIKI unit test rather than needing the DB-backed fixture below.
 */
describe('expireCompletionPromises (fake WIKI)', () => {
  let wikiHandle: { restore(): void }

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

  beforeEach(() => {
    destroyCalls = 0
    wikiHandle = installTestWiki({
      // -> 0.05s taskTimeout + the fixed 1s SHUTDOWN_DRAIN_GRACE = a ~1.05s bound: short enough to
      //    keep this suite fast, long enough to clearly separate "waited out the bound" from
      //    "resolved immediately".
      config: { scheduler: { taskTimeout: 0.05 } }
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
