import { Client } from 'pg'

/**
 * Direct Postgres access for the one thing the app's own API can't set up: simulating a job that an
 * instance has already picked up between the Upcoming tab rendering its row and a user clicking
 * Cancel. `scheduler.spec.js`'s "already picked up" case races that by hand -- deleting the `jobs`
 * row out from under a still-rendered UI row -- rather than trying to out-time the real 5s polling
 * loop, which the task brief itself offers as the alternative ("race it... or delete it via SQL to
 * simulate").
 *
 * Talks to the same `DATABASE_URL` the webServer itself was started with, and the same schema
 * (`wiki`) `base.yml` defaults to -- see `config.e2e.yml`'s own comment on why there is no `db:`
 * block there to read it from instead.
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
 * Inserts a row straight into the pending `jobs` queue, bypassing `scheduler.addJob()` entirely.
 * This is deliberate: it is the only way to plant a job with a chosen `useWorker` value without
 * actually having a matching worker-thread task run (there is no cron entry that produces one, and
 * the Upcoming tab's useWorker column needs one to prove it renders both states, not just the
 * in-process one every seeded cron task happens to be). It also doubles as the way `scheduler.spec.js`
 * (task 581) plants a job under a task name the scheduler genuinely has no handler for -- `task` need
 * not exist in `tasks/simple/`, since nothing validates it against that directory before a job is
 * queued -- so the real `processJob()`/`runJob()` pipeline claims and genuinely fails it (`this
 * .tasks[job.task] is not a function`), landing a real `lastErrorMessage` and a real automatic-retry
 * decision in `jobHistory`, not a fabricated one.
 *
 * `waitUntilHoursFromNow` defaults hours out so the real scheduler's polling loop never picks the row
 * up before the test gets to observe or cancel it -- pass `0` for the opposite: a job due right away,
 * for a test that wants the real pipeline to actually claim and run (fail) it.
 *
 * @returns The inserted job's id
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

/** Removes a job from the pending queue directly -- the "already picked up" simulation. */
export async function deleteJob(db, id) {
  await db.query('DELETE FROM "jobs" WHERE id = $1', [id])
}

/**
 * Inserts a row straight into `jobHistory`, bypassing the claim/run pipeline entirely. Used for the
 * states nothing else can plant on demand:
 *
 * - A permanently-stuck `interrupted` row that still has an automatic retry owed (`attempt <=
 *   maxRetries`): the real `reapStaleJobs` sweep requeues such a row and the poller picks it back up
 *   again within a handful of seconds -- too fast to reliably assert the Failed tab's retry button
 *   mid-flight without racing the poller.
 * - A `failed` row that already reads as having exhausted retries it never actually took (a high
 *   `attempt` with a low `maxRetries`), so a Retry Job click on it can be proven to reset the budget
 *   -- the new job attempting at 1/N again -- rather than continuing to count up from where a real
 *   multi-attempt job would have left off.
 * - A genuinely in-flight `active` row, for the Active tab's spinner: nothing ever advances it, since
 *   it was never claimed out of the real `jobs` queue, so it holds still for as long as an assertion
 *   needs -- short of `reapStaleJobs` eventually sweeping it once `scheduler.staleJobTimeout` elapses.
 *
 * @returns The inserted row's id
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
 * Bulk-seeds `count` synthetic `completed` history rows in one round trip -- the only practical way
 * to get past `AdminScheduler.vue`'s `HISTORY_LIMIT` (100) for the "Showing the N most recent of
 * total" caption test without either waiting on real task runs one at a time or rebuilding the
 * frontend with the constant temporarily lowered.
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
