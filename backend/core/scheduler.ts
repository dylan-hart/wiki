import { Piscina } from 'piscina'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Cron } from 'croner'
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
 * `summary` is the sentence the scheduler logs at `info` in place of its own `<task> finished` —
 * lowercase, no trailing period — and every other property rides that line as a field. A task with
 * nothing worth reporting returns nothing and its run stays at `debug`.
 *
 * Never written to `jobHistory.result`: that column is a task's own channel to a follow-up route,
 * written through `CARDINAL.models.jobs.setResult()`, and a summary landing on it would break its
 * readers.
 */
export interface TaskResult {
  summary: string
  [field: string]: unknown
}

/**
 * An in-process task, loaded from `tasks/simple/`. `jobId` is its own `jobHistory` row, for a task
 * that hands a result to a follow-up route through `CARDINAL.models.jobs.setResult(jobId, ...)`. A
 * task returns a `TaskResult` rather than logging its own counts: `runJob()` logs the outcome once.
 */
export type SimpleTask = (
  payload?: any,
  jobId?: string
) => Promise<TaskResult | void> | TaskResult | void

/**
 * Always `null` for a worker-thread job: `worker.ts`'s handler resolves `true`, not the task's own
 * return value.
 */
function taskSummary(value: unknown): TaskResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const summary = (value as { summary?: unknown }).summary
  return typeof summary === 'string' && summary.length > 0 ? (value as TaskResult) : null
}

/** In seconds. */
const DEFAULT_TASK_TIMEOUT = 300

/** In seconds. */
const DEFAULT_STALE_JOB_TIMEOUT = 3600

/**
 * How long piscina keeps an idle thread above `minThreads` warm. Not a `scheduler.*` config key: it
 * only trades a little idle memory against a cold thread spin-up on the next burst of jobs.
 */
const WORKER_IDLE_TIMEOUT_MS = 60_000

/**
 * An `addJob({ promise: true })` deferred gives up after this many `staleJobTimeout`s. More than
 * one, so a promise whose job went stale and was requeued by `reapStaleJobs` is still alive to see
 * the requeued attempt finish.
 */
const COMPLETION_PROMISE_TTL_MULTIPLIER = 2

/**
 * How much longer than the task timeout, in ms, the scheduler waits before giving up on its own.
 * The pool aborting a slow task is the better answer; this lets it arrive first, and only covers a
 * worker that never answers at all.
 */
const TASK_TIMEOUT_GRACE = 5000

/**
 * Extra time, in ms, `stop()`'s drain waits on top of `taskTimeout`. Shorter than
 * `TASK_TIMEOUT_GRACE`: every in-flight job has its own `taskTimeout` ceiling and a head start on
 * the drain.
 */
const SHUTDOWN_DRAIN_GRACE = 1000

/**
 * Sends are fire-and-forget: a job being added or finishing must not wait on a round trip.
 * Serialized because `processJob` runs concurrently with itself, so two notifications easily meet
 * on the one client.
 */
const notifier = createNotifier(() => CARDINAL.scheduler.pubsubClient, 'scheduler')

/**
 * Tells every instance a job finished, which is what settles an `addJob({ promise: true })` caller
 * whichever instance ran it. One function so every sender writes the same envelope the
 * `jobCompleted` listener matches on.
 */
function notifyJobCompleted(
  id: string,
  state: 'success' | 'failed',
  errorMessage?: string | null
): void {
  notifier.send(
    'scheduler',
    JSON.stringify({
      source: CARDINAL.INSTANCE_ID,
      event: 'jobCompleted',
      state,
      id,
      ...(errorMessage !== undefined && { errorMessage })
    })
  )
}

interface CompletionPromise {
  id: string
  added: Temporal.Instant
  promise: Deferred['promise']
  resolve: Deferred['resolve']
  reject: Deferred['reject']
}

