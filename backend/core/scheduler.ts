import { DynamicThreadPool, FixedThreadPool } from 'poolifier'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CronExpressionParser } from 'cron-parser'
import crypto from 'node:crypto'
import { createDeferred, type Deferred } from '../helpers/common.ts'
import { connectListener, createNotifier, type ListenerHandle } from '../helpers/pubsub.ts'
import { runWithJobExecutionContext } from '../helpers/jobExecutionContext.ts'
import { withTimeout } from '../helpers/timeout.ts'
import { camelCase } from 'es-toolkit/string'
import { remove } from 'es-toolkit/array'
import {
  jobs as jobsTable,
  jobLock as jobLockTable,
  jobSchedule as jobScheduleTable,
  jobHistory as jobHistoryTable
} from '../db/schema.ts'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import type { PoolClient } from 'pg'

/**
 * An in-process task, loaded from `tasks/simple/`.
 *
 * `jobId` is this task's own row in `jobHistory` — most tasks have no use for it, but one that wants
 * to hand something back (`exportContent`'s `{ filePath, fileSize }`) writes it there via
 * `WIKI.models.jobs.setResult(jobId, ...)`, which is what lets a follow-up route find it later.
 */
export type SimpleTask = (payload?: any, jobId?: string) => Promise<void> | void

/** Fallback for `scheduler.taskTimeout`, in seconds, when nothing is configured. */
const DEFAULT_TASK_TIMEOUT = 300

/** Fallback for `scheduler.staleJobTimeout`, in seconds, when nothing is configured. */
const DEFAULT_STALE_JOB_TIMEOUT = 3600

/**
 * How long an `addJob({ promise: true })` deferred waits for a `jobCompleted` NOTIFY before giving up
 * on its own (OpenProject #928).
 *
 * A multiple of `staleJobTimeout` rather than its own config key: that setting is already this
 * scheduler's "nobody could still be working on this" threshold (`reapStaleJobs`'s own doc comment), so
 * a promise waiting on a job that has gone stale, been reaped, and requeued should still be alive to
 * see the requeued attempt finish — one plain `staleJobTimeout` would expire it out from under a job
 * that is, in fact, still going to answer.
 */
const COMPLETION_PROMISE_TTL_MULTIPLIER = 2

/**
 * How much longer than the task timeout the scheduler waits before giving up on its own.
 *
 * The abort is the polite route — the pool aborts a task that is merely slow, and rejects with a
 * `TimeoutError` naming what happened. This grace period lets that answer arrive first, and only
 * covers the case where nothing is going to answer at all.
 */
const TASK_TIMEOUT_GRACE = 5000

/**
 * Extra time `stop()`'s drain waits on top of `taskTimeout` before giving up on in-flight jobs.
 *
 * A worker-thread job already has its own ceiling — `executeOnWorker`'s abort at `taskTimeout`, or
 * the backup timer at `taskTimeout + TASK_TIMEOUT_GRACE` for a worker that dies without answering —
 * so `taskTimeout` alone already bounds that case with room to spare. An in-process (non-worker)
 * task has no timeout of its own, though, so this grace is what keeps `stop()`'s drain bounded for
 * that case too, without waiting the full `TASK_TIMEOUT_GRACE` on top for a job that's already
 * limited elsewhere.
 */
const SHUTDOWN_DRAIN_GRACE = 1000

/**
 * Sends the scheduler's cross-instance notifications, one at a time.
 *
 * Nothing here awaits a notification: a job being added or finishing should not wait on a round trip,
 * and `processJob` runs concurrently with itself, so two notifications easily meet on the one client.
 */
const notifier = createNotifier(() => WIKI.scheduler.pubsubClient, 'scheduler')

/**
 * Tell every instance that a job has finished, so an `addJob({ promise: true })` caller waiting on
 * another instance's run of it settles (see `CompletionPromise` below).
 *
 * The three senders — a completed run, a failed one, and the sweep giving up on an interrupted job
 * with no attempts left — wrote out the same envelope, which is exactly the sort of literal that
 * drifts a field at a time until one listener silently stops matching.
 */
function notifyJobCompleted(
  id: string,
  state: 'success' | 'failed',
  errorMessage?: string | null
): void {
  notifier.send(
    'scheduler',
    JSON.stringify({
      source: WIKI.INSTANCE_ID,
      event: 'jobCompleted',
      state,
      id,
      ...(errorMessage !== undefined && { errorMessage })
    })
  )
}

/** A pending `addJob({ promise: true })` caller, waiting on the `jobCompleted` event. */
interface CompletionPromise {
  id: string
  added: Temporal.Instant
  promise: Deferred['promise']
  resolve: Deferred['resolve']
  reject: Deferred['reject']
}

export interface AddJobOptions {
  /** The task name to execute. */
  task: string
  /** An optional data object to pass to the job. */
  payload?: any
  /** An optional datetime after which the task is allowed to run. */
  waitUntil?: Date
  /** The number of times this job can be restarted upon failure. Uses server defaults if not provided. */
  maxRetries?: number
  /** Whether this is a scheduled job. */
  isScheduled?: boolean
  /** Whether to notify all instances that a new job is available. */
  notify?: boolean
  /** Whether to return a promise property that resolves when the job completes. */
  promise?: boolean
}

