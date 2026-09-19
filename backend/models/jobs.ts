import {
  jobs as jobsTable,
  jobSchedule as jobScheduleTable,
  jobLock as jobLockTable,
  jobHistory as jobHistoryTable
} from '../db/schema.ts'
import { and, count, desc, eq, inArray, lte, not, sql } from 'drizzle-orm'
import { getJobExecutionContext } from '../helpers/jobExecutionContext.ts'
import { paginate } from '../helpers/pagination.ts'

export const JOB_STATES = ['active', 'completed', 'failed', 'interrupted'] as const
export type JobState = (typeof JOB_STATES)[number]

export interface JobHistoryPage {
  total: number
  jobs: (typeof jobHistoryTable.$inferSelect)[]
}

/**
 * What `init()` seeds `jobSchedule` with. Exported rather than inlined there so it can be asserted
 * on without a database. No two entries may share a cron expression: entries on the same cron are
 * claimed as one `processJob` batch, where one task's config write can race another's read.
 */
export const JOB_SCHEDULE_SEED = [
  {
    task: 'checkVersion',
    cron: '0 0 * * *',
    type: 'system'
  },
  {
    task: 'cleanJobHistory',
    cron: '5 0 * * *',
    type: 'system'
  },
  {
    task: 'purgeRateLimits',
    cron: '10 * * * *',
    type: 'system'
  },
  // -> Hourly like `purgeRateLimits` above (both SELECTed on every authenticated request, both
  //    unbounded), offset to a different minute so the two don't compete on the same tick.
  {
    task: 'purgeSessions',
    cron: '40 * * * *',
    type: 'system'
  },
  {
    task: 'purgeExports',
    cron: '15 0 * * *',
    type: 'system'
  },
  {
    task: 'purgeImports',
    cron: '20 0 * * *',
    type: 'system'
  },
  {
    task: 'purgePageviews',
    cron: '25 0 * * *',
    type: 'system'
  },
  // -> Must stay off `checkVersion`'s minute: both write `CARDINAL.config.update`, and co-scheduling
  //    them races this task's read of `update.locales` against `checkVersion`'s write.
  {
    task: 'updateLocales',
    cron: '30 0 * * *',
    type: 'system'
  },
  {
    task: 'cleanAuditLog',
    cron: '35 0 * * *',
    type: 'system'
  },
  {
    task: 'purgeContentSyncState',
    cron: '40 0 * * *',
    type: 'system'
  },
  {
    task: 'purgeUserKeys',
    cron: '45 0 * * *',
    type: 'system'
  },
  {
    task: 'purgeGuestPii',
    cron: '55 0 * * *',
    type: 'system'
  },
  // -> Every minute because the comparison against each storage target's own sync interval happens
  //    inside the task, not here.
  {
    task: 'storageSyncTick',
    cron: '* * * * *',
    type: 'system'
  },
  {
    task: 'storageDailyBackup',
    cron: '30 2 * * *',
    type: 'system'
  },
  // -> A digest is a reader-facing send, so it goes out when someone is plausibly about to check
  //    mail rather than in the middle of the night.
  {
    task: 'sendWatchDigests',
    cron: '0 8 * * *',
    type: 'system'
  },
  {
    task: 'purgePageWatchEvents',
    cron: '50 0 * * *',
    type: 'system'
  },
  {
    task: 'purgePageDrafts',
    cron: '58 0 * * *',
    type: 'system'
  },
  // -> Same "the comparison happens inside the task" shape as `storageSyncTick`, but every 5
  //    minutes: a replication schedule is realistically daily or weekly, and `* * * * *` is already
  //    claimed.
  {
    task: 'replicationTick',
    cron: '*/5 * * * *',
    type: 'system'
  }
] as const

/**
 * Three tables back the scheduler: `jobSchedule` holds the cron definitions, `jobs` is the pending
 * queue, and `jobHistory` records every execution. A job moves from `jobs` to `jobHistory` when a
 * worker picks it up — see `core/scheduler.ts`.
 */
class Jobs {
  async init(): Promise<void> {
    CARDINAL.logger.debug('config', 'seeding the scheduled jobs')

    await CARDINAL.db.insert(jobScheduleTable).values([...JOB_SCHEDULE_SEED])

    await CARDINAL.db.insert(jobLockTable).values({
      key: 'cron',
      lastCheckedBy: 'init',
      // -> An ISO string, not a Date: pg sends it verbatim and postgres parses it as UTC, whereas a
      //    JS Date would be serialized in the process's local timezone. The cast only silences the
      //    column's `Date` type.
      lastCheckedAt: Temporal.Now.instant()
        .subtract({ hours: 1 })
        .toString({ smallestUnit: 'millisecond' }) as any
    })
  }

  /**
   * Exactly one instance holds the `cron` lock at a time and refreshes it as it queues the next
   * batch, so a stale timestamp means no instance is running that check any more. The lock is only
   * re-acquired once it is 5 minutes old, so the threshold must be a comfortable multiple of that
   * to avoid crying wolf.
   */
  async isHealthy(): Promise<boolean> {
    const results = await CARDINAL.db
      .select({ lastCheckedAt: jobLockTable.lastCheckedAt })
      .from(jobLockTable)
      .where(eq(jobLockTable.key, 'cron'))
      .limit(1)
    const lastCheckedAt = results[0]?.lastCheckedAt
    if (!lastCheckedAt) {
      return false
    }
    return (
      Temporal.Instant.compare(
        lastCheckedAt.toTemporalInstant(),
        Temporal.Now.instant().subtract({ minutes: 15 })
      ) > 0
    )
  }

