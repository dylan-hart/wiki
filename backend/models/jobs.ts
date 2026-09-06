import {
  jobs as jobsTable,
  jobSchedule as jobScheduleTable,
  jobLock as jobLockTable,
  jobHistory as jobHistoryTable
} from '../db/schema.ts'
import { and, count, desc, eq, inArray, lte, not, sql } from 'drizzle-orm'
import { getJobExecutionContext } from '../helpers/jobExecutionContext.ts'
import { paginate } from '../helpers/pagination.ts'

/** The states a job can be in once it has been picked up for execution. */
export const JOB_STATES = ['active', 'completed', 'failed', 'interrupted'] as const
export type JobState = (typeof JOB_STATES)[number]

/** One page of job history, with the total matching the requested states. */
export interface JobHistoryPage {
  total: number
  jobs: (typeof jobHistoryTable.$inferSelect)[]
}

/**
 * The cron entries every fresh instance starts with, inserted into `jobSchedule` by `init()`.
 * Exported (rather than inlined there) so it can be asserted on directly, without a database.
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
  // {
  //   task: 'refreshAutocomplete',
  //   cron: '0 */6 * * *',
  //   type: 'system'
  // },
  {
    task: 'purgeRateLimits',
    cron: '10 * * * *',
    type: 'system'
  },
  // -> Sweeps `sessions` rows past the cookie's 30-day window -- see
  //    `tasks/simple/purge-sessions.ts` / `models/sessions.ts#purgeExpiredSessions()`. Hourly, like
  //    `purgeRateLimits` above (also SELECTed on every authenticated request, also unbounded), offset
  //    to a different minute so the two don't compete on the same tick.
  {
    task: 'purgeSessions',
    cron: '40 * * * *',
    type: 'system'
  },
  // -> Sweeps expired site-backup archives/uploads off disk — see
  //    `tasks/simple/purge-exports.ts` / `models/export.ts` and
  //    `tasks/simple/purge-imports.ts` / `models/siteImport.ts`. Offset five minutes apart, both
  //    ahead of the midnight housekeeping jobs below.
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
  // -> Sweeps `pageviews` rows past the 2-year retention window -- see
  //    `tasks/simple/purge-pageviews.ts` / `models/pageviews.ts#purgeExpired()`. Offset alongside the
  //    other midnight housekeeping jobs above.
  {
    task: 'purgePageviews',
    cron: '25 0 * * *',
    type: 'system'
  },
  // -> Offset from `checkVersion` above, which also writes to `WIKI.config.update` -- both used to
  //    land on the same minute and be claimed as one `processJob` batch, and `checkVersion`'s
  //    (now-fixed) unconditional overwrite of the whole `update` object raced this task's synchronous
  //    read of `update.locales` at the top of its own `task()`, discarding an operator's opt-out on
  //    every co-scheduled run after the first.
  {
    task: 'updateLocales',
    cron: '30 0 * * *',
    type: 'system'
  },
  // -> Trims audit log entries older than the configured retention window (default
  //    `DEFAULT_AUDIT_LOG_RETENTION_DAYS`, admin-editable) -- see `tasks/simple/clean-audit-log.ts` /
  //    `models/auditLog.ts#purge()`. Offset from the other midnight housekeeping jobs above.
  {
    task: 'cleanAuditLog',
    cron: '35 0 * * *',
    type: 'system'
  },
  // -> Sweeps `contentSyncState` rows whose `contentId` no longer matches any `pages`/`assets` row --
  //    the backstop for rows the delete-path's own cleanup cannot reach. See
  //    `tasks/simple/purge-content-sync-state.ts` / `models/contentSync.ts#purgeOrphaned()`. Offset
  //    alongside the other midnight housekeeping jobs above.
  {
    task: 'purgeContentSyncState',
    cron: '40 0 * * *',
    type: 'system'
  },
  // -> Sweeps `userKeys` rows past their `validUntil` (abandoned password-reset links, abandoned 2FA
  //    continuations) -- see `tasks/simple/purge-user-keys.ts` / `models/users.ts#purgeExpiredKeys()`.
  //    Offset alongside the other midnight housekeeping jobs above.
  {
    task: 'purgeUserKeys',
    cron: '45 0 * * *',
    type: 'system'
  },
  // -> Nulls `guestName`/`guestEmail`/`guestIp` on guest comments past the configured retention
  //    window (default `DEFAULT_GUEST_PII_RETENTION_DAYS`, admin-editable) -- see
  //    `tasks/simple/purge-guest-pii.ts` / `models/comments.ts#purgeGuestPii()`. Offset from the
  //    other midnight housekeeping jobs above.
  {
    task: 'purgeGuestPii',
    cron: '55 0 * * *',
    type: 'system'
  },
  // -> Checks every pull/two-way storage target's schedule and queues a sync for whichever is due —
  //    a short cron since the comparison against each target's own interval happens inside the task
  //    itself, not here. See `tasks/simple/storage-sync-tick.ts` / `Storage.tickScheduledSyncs()`.
  {
    task: 'storageSyncTick',
    cron: '* * * * *',
    type: 'system'
  },
  // -> Enumerates every site's storage targets and, for each enabled disk target with
  //    `config.createDailyBackups` on, archives it into `_daily` and prunes entries older than a
  //    month. Runs once a day, offset from the other daily entries above (which all land at
  //    midnight) so it is not competing with them for the same tick. See
  //    `tasks/simple/storage-daily-backup.ts`.
  {
    task: 'storageDailyBackup',
    cron: '30 2 * * *',
    type: 'system'
  },
  // -> Once daily, not clustered with the midnight housekeeping jobs above: a digest is a
  //    reader-facing send, so it runs at a time someone is more plausibly about to check mail
  //    rather than in the middle of the night in every timezone at once. See
  //    `tasks/simple/send-watch-digests.ts` for why this can't just run inline off a page change.
  {
    task: 'sendWatchDigests',
    cron: '0 8 * * *',
    type: 'system'
  },
  // -> Sweeps `pageWatchEvents` rows past the 90-day retention window -- see
  //    `tasks/simple/purge-page-watch-events.ts` / `models/pageWatchEvents.ts#purgeExpired()`. Offset
  //    alongside the other midnight housekeeping jobs above (OpenProject #1689).
  {
    task: 'purgePageWatchEvents',
    cron: '50 0 * * *',
    type: 'system'
  },
  // -> Sweeps `pageDrafts` rows past the 30-day retention window -- an autosaved collaborative-editing
  // draft (OpenProject #2454) for a page abandoned mid-edit and never reopened. Everything else is
  // already cleared on save by `core/collab.ts#pageSaved()`; this is only the backstop for what that
  // path never sees. See `tasks/simple/purge-page-drafts.ts` / `models/pageDrafts.ts#purgeStale()`.
  // Offset alongside the other midnight housekeeping jobs above.
  {
    task: 'purgePageDrafts',
    cron: '58 0 * * *',
    type: 'system'
  },
  // -> Checks the configured replication schedule (`WIKI.config.replication`, OpenProject #2437) and
  //    queues a `replicationPull` job when it's due -- same "comparison happens inside the task
  //    itself" shape as `storageSyncTick` above. Every 5 minutes rather than `storageSyncTick`'s
  //    every-minute cron, both because a replication schedule is realistically daily/weekly (no need
  //    for minute-level precision) and because `* * * * *` is already claimed by `storageSyncTick` --
  //    see `models/jobs.test.ts`'s uniqueness check. See `models/replication.ts#tick()` /
  //    `tasks/simple/replication-tick.ts`.
  {
    task: 'replicationTick',
    cron: '*/5 * * * *',
    type: 'system'
  }
] as const