/**
 * The claim step of `reapStaleJobs()`, split out purely so its return type can be named
 * (`Awaited<ReturnType<typeof claimStrandedJobs>>`) without hand-writing the row shape.
 *
 * `UPDATE ... RETURNING` is the claim itself: two instances sweeping at once both filter on
 * `state = 'active'`, so whichever commits second matches nothing and returns nothing. Left to the
 * caller: everything after the claim succeeds or fails per job, not as a single unit with this.
 */
function claimStrandedJobs(cutoff: Date, staleAfter: number) {
  return WIKI.db
    .update(jobHistoryTable)
    .set({
      state: 'interrupted',
      lastErrorMessage: `No instance reported on this job within ${staleAfter}s. Whatever was running it is gone.`
    })
    .where(and(eq(jobHistoryTable.state, 'active'), lt(jobHistoryTable.startedAt, cutoff)))
    .returning()
}

export default {
  workerPool: null as DynamicThreadPool<any, boolean> | FixedThreadPool<any, boolean> | null,
  pubsubClient: null as PoolClient | null,
  listenerHandle: null as ListenerHandle | null,
  maxWorkers: 1,
  activeWorkers: 0,
  pollingRef: null as NodeJS.Timeout | null,
  scheduledRef: null as NodeJS.Timeout | null,
  tasks: null as Record<string, SimpleTask> | null,
  completionPromises: [] as CompletionPromise[],
  /** `runJob` promises `processJob` currently has in flight, so `stop()` can drain them. */
  inFlightJobs: new Set<Promise<void>>(),
  async init() {
    this.maxWorkers =
      WIKI.config.scheduler.workers === 'auto'
        ? os.cpus().length - 1
        : WIKI.config.scheduler.workers
    if (this.maxWorkers < 1) {
      this.maxWorkers = 1
    }
    const workerFile = path.join(WIKI.SERVERPATH, 'worker.ts')
    const poolOptions = {
      errorHandler: (err: Error) => WIKI.logger.warn('worker', 'worker pool error', { error: err }),
      exitHandler: () => WIKI.logger.debug('worker', 'worker offline'),
      onlineHandler: () => WIKI.logger.debug('worker', 'worker online'),
      // -> Forwarded verbatim to `new Worker(file, options)`, so this is what `worker.ts` reads out
      //    of `node:worker_threads`' `workerData` to build its own `INSTANCE_ID` before its logger
      //    exists. One object for the whole pool — the per-worker half of the id is the thread's own
      //    `threadId`, not anything sent from here.
      workerOptions: {
        workerData: { parentInstanceId: WIKI.INSTANCE_ID }
      }
    }
    /*
      `DynamicThreadPool` refuses a minimum equal to its maximum (poolifier 5.x: "Use a fixed pool
      instead"). `maxWorkers` lands on exactly 1 whenever `scheduler.workers` is explicitly set to 1,
      or 'auto' on a single-CPU host/container — both real deployment shapes, not edge cases — so
      always going through `DynamicThreadPool(1, maxWorkers, ...)` crashed `init()` (and therefore
      boot) on any of them. A single-worker instance has nothing to scale between anyway, so it gets a
      `FixedThreadPool` of exactly one instead.
    */
    this.workerPool =
      this.maxWorkers === 1
        ? new FixedThreadPool(1, workerFile, poolOptions)
        : new DynamicThreadPool(1, this.maxWorkers, workerFile, poolOptions)
    this.tasks = {}
    for (const f of await fs.readdir(path.join(WIKI.SERVERPATH, 'tasks/simple'))) {
      // -> `tasks/simple/` carries this repo's usual co-located `*.test.ts` files
      //    (send-watch-digests.test.ts, update-locales.test.ts) alongside the real task modules.
      //    Without this filter, `readdir` returns those too, and the unconditional `import()`
      //    below executes their `node:test` suites live as a side effect of every boot -- caught
      //    only now, running this loop for the first time against a real filesystem listing rather
      //    than a fake WIKI in a unit test. `[^.]+\.[jt]s$` requires no dot before the extension,
      //    so `name.ts`/`name.js` match but `name.test.ts` does not.
      if (!/^[^.]+\.[jt]s$/.test(f)) {
        continue
      }
      const taskName = camelCase(f.replace(/\.[jt]s$/, ''))
      // -> Unlike `workerFile` above (a plain OS path, which is what both poolifier's own
      //    pre-flight `existsSync()` check and `new Worker()` itself expect), dynamic `import()`
      //    parses its argument as a module specifier -- a bare absolute Windows path like
      //    `C:\...` gets its drive letter read as a URL *scheme*, throwing
      //    ERR_UNSUPPORTED_ESM_URL_SCHEME ("Received protocol 'c:'"). A `file://` URL is what
      //    `import()` actually wants for an absolute path; a raw POSIX path happens to also parse
      //    (no colon before the first `/`), which is why this went unnoticed until run on Windows.
      this.tasks[taskName] = (
        await import(pathToFileURL(path.join(WIKI.SERVERPATH, 'tasks/simple', f)).href)
      ).task
    }
    return this
  },
  async start(): Promise<void> {
    const connectionAppName = `Wiki.js - ${WIKI.INSTANCE_ID}:SCHEDULER`

    // -> `connectListener` attaches the 'error' handler this client needs (see helpers/pubsub.ts):
    //    on a dropped connection it re-connects and re-LISTENs on its own, rather than throwing on
    //    an unhandled 'error' and taking the process down with it.
    this.listenerHandle = await connectListener({
      pool: WIKI.dbManager.listenerPool!,
      applicationName: connectionAppName,
      channels: ['scheduler'],
      label: 'scheduler',
      onNotification: async (msg) => {
        if (msg.channel !== 'scheduler') {
          return
        }
        try {
          const decoded = JSON.parse(msg.payload!)
          switch (decoded?.event) {
            case 'newJob': {
              // -> No counting here: `processJob` accounts for the jobs it actually claims, and
              //    counting this call as a worker as well would hide one slot for its duration
              if (this.activeWorkers < this.maxWorkers) {
                await this.processJob()
              }
              break
            }
            case 'jobCompleted': {
              const jobPromise = this.completionPromises.find((p) => p.id === decoded.id)
              if (jobPromise) {
                if (decoded.state === 'success') {
                  jobPromise.resolve()
                } else {
                  jobPromise.reject(new Error(decoded.errorMessage))
                }
                setTimeout(() => {
                  remove(this.completionPromises, (p) => p.id === decoded.id)
                })
              }
              break
            }
          }
        } catch {}
      },
      getClient: () => this.pubsubClient,
      setClient: (client) => {
        this.pubsubClient = client
      }
    })

    // -> Start scheduled jobs check
    this.scheduledRef = setInterval(async () => {
      this.addScheduled()
      this.reapStaleJobs()
      this.expireCompletionPromises()
    }, WIKI.config.scheduler.scheduledCheck * 1000)

    // -> Add scheduled jobs on init
    const planned = await this.addScheduled()

    /*
      Anything left claimed but unfinished, before this instance starts claiming more. Most often
      that is what this very instance abandoned when it last went down — but it runs on the interval
      as well, since an instance that never comes back cannot clean up after itself.
    */
    await this.reapStaleJobs()

    // -> Start job polling
    this.pollingRef = setInterval(async () => {
      this.processJob()
    }, WIKI.config.scheduler.pollingCheck * 1000)

    WIKI.logger.info('jobs', 'scheduler started', { workers: this.maxWorkers, planned })
  },
  /**
   * Add a job to the scheduler
   */
  async addJob({
    task,
    payload = {},
    waitUntil,
    maxRetries,
    isScheduled = false,
    notify = true,
    promise = false
  }: AddJobOptions): Promise<{ id: string; promise?: Promise<void> } | undefined> {
    try {
      const jobId = crypto.randomUUID()
      const jobDefer = createDeferred()
      await WIKI.db.insert(jobsTable).values({
        id: jobId,
        task,
        useWorker: !(typeof this.tasks![task] === 'function'),
        payload,
        maxRetries: maxRetries ?? WIKI.config.scheduler.maxRetries,
        isScheduled,
        waitUntil,
        createdBy: WIKI.INSTANCE_ID
      })
      // -> Registered only once the row genuinely exists: pushed before the insert, a failed insert
      //    would leave this deferred tracked in `completionPromises` with no caller ever having
      //    received `jobDefer.promise` to attach a handler to, and `expireCompletionPromises()` would
      //    reject it hours later as an unhandled rejection with nothing to connect it back to this
      //    call (OpenProject audit 2026-08-24, finding 8).
      if (promise) {
        this.completionPromises.push({
          id: jobId,
          added: Temporal.Now.instant(),
          promise: jobDefer.promise,
          resolve: jobDefer.resolve,
          reject: jobDefer.reject
        })
      }
      if (notify) {
        notifier.send(
          'scheduler',
          JSON.stringify({
            source: WIKI.INSTANCE_ID,
            event: 'newJob',
            id: jobId
          })
        )
      }
      return {
        id: jobId,
        ...(promise && { promise: jobDefer.promise })
      }
    } catch (err: any) {
      WIKI.logger.warn('jobs', 'failed to queue job', { task, error: err })
    }
  },
  /**
   * Reject any `addJob({ promise: true })` deferred that has waited past its ceiling (OpenProject
   * #928), and stop tracking it.
   *
   * The only way a `completionPromises` entry ever otherwise settles is a `jobCompleted` NOTIFY
   * (`start()`'s `onNotification` handler above) — and postgres NOTIFY is not durable, so one missed
   * during a LISTEN reconnect is simply gone. Without this sweep that left the deferred, and everything
   * awaiting it (`api/system/info.ts`'s check-update route, for one), pending forever, and the map entry
   * itself leaked for the life of the process. `added` (written by `addJob`, otherwise never read) is
   * what makes each entry's age checkable.
   */
  expireCompletionPromises(): void {
    const ttlSeconds =
      (WIKI.config.scheduler.staleJobTimeout ?? DEFAULT_STALE_JOB_TIMEOUT) *
      COMPLETION_PROMISE_TTL_MULTIPLIER
    const cutoff = Temporal.Now.instant().subtract({ seconds: ttlSeconds })
    const expired = remove(
      this.completionPromises,
      (p) => Temporal.Instant.compare(p.added, cutoff) < 0
    )
    for (const p of expired) {
      p.promise.catch(() => {})
      p.reject(new Error(`Timed out after ${ttlSeconds}s waiting for job ${p.id} to complete.`))
    }
  },
  /**
   * Run a job in a worker thread, and stop waiting for it if it does not come back.
   *
   * A task promise that never settles is not a hypothetical: a worker thread that dies mid-task —
   * `process.exit`, an OOM kill, a native crash — takes the answer with it. Poolifier reports the
   * exit through its `exitHandler` but has nothing to attach it to, so the promise this awaits stays
   * pending forever, and with it everything the caller is holding: the job stays claimed, its history
   * row stays `active`, and the transaction around this never commits.
   *
   * Two ceilings, because they cover different failures. The abort signal is for a task that is still
   * running and merely slow — the pool aborts it and rejects, so the worker stops doing the work as
   * well. The timer is for the case where there is no longer anybody to abort, and is what makes the
   * wait finite no matter what happened to the thread.
   *
   * Either way the job ends up in the same place a thrown task does: recorded as failed, and retried
   * with the usual backoff.
   */
  async executeOnWorker(job: { task: string; payload?: any }): Promise<void> {
    const timeoutMs = (WIKI.config.scheduler.taskTimeout ?? DEFAULT_TASK_TIMEOUT) * 1000
    await withTimeout(
      // -> No `INSTANCE_ID` rider on the payload any more: a worker settles its own id from
      //    `workerData` at boot (see `poolOptions` above), so sending one per job only ever
      //    overwrote a correct value with the same information a job later.
      this.workerPool!.execute({ ...job }, undefined, AbortSignal.timeout(timeoutMs)),
      timeoutMs + TASK_TIMEOUT_GRACE,
      () =>
        new Error(
          `The worker running this task did not answer within ${timeoutMs / 1000}s. It may have crashed.`
        )
    )
  },

  /**
   * Take a batch of due jobs and run them.
   *
   * Two steps, deliberately not one transaction. Claiming a job has to be atomic — the `DELETE` with
   * `SKIP LOCKED` is what stops two instances running the same job, and the history row saying it
   * started belongs with it — but running it does not: a task takes as long as whatever it is waiting
   * on, and a transaction held open across that pins a pooled connection, holds the locks the claim
   * took, and stops postgres vacuuming anything newer than its snapshot for the duration.
   *
   * So the transaction covers the claim and nothing else, and the work happens after it commits, all
   * of the batch at once rather than one job at a time — the worker pool is there to be used, and the
   * batch was sized to it.
   *
   * The cost of committing the claim first is that a process which dies mid-job no longer has its
   * claim rolled back: the job is gone from the queue and its history row is left saying `active`.
   * That is what `reapStaleJobs` is for.
   */
  async processJob(): Promise<void> {
    // -> Reserved up front, before the `await` below, rather than left as a plain check-then-act read
    //    of `activeWorkers`: `processJob` has two overlapping callers (the polling interval and the
    //    `newJob` NOTIFY handler), and the claim transaction this reservation guards is several round
    //    trips long, so nothing serialized concurrent invocations before this and `maxWorkers` did not
    //    actually bind concurrency. Reserving synchronously (no `await` between the read and the
    //    increment) closes that window; the reservation is corrected back down below once the claim
    //    reports how many rows it actually got.
    const availableWorkers = this.maxWorkers - this.activeWorkers
    if (availableWorkers < 1) {
      WIKI.logger.debug('jobs', 'all workers busy, nothing claimed', { workers: this.maxWorkers })
      return
    }
    this.activeWorkers += availableWorkers

    let jobs: any[] = []
    try {
      jobs = await WIKI.db.transaction(async (trx: any) => {
        const claimed = await trx
          .delete(jobsTable)
          .where(
            inArray(
              jobsTable.id,
              // -> Ordered by due time and age, matching `models/jobs.ts#getUpcoming()`'s own
              //    `waitUntil ASC NULLS FIRST, createdAt ASC` — `id` is a `crypto.randomUUID()`
              //    with no correlation to either, so ordering by it left an eligible job that
              //    happened to sort high repeatedly passed over, and discarded the urgency
              //    `reapStaleJobs` explicitly sets (`waitUntil: new Date()` on a requeued row).
              sql`(SELECT id FROM jobs WHERE ("waitUntil" IS NULL OR "waitUntil" <= NOW()) ORDER BY "waitUntil" ASC NULLS FIRST, "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT ${availableWorkers})`
            )
          )
          .returning()
        for (const job of claimed) {
          // -> In the same transaction as the claim: a claim that rolls back must not leave a history
          //    row behind saying the job started
          await trx
            .insert(jobHistoryTable)
            .values({
              id: job.id,
              task: job.task,
              state: 'active',
              useWorker: job.useWorker,
              wasScheduled: job.isScheduled,
              payload: job.payload,
              attempt: job.retries + 1,
              maxRetries: job.maxRetries,
              executedBy: WIKI.INSTANCE_ID,
              createdAt: job.createdAt
            })
            .onConflictDoUpdate({
              target: jobHistoryTable.id,
              // -> A reclaim (this row already exists — the common case right after `reapStaleJobs`
              //    has interrupted it) must also refresh `attempt`, not just the run-state columns.
              //    Left out, a job whose worker/process keeps dying before `runJob` ever gets to
              //    record anything has `attempt` frozen at its very first claim forever, so
              //    `reapStaleJobs`'s `attempt > maxRetries` cutoff never trips and the job is
              //    requeued indefinitely instead of eventually being abandoned.
              set: {
                state: 'active',
                executedBy: WIKI.INSTANCE_ID,
                startedAt: sql`now()`,
                attempt: job.retries + 1,
                // -> Cleared on every reclaim, not just left over from whatever attempt last wrote it:
                //    `jobHistory` holds one row per job id across every attempt, so without this a job
                //    that was interrupted, requeued, reclaimed and then succeeded ends up `completed`
                //    while still carrying `reapStaleJobs`'s "gone" message from the attempt before it.
                lastErrorMessage: null
              }
            })
        }
        return claimed
      })
    } catch (err: any) {
      // -> Nothing was claimed: the transaction rolled back, so the jobs are still queued. Correct the
      //    up-front reservation back down to what was actually claimed (zero).
      this.activeWorkers -= availableWorkers
      WIKI.logger.warn('jobs', 'failed to claim jobs', { error: err })
      return
    }

    // -> Correct the up-front reservation down to what was actually claimed: `availableWorkers` slots
    //    were reserved before this transaction ran, but the claim may have returned fewer jobs (or
    //    none) than that ceiling allowed.
    this.activeWorkers -= availableWorkers - jobs.length

    if (jobs.length < 1) {
      return
    }

    // -> Tracked in `inFlightJobs` so `stop()` can await these rather than abandoning them mid-run
    //    (OpenProject #2019). Added before the first `await` below, so a `stop()` racing this call
    //    always sees the full batch. `activeWorkers` is not incremented again here — the up-front
    //    reservation above (`this.activeWorkers += availableWorkers`, corrected down to
    //    `jobs.length`) already accounts for this batch.
    const jobPromises = jobs.map((job) => this.runJob(job))
    for (const p of jobPromises) {
      this.inFlightJobs.add(p)
      p.finally(() => this.inFlightJobs.delete(p))
    }
    try {
      // -> `allSettled`, though `runJob` handles its own failures: one job that manages to throw
      //    anyway must not abandon the bookkeeping of the others
      await Promise.allSettled(jobPromises)
    } finally {
      this.activeWorkers -= jobs.length
    }
  },
  /**
   * Run an in-process task (`tasks/simple/`) against the same `taskTimeout` ceiling
   * `executeOnWorker` already gives a worker-thread job.
   *
   * Unlike a worker thread, an in-process task cannot actually be aborted — there is no separate
   * thread to tear down, and the task's own promise keeps running (and, eventually, settling) in the
   * background whether or not anything is still awaiting it. What this bounds is the scheduler's own
   * bookkeeping: without a ceiling here, a task that never settles (the documented case is
   * `withAdvisoryLock` blocking forever on an unavailable lock, before this same audit gave it its own
   * `lock_timeout`) means `processJob`'s `Promise.allSettled` never settles for it either, so the
   * `activeWorkers` slots it holds are never returned — 18 of this codebase's 19 task modules run this
   * way, so one wedged task permanently costs `maxWorkers` slots (default 3), and the instance stops
   * claiming new jobs at all. Racing the call against a timer here is what makes that finite: the job
   * is recorded failed and retried with the usual backoff, exactly as a thrown task already is,
   * through the shared `helpers/timeout.ts#withTimeout` every other bounded step in the repo uses.
   *
   * The task itself runs inside `runWithJobExecutionContext()` (OpenProject #2351): since it cannot
   * actually be cancelled, a task that calls `WIKI.models.jobs.setResult(jobId, ...)` after this
   * ceiling has already given up on it does so from a "stale" continuation that outlives this call.
   * The context carries the attempt number this specific claim is running as, so that late write can
   * be fenced against a later retry's result -- see `helpers/jobExecutionContext.ts` for the full
   * reasoning.
   */
  async executeInProcess(job: {
    task: string
    payload?: any
    id?: string
    retries?: number
  }): Promise<void> {
    const timeoutMs = (WIKI.config.scheduler.taskTimeout ?? DEFAULT_TASK_TIMEOUT) * 1000
    const runTask = () => this.tasks![job.task](job.payload, job.id)
    // -> `Promise.resolve`, since a task may be written as a synchronous function: `Promise.race`
    //    accepted a bare value, `withTimeout` takes a promise
    await withTimeout(
      Promise.resolve(
        job.id
          ? runWithJobExecutionContext({ jobId: job.id, attempt: (job.retries ?? 0) + 1 }, runTask)
          : runTask()
      ),
      timeoutMs,
      () =>
        new Error(
          `Task ${job.task} did not complete within ${timeoutMs / 1000}s and was abandoned.`
        )
    )
  },
  /**
   * Run one already-claimed job and record how it went.
   *
   * Runs outside any transaction, so every write here is on its own — which is also why a failure
   * cannot undo the ones before it. A job that fails is recorded as failed and requeued with the
   * scheduler's backoff, and its siblings in the batch are unaffected either way.
   */
  async runJob(job: any): Promise<void> {
    const attempt = job.retries + 1
    const startedAt = Date.now()
    WIKI.logger.debug('jobs', `${job.task} started`, { job: job.id, attempt })
    try {
      if (job.useWorker) {
        await this.executeOnWorker(job)
      } else {
        await this.executeInProcess(job)
      }
      await WIKI.db
        .update(jobHistoryTable)
        .set({
          state: 'completed',
          completedAt: sql`now()`
        })
        .where(eq(jobHistoryTable.id, job.id))
      WIKI.logger.debug('jobs', `${job.task} finished`, {
        job: job.id,
        attempt,
        ms: Date.now() - startedAt
      })
      notifyJobCompleted(job.id, 'success')
    } catch (err: any) {
      // -> Only the terminal, retries-exhausted branch logs at `error`. A job that will still be
      //    retried logs at `warn` — an operator shipping only `error` to alerting must see a storm
      //    of failing-and-retrying jobs, not just the final give-up.
      // -> One record, not two: the situation is the message and the error rides `fields.error`, so
      //    the renderer puts the message inline and the stack under it rather than emitting a
      //    second, contextless line. `job`/`attempt` (OpenProject #1937) keep it traceable without
      //    cross-referencing `jobHistory` by timestamp; `attempt` is the one about to be recorded
      //    below (`job.retries + 1`), not `job.retries` itself.
      const retriesExhausted = job.retries >= job.maxRetries
      const failureLog = retriesExhausted ? WIKI.logger.error : WIKI.logger.warn
      failureLog(
        'jobs',
        `${job.task} failed${retriesExhausted ? ', no attempts left' : ', will retry'}`,
        { job: job.id, attempt, ms: Date.now() - startedAt, error: err }
      )
      try {
        await WIKI.db
          .update(jobHistoryTable)
          .set({
            attempt: job.retries + 1,
            state: 'failed',
            lastErrorMessage: err.message
          })
          .where(eq(jobHistoryTable.id, job.id))
        notifyJobCompleted(job.id, 'failed', err.message)
        // -> Reschedule for retry
        if (job.retries < job.maxRetries) {
          const backoffDelay = 2 ** job.retries * WIKI.config.scheduler.retryBackoff
          await WIKI.db.insert(jobsTable).values({
            ...job,
            retries: job.retries + 1,
            waitUntil: new Date(
              Temporal.Now.instant().add({ seconds: backoffDelay }).epochMilliseconds
            ),
            updatedAt: new Date()
          })
        }
      } catch (recordErr: any) {
        // -> The task's failure is already logged; this is the database refusing to hear about it,
        //    which leaves the job looking active until `reapStaleJobs` picks it up
        WIKI.logger.warn('jobs', 'failed to record job failure', {
          job: job.id,
          task: job.task,
          error: recordErr
        })
      }
    }
  },
  /**
   * Requeue jobs that were claimed and never finished.
   *
   * A job is claimed out of `jobs` and marked `active` in the history before it runs, so an instance
   * that dies mid-job — or a worker that takes its answer with it — leaves a row saying a job started
   * that nothing is going to finish. Nothing else notices those: they are no longer in the queue.
   *
   * Age is the only usable signal. `INSTANCE_ID` is a fresh nanoid on every boot, so an instance
   * cannot pick out the rows of its own previous life, and another instance's `active` row may well
   * be a job that is running perfectly happily. `staleJobTimeout` is therefore a "nobody could still
   * be working on this" threshold rather than a deadline — generous on purpose, because the cost of
   * setting it too low is running a job that was already running.
   *
   * The `UPDATE` is the claim: two instances sweeping at once both filter on `state = 'active'`, so
   * whichever commits second matches nothing and returns nothing.
   *
   * A job that gets requeued below is not abandoned — `runJob` sends its own `jobCompleted` NOTIFY
   * once the requeued attempt actually finishes, resolving whichever `addJob({ promise: true })`
   * deferred is still waiting on that (unchanged) job id the ordinary way. A job that is skipped
   * instead (its attempts are used up) has no such future: nothing is ever going to run it again, so
   * this is the only place anything will ever report on it, and OpenProject #928 has this send the
   * `jobCompleted` failure NOTIFY itself rather than leaving that job's deferred to time out on its own
   * `expireCompletionPromises()` ceiling.
   *
   * @returns How many jobs were requeued
   */
  async reapStaleJobs(): Promise<number> {
    const staleAfter = WIKI.config.scheduler.staleJobTimeout ?? DEFAULT_STALE_JOB_TIMEOUT
    const cutoff = new Date(
      Temporal.Now.instant().subtract({ seconds: staleAfter }).epochMilliseconds
    )

    let stranded: Awaited<ReturnType<typeof claimStrandedJobs>>
    try {
      stranded = await claimStrandedJobs(cutoff, staleAfter)
    } catch (err: any) {
      WIKI.logger.warn('jobs', 'failed to requeue interrupted jobs', { error: err })
      return 0
    }

    let requeued = 0
    for (const job of stranded) {
      try {
        // -> Its remaining attempts are what they were: being interrupted is a failed attempt, and a
        //    job that had already used them up is not owed another one
        if (job.attempt > job.maxRetries) {
          WIKI.logger.warn('jobs', `${job.task} was interrupted with no attempts left`, {
            job: job.id,
            attempt: job.attempt
          })
          notifyJobCompleted(job.id, 'failed', job.lastErrorMessage)
          continue
        }
        // -> `.onConflictDoNothing` makes this a no-op, not a duplicate-key throw, when the original
        //    runner's own retry insert (`runJob`'s own `...job` spread, which reuses the same id)
        //    already beat this sweep to the punch — a live race, not a hypothetical one. `.returning()`
        //    is what lets `requeued` below count rows actually inserted rather than rows merely
        //    attempted. Wrapped in this per-job try/catch, not left to the removed outer one: the
        //    previous shape aborted the whole loop on the first failing insert, silently leaving every
        //    remaining stranded job in this batch `interrupted` in history with nothing back in the
        //    queue — permanently dropped, since a later sweep filters on `state = 'active'` and will
        //    never see an `interrupted` row again.
        const inserted = await WIKI.db
          .insert(jobsTable)
          .values({
            id: job.id,
            task: job.task,
            useWorker: job.useWorker,
            payload: job.payload,
            retries: job.attempt,
            maxRetries: job.maxRetries,
            isScheduled: job.wasScheduled,
            // -> Explicit, not left null: this job already passed whatever `waitUntil` it had before it
            //    was claimed and interrupted, so it is due again right now regardless. Leaving it null
            //    would still make `processJob`'s claim query pick it up immediately too (its `WHERE`
            //    treats null the same as "already due") — but a *scheduled* row with a null `waitUntil`
            //    crashes `addScheduled()`'s dedupe check the next time it runs (`j.waitUntil.getTime()`
            //    on `null`), silently pausing cron seeding for this task until this row is claimed
            //    (OpenProject #929). Setting a real timestamp here keeps every row `isScheduled = true`
            //    ever produces satisfying that invariant, rather than defending against `null` at every
            //    site that reads it.
            waitUntil: new Date(),
            createdBy: WIKI.INSTANCE_ID
          })
          .onConflictDoNothing({ target: jobsTable.id })
          .returning()
        requeued += inserted.length
      } catch (err: any) {
        // -> One job's requeue failing must not strand every job after it in this array: each still
        //    has its own `jobHistory` row marked `interrupted`, and without a per-job catch here, a
        //    single insert failure aborted the whole loop and left the rest permanently unrequeued —
        //    a later sweep only ever looks at `state = 'active'` rows, so it never revisits them.
        WIKI.logger.warn('jobs', 'failed to requeue job', {
          job: job.id,
          task: job.task,
          error: err
        })
      }
    }

    // -> `notifier.send` above is deliberately fire-and-forget (see helpers/pubsub.ts) so this
    //    function can call it from inside a loop with no `await` per iteration. Without draining once
    //    before returning, an early caller could observe `reapStaleJobs()` as "done" while an
    //    abandoned job's `jobCompleted` NOTIFY is still queued behind the connection — precisely the
    //    drop the comment atop this function says this branch exists to avoid.
    await notifier.drained()

    if (stranded.length > 0) {
      WIKI.logger.warn('jobs', 'requeued interrupted jobs', {
        found: stranded.length,
        requeued
      })
    }
    return requeued
  },
  /**
   * @returns How many future planned jobs this pass actually queued (0 when another instance held
   *   the cron lock, or when every planned iteration was already scheduled).
   */
  async addScheduled(): Promise<number> {
    let totalAdded = 0
    try {
      await WIKI.db.transaction(async (trx: any) => {
        // -> Acquire lock
        const jobLock = await trx
          .update(jobLockTable)
          .set({
            lastCheckedBy: WIKI.INSTANCE_ID,
            lastCheckedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })
          })
          .where(
            eq(
              jobLockTable.key,
              sql`(SELECT "jobLock"."key" FROM "jobLock" WHERE "jobLock"."key" = 'cron' AND "jobLock"."lastCheckedAt" <= ${Temporal.Now.instant().subtract({ minutes: 5 }).toString({ smallestUnit: 'millisecond' })} FOR UPDATE SKIP LOCKED LIMIT 1)`
            )
          )

        if (jobLock.rowCount > 0) {
          // -> Both selects read through `trx`, the same physical connection the lock UPDATE just
          //    took, rather than the ambient `WIKI.db` pool handle. Under READ COMMITTED this does not
          //    change what rows are visible (a `trx.select()` after the lock UPDATE sees exactly the
          //    same committed rows a pool read would), but it does stop every scheduled task's inserts
          //    from checking out a *second* pool connection while this one is still held open by the
          //    transaction.
          const scheduledJobs = await trx.select().from(jobScheduleTable)
          if (scheduledJobs?.length > 0) {
            // -> Get existing scheduled jobs
            const existingJobs = await trx
              .select()
              .from(jobsTable)
              .where(eq(jobsTable.isScheduled, true))
            for (const job of scheduledJobs) {
              // -> Get next planned iterations
              const plannedIterations = CronExpressionParser.parse(job.cron, {
                startDate: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
                // -> 24 hours rather than `{ days: 1 }`: Temporal.Instant only accepts exact time
                //    units, and in UTC a calendar day is exactly 24 hours anyway.
                endDate: Temporal.Now.instant()
                  .add({ hours: 24, minutes: 5 })
                  .toString({ smallestUnit: 'millisecond' }),
                tz: 'UTC'
              })
              // -> Add a maximum of 10 future iterations for a single task
              let addedFutureJobs = 0
              while (plannedIterations.hasNext()) {
                try {
                  const next = plannedIterations.next()
                  // -> Ensure this iteration isn't already scheduled. `j.waitUntil &&` guards against
                  //    a scheduled row with a null `waitUntil` — `reapStaleJobs` no longer produces
                  //    one (OpenProject #929), but a null here must never crash this loop (silently
                  //    pausing cron seeding for every task after it) regardless of how it got there:
                  //    at worst, treating it as "not a match" schedules one harmless extra occurrence
                  //    instead.
                  if (
                    !existingJobs.some(
                      (j: any) =>
                        j.task === job.task &&
                        j.waitUntil &&
                        j.waitUntil.getTime() === next.getTime()
                    )
                  ) {
                    // -> `addJob` swallows its own errors and returns `undefined` on failure (logging
                    //    its own warning), so awaiting it here and only counting a returned `id` is
                    //    what keeps this loop's "N scheduled" log reporting actual outcomes rather than
                    //    intent (OpenProject #1998) -- an insert that never lands must not be counted.
                    const added = await this.addJob({
                      task: job.task,
                      payload: job.payload,
                      isScheduled: true,
                      waitUntil: new Date(next.getTime()),
                      notify: false
                    })
                    if (added?.id) {
                      addedFutureJobs++
                      totalAdded++
                    }
                  }
                  // -> No more iterations for this period or max iterations count reached
                  if (!plannedIterations.hasNext() || addedFutureJobs >= 10) {
                    break
                  }
                } catch {
                  break
                }
              }
            }
            WIKI.logger.debug('jobs', 'planned jobs reconciled', { added: totalAdded })
          }
        }
      })
    } catch (err: any) {
      WIKI.logger.warn('jobs', 'failed to schedule future planned jobs', { error: err })
    }
    return totalAdded
  },
  /**
   * Stop the scheduler.
   *
   * Clears both intervals first, so no new job is claimed once shutdown begins, then waits for
   * whatever `processJob()` batches are already in flight (bounded, so one hung task cannot hold this
   * open indefinitely — see `drainInFlightJobs()`) before destroying the worker pool out from under
   * whatever is still running. A batch still going at the bound is abandoned exactly as before this
   * drain existed: `workerPool.destroy()` tears it down, and its `jobHistory` row is picked up by
   * `reapStaleJobs()` once `staleJobTimeout` elapses.
   *
   * Returns the same awaitable promise `backend/index.ts`'s `gracefulServer(...)` `closePromises`
   * holds (OpenProject #2028) — nothing further to wire up here, `stop()` was already awaitable.
   */
  async stop(): Promise<void> {
    clearInterval(this.scheduledRef!)
    clearInterval(this.pollingRef!)
    // -> Nulled synchronously, before anything below is awaited: no new job is claimed once shutdown
    //    begins (`processJob` is only ever called from this interval), and the drain below only has
    //    to deal with whatever was already in flight at this instant.
    this.scheduledRef = null
    this.pollingRef = null
    await this.drainInFlightJobs()
    await this.workerPool!.destroy()
    if (this.listenerHandle) {
      await notifier.drained()
      await this.listenerHandle.close()
      this.listenerHandle = null
    }
    // -> `debug`, not `info`: `core/http/server.ts`'s `boot stopping` / `boot stopped  ms=` pair is
    //    the shutdown narrative now, and this runs inside it as one of the graceful server's own
    //    `closePromises`. An operator wanting to see which teardown step is slow turns on `debug`.
    WIKI.logger.debug('jobs', 'scheduler stopped')
  },
  /**
   * Waits for whatever `processJob` currently has in flight, bounded so a hung task cannot hold
   * shutdown open indefinitely (OpenProject #2019).
   *
   * Called from `stop()` after `pollingRef` is already cleared, so `inFlightJobs` only shrinks from
   * here on — nothing new is added to it. A job's own promise is awaited (via `runJob`'s tracked
   * promise in `inFlightJobs`), not dropped; a job that never settles on its own is not waited on
   * past `taskTimeout + SHUTDOWN_DRAIN_GRACE`, after which `stop()` proceeds anyway and abandons it
   * the same way an unbounded wait would eventually have had to.
   */
  async drainInFlightJobs(): Promise<void> {
    if (this.inFlightJobs.size < 1) {
      return
    }
    const timeoutMs =
      (WIKI.config.scheduler.taskTimeout ?? DEFAULT_TASK_TIMEOUT) * 1000 + SHUTDOWN_DRAIN_GRACE
    // -> `debug jobs`, for the same reason as `scheduler stopped` above: the drain's cost is already
    //    reported by `boot stopped  ms=`, and this is the detail behind that number.
    WIKI.logger.debug('jobs', 'waiting for in-flight jobs', {
      jobs: this.inFlightJobs.size,
      timeout: timeoutMs
    })
    // -> The bound expiring is this function doing its job, not a failure, so the rejection
    //    `withTimeout` signals it with is swallowed here — `Promise.allSettled` itself never rejects,
    //    so nothing else can reach this `catch`. `unref`, since this runs while the process is
    //    already trying to exit and the ceiling must not by itself keep it alive.
    await withTimeout(
      Promise.allSettled(Array.from(this.inFlightJobs)),
      timeoutMs,
      () => new Error('Timed out waiting for in-flight jobs to finish.'),
      { unref: true }
    ).catch(() => [])
  }
}
