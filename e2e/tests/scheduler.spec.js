import { expect, test } from '@playwright/test'

import { loginAsAdmin, uniqueSlug } from '../helpers/admin.js'
import {
  deleteJob,
  insertHistoryJob,
  insertSyntheticJob,
  seedCompletedHistory,
  withDb
} from '../helpers/db.js'
// -> The source of truth for what a fresh instance's Schedule tab lists: asserting against it
//    directly, rather than a count/list duplicated here, is what keeps these cases from going stale
//    as the seed grows.
import { JOB_SCHEDULE_SEED } from '../../backend/models/jobs.ts'
// -> Reused rather than re-implemented, so the expected `<tr>` count is derived by exactly the
//    grouping `AdminScheduler.vue` renders through. Plain functions with no framework imports.
import { flattenJobHistoryRows } from '../../frontend/src/helpers/jobHistoryGrouping.js'

/**
 * Serial: several cases share the one seeded schedule and its naturally-produced Upcoming queue
 * rather than each standing up their own fixture.
 */
test.describe.configure({ mode: 'serial' })

test.describe('admin scheduler', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/_admin/scheduler')
  })

  test('Schedule tab lists every seeded cron entry with correct cron/type/timestamps', async ({
    page
  }) => {
    await page.getByRole('radio', { name: 'Schedule' }).click()

    const rows = page.locator('table tbody tr')
    await expect(rows).toHaveCount(JOB_SCHEDULE_SEED.length)

    for (const { task, cron } of JOB_SCHEDULE_SEED) {
      const row = page.locator('table tbody tr', { hasText: task })
      await expect(row).toHaveCount(1)
      await expect(row).toContainText(cron)
      // -> Rendered lowercase in the DOM; the uppercase is CSS, which never reaches `textContent`.
      await expect(row).toContainText(/system/i)
      // -> '---' is what a null/unparsed value renders as, so its absence is the timestamp being
      //    real.
      await expect(row).not.toContainText('---')
      await expect(row.getByRole('button', { name: 'Run Now' })).toBeVisible()
    }
  })

  test('Run Now queues the task, fires runNowSuccess, and it lands in history', async ({
    page
  }) => {
    await page.getByRole('radio', { name: 'Schedule' }).click()
    const row = page.locator('table tbody tr', { hasText: 'purgeRateLimits' })
    await row.getByRole('button', { name: 'Run Now' }).click()

    await expect(page.locator('.w-notification').last()).toContainText(
      'purgeRateLimits has been queued and will run shortly.'
    )

    // -> `runNow()` deliberately leaves every tab's state untouched -- nothing auto-refreshes
    //    Upcoming or Completed -- so this polls with manual refreshes rather than expecting a live
    //    update.
    await page.getByRole('radio', { name: 'Completed' }).click()
    const completedRow = page.locator('table tbody tr', { hasText: 'purgeRateLimits' }).first()
    await expect(async () => {
      await page.getByRole('button', { name: 'Refresh' }).click()
      await expect(completedRow).toBeVisible()
    }).toPass({ timeout: 15_000 })
    await expect(completedRow).not.toContainText('Error')
  })

  test('Upcoming tab shows more than one entry, plausible waitUntil, and correct useWorker rendering', async ({
    page
  }) => {
    // -> `addScheduled()` already ran at boot (`scheduler.ts#start()` calls it directly, ahead of
    //    the interval), so a correctly-planned queue holds more than one row.
    const beforeUpcoming = await page.request.get('/_api/scheduler/upcoming').then((r) => r.json())
    expect(beforeUpcoming.length).toBeGreaterThan(1)

    const now = Date.now()
    const windowMs = (24 * 60 + 5) * 60 * 1000
    for (const job of beforeUpcoming) {
      const waitMs = new Date(job.waitUntil).getTime()
      // -> Slack under `now` for clock skew between this process and the container; the bound that
      //    matters is the upper one, `addScheduled()`'s own 24h05m planning window.
      expect(waitMs).toBeGreaterThan(now - 30_000)
      expect(waitMs).toBeLessThanOrEqual(now + windowMs + 30_000)
    }

    await page.getByRole('radio', { name: 'Upcoming' }).click()
    await expect(page.locator('table tbody tr').first()).toBeVisible()
    // -> A task with 2+ upcoming instances collapses into one summary `<tr>`, so the expected count
    //    comes from the same grouping `AdminScheduler.vue` renders through, not the raw job count.
    await expect(page.locator('table tbody tr')).toHaveCount(
      flattenJobHistoryRows(beforeUpcoming, new Set()).length
    )

    // -> Every seeded cron task lives in `tasks/simple/`, so every naturally-scheduled row reads
    //    In-Process, never Worker.
    await expect(
      page.locator('table tbody tr', { hasText: 'purgeRateLimits' }).first()
    ).toContainText('In-Process')
    await expect(page.locator('table tbody tr', { hasText: 'checkVersion' }).first()).toContainText(
      'In-Process'
    )

    // -> No seeded cron task is a worker-thread job, so the "Worker" rendering path is otherwise
    //    never exercised live and the column would pass while distinguishing nothing.
    // -> `uniqueSlug()` so a Playwright retry doesn't plant a second row under the same task name:
    //    `AdminScheduler.vue` collapses rows sharing one into a single "Show individual runs" row,
    //    which breaks the lookups below. Every planted task name below does this for that reason.
    const workerTask = `e2eWorkerProbe-${uniqueSlug()}`
    const workerJobId = await withDb((db) =>
      insertSyntheticJob(db, { task: workerTask, useWorker: true, waitUntilHoursFromNow: 3 })
    )
    await page.getByRole('button', { name: 'Refresh' }).click()
    // -> Matched on the row's own id, not the task name: a rerun against a database holding a prior
    //    run's rows would otherwise match more than one row.
    const workerRow = page.locator('table tbody tr', { hasText: workerJobId })
    await expect(workerRow).toContainText(workerTask)
    await expect(workerRow).toContainText('Worker')
    await expect(workerRow).not.toContainText('In-Process')

    // -> `cancelJob()` calls `load()` on success, so the count below reflects a real refetch rather
    //    than a client-side splice.
    await workerRow.getByRole('button', { name: 'Cancel Job' }).click()
    await expect(page.locator('.w-notification').last()).toContainText(
      'Job cancelled successfully.'
    )
    await expect(page.locator('table tbody tr', { hasText: workerJobId })).toHaveCount(0)

    const afterCancelUpcoming = await page.request
      .get('/_api/scheduler/upcoming')
      .then((r) => r.json())
    expect(afterCancelUpcoming.some((j) => j.id === workerJobId)).toBe(false)
    await expect(page.locator('table tbody tr')).toHaveCount(
      flattenJobHistoryRows(afterCancelUpcoming, new Set()).length
    )
  })

  test('cancelling a job already picked up surfaces cancelJobFailed on the 404, not a raw error', async ({
    page
  }) => {
    const raceJobId = await withDb((db) =>
      insertSyntheticJob(db, {
        task: `e2eRaceProbe-${uniqueSlug()}`,
        useWorker: false,
        waitUntilHoursFromNow: 4
      })
    )

    await page.getByRole('radio', { name: 'Upcoming' }).click()
    const raceRow = page.locator('table tbody tr', { hasText: raceJobId })
    await expect(raceRow).toBeVisible()

    // -> Simulates another instance picking the job up between this render and the click below,
    //    rather than racing the 5s polling loop for real.
    await withDb((db) => deleteJob(db, raceJobId))

    await raceRow.getByRole('button', { name: 'Cancel Job' }).click()

    const toast = page.locator('.w-notification').last()
    await expect(toast).toContainText('Failed to cancel the job.')
    // -> The point of the case: the server's own 404 reason reaches the toast (read off ky's
    //    `HTTPError#data`), not ky's generic "Request failed with status code 404", which would
    //    read identically to a network failure.
    await expect(toast).toContainText('No pending job with this ID.')
    await expect(toast).not.toContainText('status code')
  })

  test('a job with no handler fails for real, lands under Failed with its own lastErrorMessage, and stays retry-disabled while an automatic retry is owed', async ({
    page
  }) => {
    // -> `task` need not exist in `tasks/simple/`, so the real `processJob()`/`runJob()` pipeline
    //    claims this row and genuinely throws trying to call it.
    const failTask = `e2eFailNow-${uniqueSlug()}`
    const jobId = await withDb((db) =>
      insertSyntheticJob(db, { task: failTask, waitUntilHoursFromNow: 0, maxRetries: 2 })
    )

    let failedRow
    await expect(async () => {
      const resp = await page.request
        .get('/_api/scheduler/jobs?states=failed&states=interrupted&limit=100')
        .then((r) => r.json())
      failedRow = resp.jobs.find((j) => j.id === jobId)
      expect(failedRow).toBeTruthy()
    }).toPass({ timeout: 15_000 })

    expect(failedRow.state).toBe('failed')
    expect(failedRow.attempt).toBe(1)
    // -> The real V8 message for calling an undefined property as a function -- proof the failure
    //    came from the real pipeline, not a canned string.
    expect(failedRow.lastErrorMessage).toMatch(/is not a function/)

    await page.getByRole('radio', { name: 'Failed' }).click()
    await page.getByRole('button', { name: 'Refresh' }).click()
    const row = page.locator('table tbody tr', { hasText: jobId })
    await expect(row).toContainText(failTask)
    await expect(row).toContainText('Error')
    await expect(row).toContainText(failedRow.lastErrorMessage)

    // -> Owes an automatic retry (attempt 1 <= maxRetries 2): `runJob` already rescheduled this job
    //    with backoff, so the manual button stays withheld.
    await expect(row.getByRole('button', { name: 'Retry Job' })).toBeDisabled()
  })

  test('a failed job that already exhausted its retries leaves Retry Job enabled, and clicking it queues a fresh job with a full retry budget', async ({
    page
  }) => {
    // -> Planted as already exhausted (attempt 3 > maxRetries 2): reaching that state for real
    //    takes multiple backoff cycles this test has no time to wait through.
    const exhaustedTask = `e2eExhaustedProbe-${uniqueSlug()}`
    const originalId = await withDb((db) =>
      insertHistoryJob(db, {
        task: exhaustedTask,
        state: 'failed',
        attempt: 3,
        maxRetries: 2,
        lastErrorMessage: 'Synthetic exhausted failure'
      })
    )

    await page.getByRole('radio', { name: 'Failed' }).click()
    await page.getByRole('button', { name: 'Refresh' }).click()
    const row = page.locator('table tbody tr', { hasText: originalId })
    const retryBtn = row.getByRole('button', { name: 'Retry Job' })
    await expect(retryBtn).toBeEnabled()

    await retryBtn.click()
    await expect(page.locator('.w-notification').last()).toContainText(
      'Job has been rescheduled and will execute shortly.'
    )

    // -> `retryJob` queues a fresh job, which the real pipeline claims and fails too (still no
    //    handler named by `exhaustedTask`), landing a new history row. Finding that row at attempt
    //    1/3 rather than continuing the original's 3/3 is the proof of "a full retry budget".
    let retried
    await expect(async () => {
      const resp = await page.request
        .get('/_api/scheduler/jobs?states=failed&states=interrupted&limit=100')
        .then((r) => r.json())
      retried = resp.jobs.find((j) => j.task === exhaustedTask && j.id !== originalId)
      expect(retried).toBeTruthy()
    }).toPass({ timeout: 15_000 })

    expect(retried.attempt).toBe(1)
    expect(retried.maxRetries).toBe(2)
  })

  test('reapStaleJobs sweeps a stranded active job to interrupted, and it shows under the Failed tab per MODE_STATES', async ({
    page
  }) => {
    const staleId = await withDb((db) =>
      insertHistoryJob(db, {
        task: `e2eStaleActiveProbe-${uniqueSlug()}`,
        state: 'active',
        attempt: 3,
        maxRetries: 2,
        // -> Older than `config.e2e.yml`'s `scheduler.staleJobTimeout` (20s), so the very next
        //    `scheduledCheck` tick (every 5s there) sweeps it.
        startedAt: new Date(Date.now() - 30_000)
      })
    )

    let swept
    await expect(async () => {
      const resp = await page.request
        .get('/_api/scheduler/jobs?states=failed&states=interrupted&limit=100')
        .then((r) => r.json())
      swept = resp.jobs.find((j) => j.id === staleId)
      expect(swept?.state).toBe('interrupted')
    }).toPass({ timeout: 15_000 })
    expect(swept.lastErrorMessage).toContain('No instance reported on this job')

    await page.getByRole('radio', { name: 'Failed' }).click()
    await page.getByRole('button', { name: 'Refresh' }).click()
    const row = page.locator('table tbody tr', { hasText: staleId })
    await expect(row).toContainText('Interrupted')
    await expect(row).toContainText(swept.lastErrorMessage)

    // -> Already exhausted (attempt 3 > maxRetries 2), so `reapStaleJobs` left it un-requeued and
    //    nothing is coming on its own -- the manual button should be live.
    await expect(row.getByRole('button', { name: 'Retry Job' })).toBeEnabled()
  })

  test('an interrupted job that still owes an automatic retry keeps Retry Job disabled too', async ({
    page
  }) => {
    // -> Planted as already-interrupted rather than swept for real: a row that genuinely still owes
    //    a retry is requeued and reprocessed by the poller within seconds, too fast to assert
    //    against without racing it.
    const jobId = await withDb((db) =>
      insertHistoryJob(db, {
        task: `e2eInterruptedPendingProbe-${uniqueSlug()}`,
        state: 'interrupted',
        attempt: 1,
        maxRetries: 2,
        lastErrorMessage:
          'No instance reported on this job within 20s. Whatever was running it is gone.'
      })
    )

    await page.getByRole('radio', { name: 'Failed' }).click()

    // -> Refreshed inside `toPass` rather than clicked once: switching tabs and clicking Refresh
    //    fire two overlapping `scheduler/jobs` fetches, so a single sample hangs off whichever
    //    render happens to be on screen. The rule itself is pinned deterministically in
    //    `frontend/src/pages/AdminScheduler.test.js`; what is left here is the round trip.
    const row = page.locator('table tbody tr', { hasText: jobId })
    await expect(async () => {
      await page.getByRole('button', { name: 'Refresh' }).click()
      await expect(row).toContainText('Interrupted')
    }).toPass({ timeout: 15_000 })

    // -> Still owes an automatic attempt (attempt 1 <= maxRetries 2), so the manual button is
    //    rendered but withheld -- the same rule a `failed` row gets.
    await expect(row.getByRole('button', { name: 'Retry Job' })).toBeDisabled()
  })

  test('Active tab shows a genuinely in-flight job with the indeterminate spinner', async ({
    page
  }) => {
    const jobId = await withDb((db) =>
      insertHistoryJob(db, {
        task: `e2eActiveSpinnerProbe-${uniqueSlug()}`,
        state: 'active',
        attempt: 1,
        maxRetries: 2
      })
    )

    await page.getByRole('radio', { name: 'Active' }).click()
    await page.getByRole('button', { name: 'Refresh' }).click()
    const row = page.locator('table tbody tr', { hasText: jobId })
    await expect(row).toBeVisible()
    await expect(row.locator('.w-circular-progress')).toBeVisible()
    await expect(row).toContainText('Pending')
    // -> Active rows render no action column at all.
    await expect(row.getByRole('button', { name: 'Retry Job' })).toHaveCount(0)
  })

  test('history cap: more than HISTORY_LIMIT completed jobs renders the truncation caption with correct numbers', async ({
    page
  }) => {
    const before = await page.request
      .get('/_api/scheduler/jobs?states=completed&limit=1')
      .then((r) => r.json())

    await withDb((db) => seedCompletedHistory(db, 110, `e2eBulkHistoryProbe-${uniqueSlug()}`))

    await page.getByRole('radio', { name: 'Completed' }).click()

    // -> `HISTORY_LIMIT` (100) caps what the tab REQUESTS, not the rendered `<tr>` count: a task
    //    completing more than once inside that window collapses into one summary row, and the live
    //    `storageSyncTick` cron (`* * * * *`) keeps depositing `completed` rows under one task name
    //    for the whole run. Deriving the expected count from the same grouping `AdminScheduler.vue`
    //    renders through, fed the same capped response, is what keeps this honest about that
    //    instead of pinning a bare `100`.
    // -> Refresh, derive and assert together inside `toPass`: the UI's fetch and this one are two
    //    reads of a list the running system is still writing to, and a tick landing between them
    //    displaces a row out of the window -- an off-by-one against a UI that is only a moment
    //    behind. The bounded timeout still fails a real off-by-N rather than spinning.
    await expect(async () => {
      await page.getByRole('button', { name: 'Refresh' }).click()
      const rawJobs = await page.request
        .get('/_api/scheduler/jobs?states=completed&limit=100')
        .then((r) => r.json())
      const expectedRowCount = flattenJobHistoryRows(rawJobs.jobs, new Set()).length
      await expect(page.locator('table tbody tr')).toHaveCount(expectedRowCount)
    }).toPass({ timeout: 15_000 })

    // -> A lower bound, not the exact total: the live `storageSyncTick` cron keeps depositing
    //    `completed` rows, so the real total can grow between the `before.total` read above and
    //    this assertion.
    const captionLocator = page.getByText(/Showing the 100 most recent of (\d+) jobs\./)
    await expect(captionLocator).toBeVisible()
    const captionText = await captionLocator.textContent()
    const [, totalText] = captionText.match(/Showing the 100 most recent of (\d+) jobs\./)
    expect(Number(totalText)).toBeGreaterThanOrEqual(before.total + 110)
  })
})
