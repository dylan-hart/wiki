/**
 * `core/scheduler.ts`'s execution half: claiming a job, running it in process or on the real worker
 * pool, and what each failure path logs. Pure — no database; the one real `FixedThreadPool` here is
 * this process's own.
 *
 * Split out of `core/scheduler.test.ts` (TEST-F14); see that file's header for the whole map.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { FixedThreadPool } from 'poolifier'
import { ensureTemporal } from '../test/temporal.ts'
import { getJobExecutionContext } from '../helpers/jobExecutionContext.ts'
import { installTestWiki } from '../test/mocks.ts'

let scheduler: any

before(async () => {
  await ensureTemporal()
  scheduler = (await import('./scheduler.ts')).default
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
 * operator shipping only `error` to alerting actually sees it -- `cardinaljs_jobs_queued` counts
 * *pending* jobs, so a storm of failing-and-retrying jobs looks identical to a healthy queue from
 * that metric alone. A still-retryable failure must keep logging at `warn`, and says so in its own
 * message (`, retrying`) rather than in a second line.
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
      (c) => c.args[0] === 'jobs' && c.args[1] === 'willFail failed, retrying'
    )
    assert.equal(failureCalls.length, 1, 'the failure message must be logged exactly once')
    assert.equal(failureCalls[0]!.level, 'warn')
    assert.equal(failureCalls[0]!.args[2].job, 'job-retryable')
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
      (c) => c.args[0] === 'jobs' && c.args[1] === 'willFail failed, no attempts left'
    )
    assert.equal(failureCalls.length, 1, 'the failure message must be logged exactly once')
    assert.equal(failureCalls[0]!.level, 'error')
    assert.equal(
      logCalls.filter((c) => c.level === 'warn' && c.args[1] === failureCalls[0]!.args[1]).length,
      0,
      'the exhausted-retries failure message must not also be logged at warn'
    )
    // -> No reschedule attempted once retries are exhausted, so the message must not claim one.
    assert.equal(
      logCalls.some((c) => typeof c.args[1] === 'string' && c.args[1].endsWith(', retrying')),
      false
    )
  })
})

/**
 * OpenProject #1937: `runJob()`'s catch branch used to log a job's failure as two bare strings, with
 * no way to trace which job (or attempt) a given log line was about. Since the Phase 2 sweep
 * (#2665) it is ONE record — scope `jobs`, a sentence, and `{ job, attempts, ms, error }` as fields
 * (`attempt: 'n/m'` on the still-retryable line; see #2672), with the `Error` itself under `error` so
 * the renderer puts the message inline and the stack under
 * it. `error` and `warn` share one mock here (task #1993's log-level split routes an
 * exhausted-retries failure to `error`, not `warn`) since this test's own concern is the field
 * payload, not which level a given retry count picks.
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

  test('the one failure log call carries { job, attempts, error } as fields, not concatenated in', async () => {
    failureMock.mock.resetCalls()
    // -> retries === maxRetries: no reschedule branch, so this stays free of the Temporal/db.insert
    //    path that `attempt` here doesn't need. This also means retries are exhausted, so the call
    //    logs at `error` (task #1993) — `failureMock` above is registered for both levels.
    const job = {
      id: 'job-1',
      task: 'boom',
      payload: {},
      useWorker: false,
      retries: 2,
      maxRetries: 2
    }

    await scheduler.runJob(job)

    assert.equal(failureMock.mock.callCount(), 1, 'a failure is one record, not two')
    const [failureCall] = failureMock.mock.calls

    assert.equal(failureCall!.arguments[0], 'jobs')
    assert.equal(failureCall!.arguments[1], 'boom failed, no attempts left')

    const fields = failureCall!.arguments[2] as Record<string, unknown>
    assert.equal(fields.job, 'job-1')
    // -> The terminal line reports the total, not "3 of 3": there is no next attempt for `n/m` to
    //    be counting towards, and `attempts=3` is what an operator reads as "it used all three".
    assert.equal(fields.attempts, 3)
    assert.equal(fields.attempt, undefined)
    assert.equal(typeof fields.ms, 'number')
    // -> The `Error` itself, not `err.message`: the renderer is what turns it into `error="…"` plus
    //    a stack, and only an `Error` gives it one.
    assert.ok(fields.error instanceof Error)
    assert.equal((fields.error as Error).message, 'task exploded')
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
      config: { scheduler: { taskTimeout: 1 } }
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
      config: { scheduler: { taskTimeout: 0.05 } }
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
 * OpenProject #2672: the scheduler owns a job's outcome line, not the task.
 *
 * A `tasks/simple/` task hands back `{ summary, ...fields }` when its run amounted to something, and
 * `runJob()` turns that into the ONE `info` record for the run — carrying the job id, the attempt and
 * the duration the task itself cannot know. A task that did nothing returns nothing and the run stays
 * at `debug`, which is what keeps a timer-driven sweep that found nothing out of an operator's log.
 *
 * Asserted through a `mock.fn()`-style recorder per level against the real `runJob()`, on scope +
 * level + the fields object rather than on a rendered string: the rendering is `core/logger.ts`'s
 * business.
 */
