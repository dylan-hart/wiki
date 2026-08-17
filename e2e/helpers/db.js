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
 * in-process one every seeded cron task happens to be).
 *
 * `task` is a synthetic name (never a real task the scheduler would try to execute) and `waitUntil`
 * is always hours out, so the real scheduler's polling loop never picks the row up and fails trying
 * to run it before the test gets to observe or cancel it.
 *
 * @returns The inserted job's id
 */
export async function insertSyntheticJob(
  db,
  { task, useWorker = false, waitUntilHoursFromNow = 2, createdBy = 'e2e-synthetic' }
) {
  const result = await db.query(
    `INSERT INTO "jobs" (task, "useWorker", payload, retries, "maxRetries", "waitUntil", "isScheduled", "createdBy", "createdAt", "updatedAt")
     VALUES ($1, $2, '{}'::jsonb, 0, 0, now() + ($3 || ' hours')::interval, false, $4, now(), now())
     RETURNING id`,
    [task, useWorker, String(waitUntilHoursFromNow), createdBy]
  )
  return result.rows[0].id
}

/** Removes a job from the pending queue directly -- the "already picked up" simulation. */
export async function deleteJob(db, id) {
  await db.query('DELETE FROM "jobs" WHERE id = $1', [id])
}