  /**
   * Cluster-wide equivalent of the scheduler's per-instance `activeWorkers`, since a claimed job
   * occupies exactly one slot. An instance that dies mid-job leaves its row saying `active` and so
   * keeps counting here until `reapStaleJobs` picks it up.
   */
  async countActive(): Promise<number> {
    return CARDINAL.db.$count(jobHistoryTable, eq(jobHistoryTable.state, 'active'))
  }

  async countPending(): Promise<number> {
    return CARDINAL.db.$count(jobsTable)
  }

  /**
   * Not a monotonic total: `jobHistory` rows age out under `cleanJobHistory`'s retention window, so
   * this can go down as well as up between reads.
   */
  async countFailed(): Promise<number> {
    return CARDINAL.db.$count(jobHistoryTable, eq(jobHistoryTable.state, 'failed'))
  }

  async getSchedule() {
    return CARDINAL.db.select().from(jobScheduleTable).orderBy(jobScheduleTable.task)
  }

  async getScheduleEntry(id: string) {
    const results = await CARDINAL.db
      .select()
      .from(jobScheduleTable)
      .where(eq(jobScheduleTable.id, id))
      .limit(1)
    return results[0] ?? null
  }

  /**
   * Deliberately *not* flagged as scheduled: an on-demand run must not be mistaken for one of the
   * planned iterations `scheduler.addScheduled()` reconciles.
   */
  async runScheduledTask(entry: typeof jobScheduleTable.$inferSelect): Promise<string | null> {
    const added = await CARDINAL.scheduler.addJob({
      task: entry.task,
      payload: entry.payload ?? {}
    })
    return added?.id ?? null
  }

  /** `NULLS FIRST` because a job with no `waitUntil` is eligible right away. */
  async getUpcoming() {
    return CARDINAL.db
      .select()
      .from(jobsTable)
      .orderBy(sql`${jobsTable.waitUntil} ASC NULLS FIRST`, jobsTable.createdAt)
  }

  /**
   * An empty `states` means every state. `total` counts every match rather than the returned page,
   * so a caller can tell it is looking at a truncated view.
   */
  async getHistory({
    states = [],
    limit = 100
  }: { states?: JobState[]; limit?: number } = {}): Promise<JobHistoryPage> {
    const where = states.length > 0 ? inArray(jobHistoryTable.state, states) : undefined
    const { total, rows } = await paginate({
      rows: () =>
        CARDINAL.db
          .select()
          .from(jobHistoryTable)
          .where(where)
          .orderBy(desc(jobHistoryTable.startedAt))
          .limit(limit),
      total: () => CARDINAL.db.select({ total: count() }).from(jobHistoryTable).where(where)
    })

    return { total, jobs: rows }
  }

  async getHistoryEntry(id: string) {
    const results = await CARDINAL.db
      .select()
      .from(jobHistoryTable)
      .where(eq(jobHistoryTable.id, id))
      .limit(1)
    return results[0] ?? null
  }

  /**
   * A job just queued with `addJob` lives here, not in `jobHistory`, until some instance picks it
   * up — so a caller polling for a result by id has to check both.
   */
  async getPendingEntry(id: string) {
    const results = await CARDINAL.db.select().from(jobsTable).where(eq(jobsTable.id, id)).limit(1)
    return results[0] ?? null
  }

  /**
   * Machine-read by a follow-up route — `payload` is what a task was given, this is what it made.
   * **Not the summary a task returns**: a `TaskResult` becomes the run's one `info` log line and is
   * never written here, since it would corrupt the shape a follow-up route expects.
   *
   * Fenced against `helpers/jobExecutionContext.ts`'s attempt number: an in-process task cannot be
   * cancelled at its `taskTimeout` ceiling, so an abandoned one can still call this after a later
   * reclaim of the same job id has recorded its own result. A mismatched attempt means that reclaim
   * has moved on, so the write is dropped. A call with no matching context (a worker-thread task,
   * or any direct caller outside `executeInProcess`) writes unconditionally.
   */
  async setResult(id: string, result: Record<string, any>): Promise<void> {
    const context = getJobExecutionContext()
    if (context && context.jobId === id) {
      const updated = await CARDINAL.db
        .update(jobHistoryTable)
        .set({ result })
        .where(and(eq(jobHistoryTable.id, id), eq(jobHistoryTable.attempt, context.attempt)))
      if ((updated.rowCount ?? 0) < 1) {
        CARDINAL.logger.warn('jobs', 'dropped a stale result, a later attempt has superseded it', {
          job: id,
          attempt: context.attempt
        })
      }
      return
    }
    await CARDINAL.db.update(jobHistoryTable).set({ result }).where(eq(jobHistoryTable.id, id))
  }

  /**
   * Only a queued job can be cancelled: once an instance picks one up it is gone from `jobs` and
   * already running.
   */
  async cancelUpcoming(id: string): Promise<boolean> {
    const result = await CARDINAL.db.delete(jobsTable).where(eq(jobsTable.id, id))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * The original history entry is left alone and the new run gets its own, with a full retry
   * budget — history is a log of executions, not a mutable job record.
   */
  async retryJob(entry: typeof jobHistoryTable.$inferSelect): Promise<string | null> {
    const added = await CARDINAL.scheduler.addJob({
      task: entry.task,
      payload: entry.payload ?? {},
      maxRetries: entry.maxRetries
    })
    return added?.id ?? null
  }

  async cleanHistory(): Promise<void> {
    await CARDINAL.db.delete(jobHistoryTable).where(
      and(
        not(eq(jobHistoryTable.state, 'active')),
        lte(
          jobHistoryTable.startedAt,
          new Date(
            Temporal.Now.instant().subtract({
              seconds: CARDINAL.config.scheduler.historyExpiration
            }).epochMilliseconds
          )
        )
      )
    )
  }
}

export const jobs = new Jobs()