export interface AddJobOptions {
  task: string
  payload?: any
  waitUntil?: Date
  maxRetries?: number
  isScheduled?: boolean
  /** Tell every instance that a new job is available. */
  notify?: boolean
  /** Also return a `promise` that settles when the job completes. */
  promise?: boolean
}

/**
 * Split out of `reapStaleJobs()` only so its return type can be named. The `UPDATE ... RETURNING`
 * is the claim: two instances sweeping at once both filter on `state = 'active'`, so whichever
 * commits second matches nothing.
 */
function claimStrandedJobs(cutoff: Date, staleAfter: number) {
  return CARDINAL.db
    .update(jobHistoryTable)
    .set({
      state: 'interrupted',
      lastErrorMessage: `No instance reported on this job within ${staleAfter}s. Whatever was running it is gone.`
    })
    .where(and(eq(jobHistoryTable.state, 'active'), lt(jobHistoryTable.startedAt, cutoff)))
    .returning()
}

export default {
  workerPool: null as Piscina<any, boolean> | null,
  pubsubClient: null as PoolClient | null,
  listenerHandle: null as ListenerHandle | null,
  maxWorkers: 1,
  activeWorkers: 0,
  stopping: false,
  pollingRef: null as NodeJS.Timeout | null,
  scheduledRef: null as NodeJS.Timeout | null,
  tasks: null as Record<string, SimpleTask> | null,
  completionPromises: [] as CompletionPromise[],
  /** `runJob` promises `processJob` currently has in flight, so `stop()` can drain them. */
  inFlightJobs: new Set<Promise<void>>(),
  async init() {
    this.maxWorkers =
      CARDINAL.config.scheduler.workers === 'auto'
        ? os.cpus().length - 1
        : CARDINAL.config.scheduler.workers
    if (this.maxWorkers < 1) {
      this.maxWorkers = 1
    }
    const workerFile = path.join(CARDINAL.SERVERPATH, 'worker.ts')
    this.workerPool = new Piscina({
      filename: workerFile,
      minThreads: 1,
      maxThreads: this.maxWorkers,
      idleTimeout: WORKER_IDLE_TIMEOUT_MS,
      // -> Forwarded to every worker thread as its `workerData`: `worker.ts` builds its
      //    `INSTANCE_ID` from `parentInstanceId` before its logger exists, and takes `capabilities`
      //    from here because a worker thread never calls `syncSchemas()` to learn it.
      workerData: { parentInstanceId: CARDINAL.INSTANCE_ID, capabilities: CARDINAL.capabilities }
    })
    this.workerPool.on('error', (err: Error) =>
      CARDINAL.logger.warn('worker', 'worker pool error', { error: err })
    )
    this.workerPool.on('workerDestroy', () => CARDINAL.logger.debug('worker', 'worker offline'))
    this.workerPool.on('workerCreate', () => CARDINAL.logger.debug('worker', 'worker online'))
    this.tasks = {}
    for (const f of await fs.readdir(path.join(CARDINAL.SERVERPATH, 'tasks/simple'))) {
      // -> Skips the co-located `*.test.ts` files, which the `import()` below would otherwise run
      //    as `node:test` suites on every boot: the pattern allows no dot before the extension.
      if (!/^[^.]+\.[jt]s$/.test(f)) {
        continue
      }
      const taskName = camelCase(f.replace(/\.[jt]s$/, ''))
      // -> A `file://` URL, not the plain path piscina takes for `workerFile`: `import()` parses
      //    its argument as a module specifier, so a Windows `C:\...` has its drive letter read as a
      //    URL scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
      this.tasks[taskName] = (
        await import(pathToFileURL(path.join(CARDINAL.SERVERPATH, 'tasks/simple', f)).href)
      ).task
    }
    return this
  },
  async start(): Promise<void> {
    this.stopping = false
    const connectionAppName = `Cardinal.js - ${CARDINAL.INSTANCE_ID}:SCHEDULER`

    this.listenerHandle = await connectListener({
      pool: CARDINAL.dbManager.listenerPool!,
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

    this.scheduledRef = setInterval(async () => {
      this.addScheduled()
      this.reapStaleJobs()
      this.expireCompletionPromises()
    }, CARDINAL.config.scheduler.scheduledCheck * 1000)

    const planned = await this.addScheduled()

    await this.reapStaleJobs()

    this.pollingRef = setInterval(async () => {
      this.processJob()
    }, CARDINAL.config.scheduler.pollingCheck * 1000)

    CARDINAL.logger.info('jobs', 'scheduler started', { workers: this.maxWorkers, planned })
  },
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
      await CARDINAL.db.insert(jobsTable).values({
        id: jobId,
        task,
        useWorker: !(typeof this.tasks![task] === 'function'),
        payload,
        maxRetries: maxRetries ?? CARDINAL.config.scheduler.maxRetries,
        isScheduled,
        waitUntil,
        createdBy: CARDINAL.INSTANCE_ID
      })
      // -> Registered only after the insert succeeds: a failed insert must not leave a deferred
      //    tracked that no caller ever received.
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
            source: CARDINAL.INSTANCE_ID,
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
      CARDINAL.logger.warn('jobs', 'failed to queue job', { task, error: err })
    }
  },
  /**
   * Reject, and stop tracking, any `addJob({ promise: true })` deferred that has waited past its
   * ceiling. A `jobCompleted` NOTIFY is the only other thing that settles one, and NOTIFY is not
   * durable: one missed during a LISTEN reconnect would leave the deferred pending, and its entry
   * tracked, for the life of the process.
   */
  expireCompletionPromises(): void {
    const ttlSeconds =
      (CARDINAL.config.scheduler.staleJobTimeout ?? DEFAULT_STALE_JOB_TIMEOUT) *
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
   * Run a job in a worker thread, under two ceilings that cover different failures. The abort
   * signal is for a task that is merely slow: the pool tears down the worker running it and
   * rejects. The timer is for a thread that neither answers nor exits (piscina itself rejects a
   * task whose thread exits), which would otherwise hold its `activeWorkers` slot forever. Either
   * way the job fails and is retried like a thrown task.
   */
  async executeOnWorker(job: { task: string; payload?: any }): Promise<void> {
    const timeoutMs = (CARDINAL.config.scheduler.taskTimeout ?? DEFAULT_TASK_TIMEOUT) * 1000
    await withTimeout(
      this.workerPool!.run({ ...job }, { signal: AbortSignal.timeout(timeoutMs) }),
      timeoutMs + TASK_TIMEOUT_GRACE,
      () =>
        new Error(
          `The worker running this task did not answer within ${timeoutMs / 1000}s. It may have crashed.`
        )
    )
  },

  /**
   * Take a batch of due jobs and run them, in two steps rather than one transaction. The claim has
   * to be atomic — the `DELETE` with `SKIP LOCKED` is what stops two instances running the same
   * job, and the history row saying it started belongs with it. Running it must not be: a
   * transaction held open across a task pins a pooled connection, holds the claim's locks, and
   * stops postgres vacuuming anything newer than its snapshot.
   *
   * The cost is that a process dying mid-job leaves the job out of the queue with an `active`
   * history row, which is what `reapStaleJobs` is for.
   */
  async processJob(): Promise<void> {
    if (this.stopping) {
      return
    }
    const claiming = this.claimAndRun()
    this.inFlightJobs.add(claiming)
    claiming.finally(() => this.inFlightJobs.delete(claiming))
    return claiming
  },
  async claimAndRun(): Promise<void> {
    // -> Reserved synchronously, before the first `await`: `processJob` has two overlapping callers
    //    (the polling interval and the `newJob` handler) and the claim is several round trips long,
    //    so a check-then-act read of `activeWorkers` would not bind concurrency to `maxWorkers`.
    //    Corrected below once the claim reports how many rows it got.
    const availableWorkers = this.maxWorkers - this.activeWorkers
    if (availableWorkers < 1) {
      CARDINAL.logger.debug('jobs', 'all workers busy, nothing claimed', {
        workers: this.maxWorkers
      })
      return
    }
    this.activeWorkers += availableWorkers

    let jobs: any[] = []
    try {
      jobs = await CARDINAL.db.transaction(async (trx: any) => {
        const claimed = await trx
          .delete(jobsTable)
          .where(
            inArray(
              jobsTable.id,
              // -> Ordered by due time then age, matching `models/jobs.ts#getUpcoming()`. `id` is a
              //    random UUID: ordering by it would pass over eligible jobs arbitrarily and
              //    discard the urgency `reapStaleJobs` sets on a requeued row.
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
              executedBy: CARDINAL.INSTANCE_ID,
              createdAt: job.createdAt
            })
            .onConflictDoUpdate({
              target: jobHistoryTable.id,
              // -> A reclaim must refresh `attempt` too: otherwise a job whose runner keeps dying
              //    before `runJob` records anything keeps its first `attempt` forever,
              //    `reapStaleJobs`'s `attempt > maxRetries` cutoff never trips, and the job is
              //    requeued indefinitely.
              set: {
                state: 'active',
                executedBy: CARDINAL.INSTANCE_ID,
                startedAt: sql`now()`,
                attempt: job.retries + 1,
                // -> `jobHistory` holds one row per job across every attempt, so without this a job
                //    that was interrupted and then succeeded ends up `completed` while still
                //    carrying `reapStaleJobs`'s message.
                lastErrorMessage: null
              }
            })
        }
        return claimed
      })
    } catch (err: any) {
      // -> The transaction rolled back, so nothing was claimed: release the whole reservation
      this.activeWorkers -= availableWorkers
      CARDINAL.logger.warn('jobs', 'failed to claim jobs', { error: err })
      return
    }

    // -> Release the part of the reservation the claim did not fill
    this.activeWorkers -= availableWorkers - jobs.length

    if (jobs.length < 1) {
      return
    }

    // -> Added to `inFlightJobs` before the first `await` below, so a `stop()` racing this call
    //    sees the full batch. `activeWorkers` already counts this batch, through the reservation
    //    above.
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
   * Run an in-process task (`tasks/simple/`) under the same `taskTimeout` ceiling a worker job has.
   *
   * The task cannot actually be aborted: its promise keeps running whether or not anything still
   * awaits it. What the ceiling bounds is the scheduler's bookkeeping — a task that never settles
   * would otherwise never return its `activeWorkers` slot, and enough of them stop the instance
   * claiming jobs at all.
   *
   * For the same reason it runs inside `runWithJobExecutionContext()`: the context carries this
   * claim's attempt number, so a `setResult()` from a continuation that outlived the ceiling can be
   * fenced against a later retry's result (see `helpers/jobExecutionContext.ts`).
   */
  async executeInProcess(job: {
    task: string
    payload?: any
    id?: string
    retries?: number
  }): Promise<TaskResult | void> {
    const timeoutMs = (CARDINAL.config.scheduler.taskTimeout ?? DEFAULT_TASK_TIMEOUT) * 1000
    const runTask = () => this.tasks![job.task](job.payload, job.id)
    // -> `Promise.resolve`, since a task may be a synchronous function and `withTimeout` takes a
    //    promise
    return await withTimeout(
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
   * Run one already-claimed job and record how it went. Outside any transaction, so each write here
   * stands alone and a later failure cannot undo an earlier one.
   */
  async runJob(job: any): Promise<void> {
    const attempt = job.retries + 1
    // -> `maxRetries` counts the retries, so the first run is the extra one
    const attempts = job.maxRetries + 1
    const startedAt = Date.now()
    CARDINAL.logger.debug('jobs', `${job.task} started`, {
      job: job.id,
      attempt: `${attempt}/${attempts}`
    })
    try {
      const outcome = job.useWorker
        ? await this.executeOnWorker(job)
        : await this.executeInProcess(job)
      await CARDINAL.db
        .update(jobHistoryTable)
        .set({
          state: 'completed',
          completedAt: sql`now()`
        })
        .where(eq(jobHistoryTable.id, job.id))
      const summary = taskSummary(outcome)
      if (summary) {
        const { summary: sentence, ...summaryFields } = summary
        CARDINAL.logger.info('jobs', `${job.task} ${sentence}`, {
          job: job.id,
          attempt: `${attempt}/${attempts}`,
          ...summaryFields,
          ms: Date.now() - startedAt
        })
      } else {
        CARDINAL.logger.debug('jobs', `${job.task} finished`, {
          job: job.id,
          attempt: `${attempt}/${attempts}`,
          ms: Date.now() - startedAt
        })
      }
      notifyJobCompleted(job.id, 'success')
    } catch (err: any) {
      // -> The two branches count differently on purpose: a retrying job says `attempt=n/m`, an
      //    exhausted one `attempts=m`, since there is no next attempt for a ratio to count towards.
      // -> `nextRun` is computed once and reused by the requeue insert below, so the logged `next`
      //    is the row's real `waitUntil`.
      const retriesExhausted = job.retries >= job.maxRetries
      const nextRun = retriesExhausted
        ? null
        : Temporal.Now.instant().add({
            seconds: 2 ** job.retries * CARDINAL.config.scheduler.retryBackoff
          })
      if (retriesExhausted) {
        CARDINAL.logger.error('jobs', `${job.task} failed, no attempts left`, {
          job: job.id,
          attempts,
          ms: Date.now() - startedAt,
          error: err
        })
      } else {
        CARDINAL.logger.warn('jobs', `${job.task} failed, retrying`, {
          job: job.id,
          attempt: `${attempt}/${attempts}`,
          next: nextRun!.toString({ smallestUnit: 'millisecond' }),
          ms: Date.now() - startedAt,
          error: err
        })
      }
      try {
        await CARDINAL.db
          .update(jobHistoryTable)
          .set({
            attempt: job.retries + 1,
            state: 'failed',
            lastErrorMessage: err.message
          })
          .where(eq(jobHistoryTable.id, job.id))
        notifyJobCompleted(job.id, 'failed', err.message)
        if (nextRun) {
          await CARDINAL.db.insert(jobsTable).values({
            ...job,
            retries: job.retries + 1,
            waitUntil: new Date(nextRun.epochMilliseconds),
            updatedAt: new Date()
          })
        }
      } catch (recordErr: any) {
        // -> The task's failure is already logged; this is the database refusing to hear about it,
        //    which leaves the job looking active until `reapStaleJobs` picks it up
        CARDINAL.logger.warn('jobs', 'failed to record job failure', {
          job: job.id,
          task: job.task,
          error: recordErr
        })
      }
    }
  },
  /**
   * Requeue jobs that were claimed and never finished: an instance that dies mid-job leaves an
   * `active` history row for a job no longer in the queue, which nothing else notices.
   *
   * Age is the only usable signal. `INSTANCE_ID` is random per boot, so an instance cannot pick out
   * the rows of its previous life, and another instance's `active` row may be running happily.
   * `staleJobTimeout` is therefore a "nobody could still be working on this" threshold, generous on
   * purpose: set too low, it runs a job that is already running.
   *
   * A job with no attempts left is never run again, so this sends its `jobCompleted` failure itself
   * rather than leaving an `addJob({ promise: true })` caller to time out.
   */
  async reapStaleJobs(): Promise<number> {
    const staleAfter = CARDINAL.config.scheduler.staleJobTimeout ?? DEFAULT_STALE_JOB_TIMEOUT
    const cutoff = new Date(
      Temporal.Now.instant().subtract({ seconds: staleAfter }).epochMilliseconds
    )

    let stranded: Awaited<ReturnType<typeof claimStrandedJobs>>
    try {
      stranded = await claimStrandedJobs(cutoff, staleAfter)
    } catch (err: any) {
      CARDINAL.logger.warn('jobs', 'failed to requeue interrupted jobs', { error: err })
      return 0
    }

    let requeued = 0
    for (const job of stranded) {
      try {
        // -> Its remaining attempts are what they were: being interrupted is a failed attempt, and a
        //    job that had already used them up is not owed another one
        if (job.attempt > job.maxRetries) {
          CARDINAL.logger.warn('jobs', `${job.task} interrupted, no attempts left`, {
            job: job.id,
            attempt: `${job.attempt}/${job.maxRetries + 1}`
          })
          notifyJobCompleted(job.id, 'failed', job.lastErrorMessage)
          continue
        }
        // -> `.onConflictDoNothing`: the original runner's own retry insert in `runJob` reuses the
        //    same id and may already have beaten this sweep to it. `.returning()` lets `requeued`
        //    count rows actually inserted.
        const inserted = await CARDINAL.db
          .insert(jobsTable)
          .values({
            id: job.id,
            task: job.task,
            useWorker: job.useWorker,
            payload: job.payload,
            retries: job.attempt,
            maxRetries: job.maxRetries,
            isScheduled: job.wasScheduled,
            // -> Explicit, though `processJob` would claim a null row just as soon: every
            //    `isScheduled` row is expected to carry a real `waitUntil`, which
            //    `addScheduled()`'s dedupe reads.
            waitUntil: new Date(),
            createdBy: CARDINAL.INSTANCE_ID
          })
          .onConflictDoNothing({ target: jobsTable.id })
          .returning()
        requeued += inserted.length
      } catch (err: any) {
        // -> Caught per job, not around the loop: every row here is already marked `interrupted`,
        //    which a later sweep (filtering on `state = 'active'`) never revisits, so one failed
        //    insert must not strand the jobs after it.
        CARDINAL.logger.warn('jobs', 'failed to requeue job', {
          job: job.id,
          task: job.task,
          error: err
        })
      }
    }

    // -> `notifier.send` is fire-and-forget, so drain once: an abandoned job's `jobCompleted`
    //    NOTIFY must be out before this reports done.
    await notifier.drained()

    if (stranded.length > 0) {
      CARDINAL.logger.warn('jobs', 'requeued interrupted jobs', {
        found: stranded.length,
        requeued
      })
    } else {
      CARDINAL.logger.debug('jobs', 'no interrupted jobs found')
    }
    return requeued
  },
  async addScheduled(): Promise<number> {
    let totalAdded = 0
    try {
      await CARDINAL.db.transaction(async (trx: any) => {
        // -> Acquire the cron lock, which also rate-limits seeding across instances
        const jobLock = await trx
          .update(jobLockTable)
          .set({
            lastCheckedBy: CARDINAL.INSTANCE_ID,
            lastCheckedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })
          })
          .where(
            eq(
              jobLockTable.key,
              sql`(SELECT "jobLock"."key" FROM "jobLock" WHERE "jobLock"."key" = 'cron' AND "jobLock"."lastCheckedAt" <= ${Temporal.Now.instant().subtract({ minutes: 5 }).toString({ smallestUnit: 'millisecond' })} FOR UPDATE SKIP LOCKED LIMIT 1)`
            )
          )

        if (jobLock.rowCount > 0) {
          // -> Both selects read through `trx`, the connection the lock already holds, rather than
          //    checking a second one out of the pool while this transaction is open.
          const scheduledJobs = await trx.select().from(jobScheduleTable)
          if (scheduledJobs?.length > 0) {
            const existingJobs = await trx
              .select()
              .from(jobsTable)
              .where(eq(jobsTable.isScheduled, true))
            for (const job of scheduledJobs) {
              // -> `croner` has no iterator: `nextRun(prev)` returns the next occurrence strictly
              //    after `prev`, or `null` once none remain before `stopAt`, which the loop below
              //    polls.
              const windowStart = Temporal.Now.instant().toString({ smallestUnit: 'millisecond' })
              // -> 24 hours, not `{ days: 1 }`: Temporal.Instant only accepts exact time units
              const windowEnd = Temporal.Now.instant()
                .add({ hours: 24, minutes: 5 })
                .toString({ smallestUnit: 'millisecond' })
              const plannedIterations = new Cron(job.cron, {
                timezone: 'UTC',
                paused: true,
                startAt: windowStart,
                stopAt: windowEnd
              })
              let addedFutureJobs = 0
              let cursor: Date | string = windowStart
              while (true) {
                try {
                  const next = plannedIterations.nextRun(cursor)
                  if (!next) {
                    break
                  }
                  cursor = next
                  // -> `j.waitUntil &&`: a null must not throw here, which would end this task's
                  //    seeding. Treating it as "no match" schedules one extra occurrence at worst.
                  if (
                    !existingJobs.some(
                      (j: any) =>
                        j.task === job.task &&
                        j.waitUntil &&
                        j.waitUntil.getTime() === next.getTime()
                    )
                  ) {
                    // -> `addJob` swallows its own errors and returns `undefined`, so only a
                    //    returned `id` counts as queued.
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
                  if (addedFutureJobs >= 10) {
                    break
                  }
                } catch {
                  break
                }
              }
            }
            CARDINAL.logger.debug('jobs', 'planned jobs reconciled', { added: totalAdded })
          }
        }
      })
    } catch (err: any) {
      CARDINAL.logger.warn('jobs', 'failed to schedule future planned jobs', { error: err })
    }
    return totalAdded
  },
  /**
   * Clears both intervals first, so polling claims nothing new, then waits (bounded) for the
   * batches already in flight before destroying the worker pool under them. A batch still running
   * at the bound is abandoned: its `jobHistory` row is picked up by `reapStaleJobs()` once
   * `staleJobTimeout` elapses.
   */
  async stop(): Promise<void> {
    this.stopping = true
    clearInterval(this.scheduledRef!)
    clearInterval(this.pollingRef!)
    this.scheduledRef = null
    this.pollingRef = null
    // FIXME: the `newJob` NOTIFY handler still calls `processJob()` until the listener closes
    // below, so a batch can be claimed mid-drain, missed by it, and lose its worker pool. Gate
    // `processJob` on a stopping flag.
    await this.drainInFlightJobs()
    await this.workerPool!.destroy()
    if (this.listenerHandle) {
      await notifier.drained()
      await this.listenerHandle.close()
      this.listenerHandle = null
    }
    // -> `debug`, not `info`: `core/http/server.ts` logs the shutdown itself, and this is one
    //    teardown step inside it.
    CARDINAL.logger.debug('jobs', 'scheduler stopped')
  },
  /**
   * Waits for whatever `processJob` has in flight, bounded by `taskTimeout + SHUTDOWN_DRAIN_GRACE`
   * so a hung task cannot hold shutdown open: past the bound `stop()` proceeds and abandons it.
   */
  async drainInFlightJobs(): Promise<void> {
    if (this.inFlightJobs.size < 1) {
      return
    }
    const timeoutMs =
      (CARDINAL.config.scheduler.taskTimeout ?? DEFAULT_TASK_TIMEOUT) * 1000 + SHUTDOWN_DRAIN_GRACE
    CARDINAL.logger.debug('jobs', 'waiting for in-flight jobs', {
      jobs: this.inFlightJobs.size,
      timeout: timeoutMs
    })
    // -> The bound expiring is this function doing its job, so `withTimeout`'s rejection is
    //    swallowed; `Promise.allSettled` never rejects, so nothing else reaches this `catch`.
    //    `unref`, since the process is already trying to exit and the ceiling must not keep it
    //    alive.
    await withTimeout(
      Promise.allSettled(Array.from(this.inFlightJobs)),
      timeoutMs,
      () => new Error('Timed out waiting for in-flight jobs to finish.'),
      { unref: true }
    ).catch(() => [])
  }
}