describe('runJob outcome logging (fake WIKI)', () => {
  let wikiHandle: { restore(): void }
  let logCalls: { level: string; args: any[] }[]
  let inserted: any[]

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    logCalls = []
    inserted = []
    const makeLogFn =
      (level: string) =>
      (...args: any[]) =>
        logCalls.push({ level, args })
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      config: { scheduler: { retryBackoff: 60 } },
      // -> `null` is a valid, silently-discarded notify target (`helpers/pubsub.ts`), so no real
      //    LISTEN/NOTIFY client is needed for the `jobCompleted` sends these paths make.
      scheduler: { pubsubClient: null },
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
          values: async (values: any) => {
            inserted.push(values)
            return {}
          }
        })
      }
    })
    scheduler.tasks = {}
  })

  function makeJob(overrides: Record<string, any> = {}) {
    return {
      id: 'job-1',
      task: 'sweep',
      useWorker: false,
      payload: {},
      retries: 0,
      maxRetries: 3,
      ...overrides
    }
  }

  function callsAt(level: string, message: string) {
    return logCalls.filter((c) => c.level === level && c.args[1] === message)
  }

  test("a task's returned summary becomes one info line, in place of the debug finish line", async () => {
    scheduler.tasks.sweep = async () => ({ summary: 'purged expired user keys', purged: 12 })

    await scheduler.runJob(makeJob())

    const [outcome] = callsAt('info', 'sweep purged expired user keys')
    assert.ok(outcome, 'the summary must be logged at info, as the task name plus the sentence')
    assert.equal(outcome.args[0], 'jobs')
    const fields = outcome.args[2] as Record<string, unknown>
    assert.equal(fields.job, 'job-1')
    // -> `n/m`, not a bare `n`: `maxRetries` counts retries, so four attempts is what a job with
    //    `maxRetries: 3` actually gets, and the line has to say so without the reader knowing that.
    assert.equal(fields.attempt, '1/4')
    assert.equal(fields.purged, 12, "the summary's own fields ride the same record")
    assert.equal(typeof fields.ms, 'number', 'ms is a number, for the renderer to humanise')
    assert.equal(fields.summary, undefined, 'the sentence is the message, not also a field')
    assert.equal(
      callsAt('debug', 'sweep finished').length,
      0,
      'the info outcome replaces the debug finish line rather than joining it'
    )
  })

  test('a task that returns nothing logs the debug finish line and no info at all', async () => {
    scheduler.tasks.sweep = async () => {}

    await scheduler.runJob(makeJob())

    const [finished] = callsAt('debug', 'sweep finished')
    assert.ok(finished, 'a run that reported nothing still records that it ran, at debug')
    assert.equal((finished.args[2] as Record<string, unknown>).attempt, '1/4')
    assert.equal(
      logCalls.filter((c) => c.level === 'info').length,
      0,
      'a sweep that found nothing must not reach an operator shipping info'
    )
  })

  test('a non-object return — what a worker-thread job resolves — is not a summary', async () => {
    // -> `worker.ts`'s `ThreadWorker` resolves `true`, never the task's own value, so every worker
    //    job lands here rather than in the summary branch.
    scheduler.tasks.sweep = async () => true

    await scheduler.runJob(makeJob())

    assert.equal(callsAt('debug', 'sweep finished').length, 1)
    assert.equal(logCalls.filter((c) => c.level === 'info').length, 0)
  })

  test('an object with no usable summary string is not a summary either', async () => {
    scheduler.tasks.sweep = async () => ({ summary: '', purged: 3 })

    await scheduler.runJob(makeJob())

    assert.equal(callsAt('debug', 'sweep finished').length, 1)
    assert.equal(logCalls.filter((c) => c.level === 'info').length, 0)
  })

  test('the start line names the attempt out of the total', async () => {
    scheduler.tasks.sweep = async () => {}

    await scheduler.runJob(makeJob({ retries: 2, maxRetries: 3 }))

    const [started] = callsAt('debug', 'sweep started')
    assert.ok(started)
    assert.equal(started.args[0], 'jobs')
    assert.deepEqual(started.args[2], { job: 'job-1', attempt: '3/4' })
  })

  test('a retryable failure names the instant the retry is actually queued for', async () => {
    scheduler.tasks.sweep = async () => {
      throw new Error('transient failure')
    }

    await scheduler.runJob(makeJob({ retries: 1, maxRetries: 3 }))

    const [retrying] = callsAt('warn', 'sweep failed, retrying')
    assert.ok(retrying)
    const fields = retrying.args[2] as Record<string, unknown>
    assert.equal(fields.attempt, '2/4')
    assert.ok(fields.error instanceof Error)
    // -> Not merely "an ISO-looking string": the whole point of the field is that it is the row's
    //    real `waitUntil`, so it must equal what the requeue insert actually wrote.
    const requeued = inserted.find((values) => values.waitUntil instanceof Date)
    assert.ok(requeued, 'a retryable failure requeues the job')
    assert.equal(
      fields.next,
      requeued.waitUntil.toTemporalInstant().toString({ smallestUnit: 'millisecond' })
    )
    // -> retryBackoff 60 with retries: 1 -> 2**1 * 60 = 120s out, so this is unmistakably the
    //    backoff rather than "now".
    assert.ok(requeued.waitUntil.getTime() - Date.now() > 100_000)
  })

  test('a terminal failure names no next run, because there is not one', async () => {
    scheduler.tasks.sweep = async () => {
      throw new Error('permanent failure')
    }

    await scheduler.runJob(makeJob({ retries: 3, maxRetries: 3 }))

    const [terminal] = callsAt('error', 'sweep failed, no attempts left')
    assert.ok(terminal)
    const fields = terminal.args[2] as Record<string, unknown>
    assert.equal(fields.attempts, 4)
    assert.equal(fields.next, undefined)
    assert.equal(
      inserted.filter((values) => values.waitUntil instanceof Date).length,
      0,
      'nothing is requeued once the attempts are used up'
    )
  })
})
