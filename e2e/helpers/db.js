import { Client } from 'pg'

/**
 * Direct Postgres access for the job states the app's own API cannot set up on demand, rather than
 * trying to out-time the real polling loop.
 *
 * Talks to the same `DATABASE_URL` the webServer was started with, and the `wiki` schema `base.yml`
 * defaults to -- see `config.e2e.yml` for why there is no `db:` block there to read it from.
 */
export async function withDb(fn) {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query('SET search_path TO wiki')
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Bypasses `scheduler.addJob()` deliberately. It is the only way to plant a job with a chosen
 * `useWorker` value without a matching worker-thread task actually running, and the only way to
 * queue a task name the scheduler has no handler for (nothing validates `task` against
 * `tasks/simple/` before a job is queued), so that the real `processJob()`/`runJob()` pipeline
 * claims it and genuinely fails -- a real `lastErrorMessage` and retry decision, not a fabricated
 * one.
 *
 * `waitUntilHoursFromNow` defaults hours out so the polling loop never claims the row before a test
 * can observe or cancel it; `0` queues it due right away, for a test that wants it run.
 */
export async function insertSyntheticJob(
  db,
  {
    task,
    useWorker = false,
    waitUntilHoursFromNow = 2,
    maxRetries = 0,
    createdBy = 'e2e-synthetic'
  }
) {
  const result = await db.query(
    `INSERT INTO "jobs" (task, "useWorker", payload, retries, "maxRetries", "waitUntil", "isScheduled", "createdBy", "createdAt", "updatedAt")
     VALUES ($1, $2, '{}'::jsonb, 0, $3, now() + ($4 || ' hours')::interval, false, $5, now(), now())
     RETURNING id`,
    [task, useWorker, maxRetries, String(waitUntilHoursFromNow), createdBy]
  )
  return result.rows[0].id
}

/** Simulates the job having been picked up by another instance mid-render. */
export async function deleteJob(db, id) {
  await db.query('DELETE FROM "jobs" WHERE id = $1', [id])
}

/**
 * Bypasses the claim/run pipeline, for the states nothing else can plant on demand:
 *
 * - an `interrupted` row still owed a retry (`attempt <= maxRetries`): the real `reapStaleJobs`
 *   sweep requeues one and the poller re-claims it within seconds, too fast to assert the Failed
 *   tab's retry button against without racing;
 * - a `failed` row reading as having exhausted retries it never took (high `attempt`, low
 *   `maxRetries`), so a Retry Job click can be proven to reset the budget rather than continue
 *   counting up from it;
 * - an `active` row nothing will ever advance, since it was never claimed out of the real `jobs`
 *   queue, so it holds still until `scheduler.staleJobTimeout` elapses.
 */
export async function insertHistoryJob(
  db,
  {
    task,
    state,
    attempt = 1,
    maxRetries = 0,
    useWorker = false,
    lastErrorMessage = null,
    startedAt = null,
    executedBy = 'e2e-synthetic'
  }
) {
  const result = await db.query(
    `INSERT INTO "jobHistory"
       (task, state, "useWorker", "wasScheduled", payload, attempt, "maxRetries", "lastErrorMessage", "executedBy", "createdAt", "startedAt")
     VALUES ($1, $2, $3, false, '{}'::jsonb, $4, $5, $6, $7, COALESCE($8, now()), COALESCE($8, now()))
     RETURNING id`,
    [task, state, useWorker, attempt, maxRetries, lastErrorMessage, executedBy, startedAt]
  )
  return result.rows[0].id
}

/**
 * One round trip, because getting past `AdminScheduler.vue`'s `HISTORY_LIMIT` for the "showing the
 * N most recent of total" caption otherwise means waiting on real task runs one at a time.
 */
export async function seedCompletedHistory(db, count, taskPrefix = 'e2eBulkHistoryProbe') {
  await db.query(
    `INSERT INTO "jobHistory"
       (task, state, "useWorker", "wasScheduled", payload, attempt, "maxRetries", "executedBy", "createdAt", "startedAt", "completedAt")
     SELECT $1 || '-' || gs, 'completed', false, false, '{}'::jsonb, 1, 0, 'e2e-synthetic',
            now() - (gs || ' seconds')::interval,
            now() - (gs || ' seconds')::interval,
            now() - (gs || ' seconds')::interval
     FROM generate_series(1, $2) AS gs`,
    [taskPrefix, count]
  )
}
