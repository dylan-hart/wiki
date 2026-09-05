/**
 * `core/scheduler.ts#reapStaleJobs()` against a real, migrated Postgres: the claim-and-retry race a
 * mock of the query builder could only re-describe, and the same cutoff re-run under a non-UTC `TZ`.
 *
 * Split out of `core/scheduler.test.ts` (TEST-F14); see that file's header for the whole map. Both
 * describes below carry their own `{ skip: !hasTestDatabase() }` and their own `before()` — the one
 * that resets `scheduler.tasks`/`maxWorkers` moved here with the describe that sets it, since those
 * are process-global fields on the singleton and the pure suites must not inherit them.
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

        /*
          Attempt 2 (the retry): reclaimed via the SAME jobHistory row — this exercises the ON
          CONFLICT DO UPDATE path — and this time the task actually runs to completion.

          `waitUntil` is stamped into the past first rather than left as `reapStaleJobs()` wrote it.
          That value is Node's `new Date()`, while `processJob()` claims on `"waitUntil" <= NOW()` and
          postgres's `NOW()` is the CLAIMING TRANSACTION'S START — so a requeued row can be a
          millisecond or two in that transaction's future and simply not be claimed. In a running
          instance the next poll picks it up and nothing is lost; here it left the row `interrupted`
          and failed the assertion below, intermittently and only under load. A definite past instant
          is what a later poll would see, which is the state this test is actually about.
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
