import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { jobs as jobsTable, jobSchedule as jobScheduleTable } from '../../db/schema.ts'

/**
 * Regression test for two coupled pre-existing bugs in `addScheduled()`'s future-job-scheduling loop:
 *
 * 1. `plannedIterations.next() as any` was read with the ES-iterator shape (`.value` / `.done`), but
 *    cron-parser v5's `next()` returns the `CronDate` directly — it has neither property. `.value` is
 *    `undefined`, so `next.value.getTime()` throws the moment `existingJobs.some(...)`'s callback
 *    actually runs (i.e. whenever at least one job is already scheduled), and the throw is swallowed
 *    by the surrounding `catch { break }` — so the loop adds *zero* new jobs instead of the ones still
 *    due. `.done` is likewise always `undefined` (falsy), so on an empty `existingJobs` the loop never
 *    naturally terminates and only ever stops at the 10-iteration cap.
 * 2. The adjacent `addJob({ ... })` call passed a `useWorker` property `addJob` doesn't accept (already
 *    re-derived internally from `this.tasks`) and handed `waitUntil` an ISO string where
 *    `AddJobOptions.waitUntil` — and the `timestamp()` column it's written to — expect a `Date`.
 *
 * This drives the real `addScheduled()` method against lightweight fakes for `WIKI.db`, rather than a
 * live Postgres connection or a duplicate of the loop's logic, so it fails under the pre-fix code and
 * passes only once the real fix is in place.
 */

let insertedJobs: any[]
let scheduleJobsMock: any[]
let existingJobsMock: any[]
let scheduler: any
let previousWiki: any
let previousTemporal: any

/**
 * Minimal stand-in for the subset of `Temporal.Instant` that `addScheduled()` calls
 * (`Now.instant()`, `.add()`, `.subtract()`, `.toString({ smallestUnit })`).
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node`
 * is v25.9.0, which doesn't expose it (confirmed: `typeof Temporal === 'undefined'` even with
 * `--harmony-temporal`). Stubbing just what this code path touches — rather than pulling in a full
 * polyfill dependency for a runtime gap outside this task's scope — keeps the test independent of
 * that environment mismatch without changing what's actually exercised.
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

  scheduler = (await import('../../core/scheduler.ts')).default
  // -> Bypass `init()` (worker pool + reading tasks/simple/ off disk): only `this.tasks` is read by
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

test('schedules multiple future jobs from a cron schedule even when a job is already scheduled for that task', async () => {
  scheduleJobsMock = [{ task: 'testTask', cron: '* * * * *', payload: { foo: 'bar' } }]
  // -> Non-empty and matching `job.task`, which is what made the pre-fix `.some()` callback run (and
  //    throw) at all. Its `waitUntil` is far in the past so it can never collide with a freshly
  //    computed near-future iteration.
  existingJobsMock = [{ task: 'testTask', waitUntil: new Date(0) }]

  await scheduler.addScheduled()

  // Pre-fix: the `.some()` callback throws on the very first iteration (since `existingJobsMock` is
  // non-empty), caught by `catch { break }` before any `addJob` call is reached — zero rows inserted.
  // Fixed: a minutely cron over the ~24h05m window has far more than 10 due iterations, so the
  // 10-iteration cap is what stops it.
  assert.equal(insertedJobs.length, 10)

  for (const job of insertedJobs) {
    assert.equal(job.task, 'testTask')
    assert.deepEqual(job.payload, { foo: 'bar' })
    assert.ok(job.waitUntil instanceof Date, 'waitUntil must be a Date, not an ISO string')
    assert.ok(!Number.isNaN(job.waitUntil.getTime()))
    // -> Derived internally by `addJob` from `this.tasks`, not from a `useWorker` option (which
    //    `AddJobOptions` does not have).
    assert.equal(job.useWorker, true)
  }

  // Iterations must be strictly increasing in time and none may collide with each other.
  const times = insertedJobs.map((j) => j.waitUntil.getTime())
  const uniqueTimes = new Set(times)
  assert.equal(uniqueTimes.size, times.length)
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1])
  }
})

test('adds no jobs and does not throw when the schedule has no due iterations left', async () => {
  // A cron expression that only fires on Feb 29th never matches inside a 24h05m window unless today
  // happens to be one, which reliably exercises the natural (non-cap) loop termination path.
  scheduleJobsMock = [{ task: 'leapTask', cron: '0 0 29 2 *', payload: {} }]
  existingJobsMock = []

  await scheduler.addScheduled()

  assert.equal(insertedJobs.length, 0)
})
