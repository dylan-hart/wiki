import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { jobs as jobsTable, jobSchedule as jobScheduleTable } from '../db/schema.ts'

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

let insertedJobs: any[]
let scheduleJobsMock: any[]
let existingJobsMock: any[]
let scheduler: any
let previousWiki: any
let previousTemporal: any

/**
 * Minimal stand-in for the subset of `Temporal.Instant` that `addScheduled()` calls
 * (`Now.instant()`, `.add()`, `.toString({ smallestUnit })`).
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
 * v25.9.0, which doesn't expose it (same environment gap noted in tasks 753/756/757/760/761 — not a
 * spec deviation). Stubbing just what this code path touches keeps the test independent of that
 * runtime gap without changing what's actually exercised.
 */
function installFakeTemporal(): void {
  const durationToMs = (d: { hours?: number; minutes?: number }) =>
    (d.hours ?? 0) * 3_600_000 + (d.minutes ?? 0) * 60_000
  const makeInstant = (epochMs: number): any => ({
    add: (d: any) => makeInstant(epochMs + durationToMs(d)),
    subtract: (d: any) => makeInstant(epochMs - durationToMs(d)),
    toString: () => new Date(epochMs).toISOString()
  })
  ;(globalThis as any).Temporal = { Now: { instant: () => makeInstant(Date.now()) } }
}

before(async () => {
  previousTemporal = (globalThis as any).Temporal
  previousWiki = (globalThis as any).WIKI
  installFakeTemporal()
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

  scheduler = (await import('./scheduler.ts')).default
  // -> Bypass `init()` (worker pool + reading tasks/simple/ off disk): only `this.tasks` is read, by
  //    `addJob()`, to derive `useWorker`.
  scheduler.tasks = {}
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
  ;(globalThis as any).Temporal = previousTemporal
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
  assert.equal(new Set(firstCallTimes).size, 10, 'all 10 rows from the first call must be distinct')

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