/**
 * Jobs model
 *
 * Three tables back the scheduler, and the admin area shows all three: `jobSchedule` holds the cron
 * definitions, `jobs` is the pending queue, and `jobHistory` records every execution. A job moves
 * from `jobs` to `jobHistory` when a worker picks it up — see `core/scheduler.ts`.
 */
class Jobs {
  /**
   * Initialize jobs table
   */
  async init(): Promise<void> {
    WIKI.logger.debug('config', 'seeding the scheduled jobs')

    await WIKI.db.insert(jobScheduleTable).values([...JOB_SCHEDULE_SEED])

    await WIKI.db.insert(jobLockTable).values({
      key: 'cron',
      lastCheckedBy: 'init',
      // NOTE: an ISO string, not a Date, is passed deliberately — pg sends it verbatim and
      // postgres parses it as UTC, whereas a JS Date would be serialized in the process's local
      // timezone. Kept as-is; the cast only silences the column's `Date` type.
      lastCheckedAt: Temporal.Now.instant()
        .subtract({ hours: 1 })
        .toString({ smallestUnit: 'millisecond' }) as any
    })
  }

  /**
   * Whether the scheduler is keeping up with its cron duties.
   *
   * Exactly one instance holds the `cron` lock at a time and refreshes it as it queues the next
   * batch of scheduled jobs, so a stale timestamp means no instance is running that check any more.
   * The lock is only re-acquired once it is 5 minutes old, and the check itself runs on an interval,
   * so the threshold has to be a comfortable multiple of that to avoid crying wolf.
   */
  async isHealthy(): Promise<boolean> {
    const results = await WIKI.db
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
   * How many jobs are running right now, across every instance.
   *
   * A job occupies exactly one worker slot from the moment it is claimed — `core/scheduler.ts`
   * moves it into the history as `active` and bumps `activeWorkers` in the same step — so this is
   * the cluster-wide equivalent of that per-instance counter.
   *
   * An instance that dies mid-job leaves its row saying `active` until `reapStaleJobs` picks it up,
   * which counts here in the meantime, exactly as it still shows under the scheduler's active tab.
   */
  async countActive(): Promise<number> {
    return WIKI.db.$count(jobHistoryTable, eq(jobHistoryTable.state, 'active'))
  }

  /**
   * How many jobs are sitting in the pending queue, not yet claimed by any worker.
   *
   * The `/metrics` endpoint's queue-depth gauge; `countActive()` above is its running counterpart.
   */
  async countPending(): Promise<number> {
    return WIKI.db.$count(jobsTable)
  }

  /**
   * How many failed jobs are currently retained in job history.
   *
   * Not a true monotonic total: `jobHistory` rows age out under `cleanJobHistory`'s retention window
   * (see `tasks/simple/clean-job-history.ts`), so this can go down as well as up between reads — a
   * count of what is currently retained, not a running lifetime count. `/metrics`' gauge of the same
   * name documents this same caveat for scrapers.
   */
  async countFailed(): Promise<number> {
    return WIKI.db.$count(jobHistoryTable, eq(jobHistoryTable.state, 'failed'))
  }

  /**
   * The cron schedule: which tasks run automatically and how often
   */
  async getSchedule() {
    return WIKI.db.select().from(jobScheduleTable).orderBy(jobScheduleTable.task)
  }

  /**
   * A single cron entry, or null if there is no such entry
   */
  async getScheduleEntry(id: string) {
    const results = await WIKI.db
      .select()
      .from(jobScheduleTable)
      .where(eq(jobScheduleTable.id, id))
      .limit(1)
    return results[0] ?? null
  }

  /**
   * Queue a cron entry's task to run at the next opportunity.
   *
   * The job is deliberately *not* flagged as scheduled: it is an on-demand run, so it must not be
   * mistaken for one of the planned iterations that `scheduler.addScheduled()` reconciles.
   *
   * @returns The new job's ID, or null if the scheduler refused it
   */
  async runScheduledTask(entry: typeof jobScheduleTable.$inferSelect): Promise<string | null> {
    const added = await WIKI.scheduler.addJob({
      task: entry.task,
      payload: entry.payload ?? {}
    })
    return added?.id ?? null
  }

  /**
   * The pending queue, soonest first. Jobs with no `waitUntil` are eligible right away, so they
   * come before any dated ones.
   */
  async getUpcoming() {
    return WIKI.db
      .select()
      .from(jobsTable)
      .orderBy(sql`${jobsTable.waitUntil} ASC NULLS FIRST`, jobsTable.createdAt)
  }

  /**
   * Job execution history, most recently started first.
   *
   * @param states Keep only these states; all of them when empty
   * @param limit Caps the rows returned — `total` still counts every match, so a caller can tell
   *              that it is looking at a truncated view
   */
  async getHistory({
    states = [],
    limit = 100
  }: { states?: JobState[]; limit?: number } = {}): Promise<JobHistoryPage> {
    const where = states.length > 0 ? inArray(jobHistoryTable.state, states) : undefined
    const { total, rows } = await paginate({
      rows: () =>
        WIKI.db
          .select()
          .from(jobHistoryTable)
          .where(where)
          .orderBy(desc(jobHistoryTable.startedAt))
          .limit(limit),
      total: () => WIKI.db.select({ total: count() }).from(jobHistoryTable).where(where)
    })

    return { total, jobs: rows }
  }

  /**
   * A single history entry, or null if no such job ever ran
   */
  async getHistoryEntry(id: string) {
    const results = await WIKI.db
      .select()
      .from(jobHistoryTable)
      .where(eq(jobHistoryTable.id, id))
      .limit(1)
    return results[0] ?? null
  }

  /**
   * A single pending-queue entry, or null if no such job is waiting.
   *
   * A job just queued with `addJob` lives here, not in `jobHistory`, until some instance picks it
   * up — a caller polling for a result by id needs both, since the gap between the two can be a
   * poll interval wide.
   */
  async getPendingEntry(id: string) {
    const results = await WIKI.db.select().from(jobsTable).where(eq(jobsTable.id, id)).limit(1)
    return results[0] ?? null
  }

  /**
   * Record what a task produced, keyed by its own job id.
   *
   * The generic escape hatch a task uses to hand something back to whoever queued it — `payload` is
   * what a task was given, this is what it made. `exportContent` is the first user: it stores
   * `{ filePath, fileSize }` here so the download route can find the tarball without either side
   * knowing anything more specific about the other.
   *
   * Fenced against `helpers/jobExecutionContext.ts`'s attempt number (OpenProject #2351): an
   * in-process task cannot actually be cancelled at its `taskTimeout` ceiling, so a stale,
   * already-abandoned task can still be running in the background and call this after a later
   * reclaim of the same job id has already completed and recorded its own result. When the calling
   * task's captured attempt no longer matches `jobHistory.attempt`, that later reclaim has moved on,
   * so the write is dropped rather than clobbering it. A call with no matching context (a
   * worker-thread task, or any direct caller outside `executeInProcess`) writes unconditionally, as
   * before.
   */
  async setResult(id: string, result: Record<string, any>): Promise<void> {
    const context = getJobExecutionContext()
    if (context && context.jobId === id) {
      const updated = await WIKI.db
        .update(jobHistoryTable)
        .set({ result })
        .where(and(eq(jobHistoryTable.id, id), eq(jobHistoryTable.attempt, context.attempt)))
      if ((updated.rowCount ?? 0) < 1) {
        WIKI.logger.warn('jobs', 'dropped a stale result, a later attempt has superseded it', {
          job: id,
          attempt: context.attempt
        })
      }
      return
    }
    await WIKI.db.update(jobHistoryTable).set({ result }).where(eq(jobHistoryTable.id, id))
  }

  /**
   * Drop a job from the pending queue.
   *
   * Only queued jobs can be cancelled: once an instance has picked one up it is gone from `jobs`
   * and already running.
   *
   * @returns Whether a queued job was removed
   */
  async cancelUpcoming(id: string): Promise<boolean> {
    const result = await WIKI.db.delete(jobsTable).where(eq(jobsTable.id, id))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Queue a fresh run of a past job.
   *
   * The original history entry is left alone and the new run gets its own entry with a full retry
   * budget — history is a log of executions, not a mutable job record.
   *
   * @returns The new job's ID, or null if the scheduler refused it
   */
  async retryJob(entry: typeof jobHistoryTable.$inferSelect): Promise<string | null> {
    const added = await WIKI.scheduler.addJob({
      task: entry.task,
      payload: entry.payload ?? {},
      maxRetries: entry.maxRetries
    })
    return added?.id ?? null
  }

  /**
   * Purge old job history
   */
  async cleanHistory(): Promise<void> {
    await WIKI.db.delete(jobHistoryTable).where(
      and(
        not(eq(jobHistoryTable.state, 'active')),
        lte(
          jobHistoryTable.startedAt,
          new Date(
            Temporal.Now.instant().subtract({
              seconds: WIKI.config.scheduler.historyExpiration
            }).epochMilliseconds
          )
        )
      )
    )
  }
}

export const jobs = new Jobs()
