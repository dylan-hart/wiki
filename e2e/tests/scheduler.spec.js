import { expect, test } from '@playwright/test'

import { loginAsAdmin, uniqueSlug } from '../helpers/admin.js'
import {
  deleteJob,
  insertHistoryJob,
  insertSyntheticJob,
  seedCompletedHistory,
  withDb
} from '../helpers/db.js'
// -> The source of truth for what a fresh instance's Schedule tab lists -- see `rtl.spec.js`'s own
//    header comment for why importing straight from `backend/` works from this workspace (bare
//    specifiers inside the imported file resolve against `backend/`'s own `node_modules`, not this
//    one's). Asserting against this directly, rather than a hardcoded count/list duplicated here, is
//    what keeps this test from going stale the way it already had: it still expected the original
//    four entries (and `updateLocales`'s original, since-changed cron) long after `JOB_SCHEDULE_SEED`
//    had grown to sixteen.
import { JOB_SCHEDULE_SEED } from '../../backend/models/jobs.ts'
// -> Reused, not re-implemented: the "history cap" test below needs to know how many `<tr>`s
//    `AdminScheduler.vue` actually renders for a given job list, and that is exactly what this
//    grouping (OpenProject #2337) already computes. It has no framework imports of its own (plain
//    functions only), so it resolves here the same way the `backend/` import above does.
import { flattenJobHistoryRows } from '../../frontend/src/helpers/jobHistoryGrouping.js'

/**
 * End-to-end verification of AdminScheduler.vue's tabs against a real backend/database -- Schedule
 * and Upcoming are task 579's, Active/Completed/Failed/Retry/history-cap below are task 581's. Runs
 * serially: several cases share the one seeded schedule and its naturally-produced Upcoming queue
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
      // -> Rendered lowercase in the DOM (`props.value`); CSS applies the visual uppercase, so
      //    match case-insensitively rather than assume text-transform shows up in textContent.
      await expect(row).toContainText(/system/i)
      // -> Created/Updated columns both render `humanizeDate()` under the relative label -- '---'
      //    is what a null/unparsed value would show, so its absence is the timestamp being real.
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

    // -> `runNow()` deliberately leaves the Schedule tab's own state untouched (see the code
    //    comment in AdminScheduler.vue) -- nothing here auto-refreshes Upcoming or Completed. That
    //    is exactly the UX gap task 579 asks to be recorded; this assertion documents it by polling
    //    Completed with manual refreshes rather than expecting a live update.
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
    // -> The real assertion this exists to make: `addScheduled()` already ran once at boot
    //    (`scheduler.ts`'s `start()` calls it directly, ahead of the interval), and the bug task
    //    573/576 fixed capped this at one stale row -- so more than one proves the fix holds
    //    end-to-end, not just in the unit test.
    const beforeUpcoming = await page.request.get('/_api/scheduler/upcoming').then((r) => r.json())
    expect(beforeUpcoming.length).toBeGreaterThan(1)

    const now = Date.now()
    const windowMs = (24 * 60 + 5) * 60 * 1000
    for (const job of beforeUpcoming) {
      const waitMs = new Date(job.waitUntil).getTime()
      // -> A few seconds of slack under `now` for clock skew between this process and the
      //    container; the real bound this proves is the upper one -- addScheduled()'s own
      //    24h05m planning window.
      expect(waitMs).toBeGreaterThan(now - 30_000)
      expect(waitMs).toBeLessThanOrEqual(now + windowMs + 30_000)
    }

    await page.getByRole('radio', { name: 'Upcoming' }).click()
    await expect(page.locator('table tbody tr').first()).toBeVisible()
    await expect(page.locator('table tbody tr')).toHaveCount(beforeUpcoming.length)

    // -> Every seeded cron task lives in `tasks/simple/` (in-process), so every naturally-scheduled
    //    row should read In-Process, never Worker.
    await expect(
      page.locator('table tbody tr', { hasText: 'purgeRateLimits' }).first()
    ).toContainText('In-Process')
    await expect(page.locator('table tbody tr', { hasText: 'checkVersion' }).first()).toContainText(
      'In-Process'
    )

    // -> Nothing in the naturally-produced queue is a worker-thread job (none of the seeded cron
    //    tasks are), so the "Worker" rendering path is otherwise never exercised live. Plant one
    //    directly -- see `helpers/db.js` -- to prove the column really distinguishes both states,
    //    not just the one every seeded row happens to share.
    // -> Task name suffixed with `uniqueSlug()` so a Playwright retry of this whole test doesn't
    //    plant a second row under the same task name -- `AdminScheduler.vue` groups multiple
    //    history/upcoming rows sharing a task name into one collapsed "Show individual runs" row,
    //    which breaks the row lookups below (task 2373).
    const workerTask = `e2eWorkerProbe-${uniqueSlug()}`
    const workerJobId = await withDb((db) =>
      insertSyntheticJob(db, { task: workerTask, useWorker: true, waitUntilHoursFromNow: 3 })
    )
    await page.getByRole('button', { name: 'Refresh' }).click()
    // -> Matched on the row's own id (rendered as the small grey line under the task name), not
    //    just the task name: a rerun against a database that already has a prior run's rows in it
    //    (anything short of a brand new container) would otherwise match more than one row.
    const workerRow = page.locator('table tbody tr', { hasText: workerJobId })
    await expect(workerRow).toContainText(workerTask)
    await expect(workerRow).toContainText('Worker')
    await expect(workerRow).not.toContainText('In-Process')

    // -> Cancel Job on a genuinely-pending row: removes it, refetches (the count below reflects a
    //    real reload, not a client-side splice -- `cancelJob()` calls `load()` on success).
    //
    //    Selected by its icon rather than `getByRole('button', { name: 'Cancel Job' })`: unlike
    //    every sibling icon-button on this page (Run Now, Retry Job), this one has no `aria-label`
    //    -- its only accessible text lives in a `<w-tooltip>` that is `aria-hidden` until hovered
    //    (see `WTooltip.vue`), so the button's computed accessible name is empty. A real
    //    accessibility gap this test surfaced live; recorded as follow-up scope rather than fixed
    //    here (out of scope for a verification-only task) -- see AdminScheduler.vue's Upcoming
    //    tab, the `body-cell-cancel` template's `<w-btn icon="la:window-close">`.
    await workerRow.locator('button:has([data-icon="la:window-close"])').click()
    await expect(page.locator('.w-notification').last()).toContainText(
      'Job cancelled successfully.'
    )
    await expect(page.locator('table tbody tr', { hasText: workerJobId })).toHaveCount(0)

    const afterCancelUpcoming = await page.request
      .get('/_api/scheduler/upcoming')
      .then((r) => r.json())
    expect(afterCancelUpcoming.some((j) => j.id === workerJobId)).toBe(false)
    await expect(page.locator('table tbody tr')).toHaveCount(afterCancelUpcoming.length)
  })

  test('cancelling a job already picked up surfaces cancelJobFailed on the 404, not a raw error', async ({
    page
  }) => {
    // -> Suffixed with `uniqueSlug()` -- see the worker probe test above (task 2373).
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

    // -> Simulates an instance picking the job up between this render and the click below -- the
    //    task brief's own suggested alternative to actually racing the 5s polling loop.
    await withDb((db) => deleteJob(db, raceJobId))

    // -> See the sibling test above for why this is selected by icon rather than accessible name.
    await raceRow.locator('button:has([data-icon="la:window-close"])').click()

    const toast = page.locator('.w-notification').last()
    await expect(toast).toContainText('Failed to cancel the job.')
    // -> The whole point of the assertion: the server's real 404 reason (`reply.notFound('No
    //    pending job with this ID.')`, read off ky's `HTTPError#data`), not ky's generic "Request
    //    failed with status code 404" -- ky/`apiErrorMessage()` losing that would read identically
    //    to a network failure with no explanation at all.
    await expect(toast).toContainText('No pending job with this ID.')
    await expect(toast).not.toContainText('status code')
  })

  test('a job with no handler fails for real, lands under Failed with its own lastErrorMessage, and stays retry-disabled while an automatic retry is owed', async ({
    page
  }) => {
    // -> `task` need not exist in `tasks/simple/` -- see `helpers/db.js` -- so the real
    //    `processJob()`/`runJob()` pipeline claims this and genuinely throws trying to call it.
    //    Suffixed with `uniqueSlug()` so a Playwright retry doesn't plant a second row under the
    //    same task name -- see the worker probe test above (task 2373).
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
    // -> The real V8 message for calling an undefined property as a function -- proof this is a
    //    genuine failure from the real pipeline, not a canned string.
    expect(failedRow.lastErrorMessage).toMatch(/is not a function/)

    await page.getByRole('radio', { name: 'Failed' }).click()
    await page.getByRole('button', { name: 'Refresh' }).click()
    const row = page.locator('table tbody tr', { hasText: jobId })
    await expect(row).toContainText(failTask)
    await expect(row).toContainText('Error')
    await expect(row).toContainText(failedRow.lastErrorMessage)

    // -> Owes an automatic retry (attempt 1 <= maxRetries 2): `runJob` already rescheduled this job
    //    with backoff, so the manual button stays withheld -- see the template comment.
    await expect(row.getByRole('button', { name: 'Retry Job' })).toBeDisabled()
  })

  test('a failed job that already exhausted its retries leaves Retry Job enabled, and clicking it queues a fresh job with a full retry budget', async ({
    page
  }) => {
    // -> Planted directly in `jobHistory` (see `helpers/db.js`) reading as already exhausted
    //    (attempt 3 > maxRetries 2) -- a real multi-attempt job would take multiple backoff cycles
    //    to reach that state, which this test does not have time to wait through.
    // -> Suffixed with `uniqueSlug()` -- see the worker probe test above (task 2373).
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

    // -> `WIKI.models.jobs.retryJob` calls `scheduler.addJob()` fresh -- the real pipeline then
    //    claims and fails this too (still no handler named by `exhaustedTask`), landing a brand
    //    new history row. Finding it at attempt 1/3, not continuing from the exhausted original's
    //    3/3, is the actual proof of "a full retry budget".
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
    // -> Suffixed with `uniqueSlug()` -- see the worker probe test above (task 2373).
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

    // -> Already exhausted (attempt 3 > maxRetries 2): `reapStaleJobs`'s own "SKIPPED" branch left
    //    it un-requeued, so nothing is coming on its own -- the manual button should be live.
    await expect(row.getByRole('button', { name: 'Retry Job' })).toBeEnabled()
  })

  test('an interrupted job that still owes an automatic retry keeps Retry Job disabled too', async ({
    page
  }) => {
    // -> The UX gap this task closes: `reapStaleJobs` requeues an interrupted row under the exact
    //    same rule (`attempt <= maxRetries`) it fails one under, but the template's disable
    //    condition used to check `state === 'failed'` only. Planted directly as already-interrupted
    //    (see `helpers/db.js`) rather than via a real sweep + wait, since a row that genuinely still
    //    owes a retry gets requeued and reprocessed by the poller within seconds -- too fast to
    //    reliably assert against without racing it.
    // -> Suffixed with `uniqueSlug()` -- see the worker probe test above (task 2373).
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
    await page.getByRole('button', { name: 'Refresh' }).click()
    const row = page.locator('table tbody tr', { hasText: jobId })
    await expect(row).toContainText('Interrupted')
    await expect(row.getByRole('button', { name: 'Retry Job' })).toBeDisabled()
  })

  test('Active tab shows a genuinely in-flight job with the indeterminate spinner', async ({
    page
  }) => {
    // -> Suffixed with `uniqueSlug()` -- see the worker probe test above (task 2373).
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
    // -> Active rows have no action column at all (`v-if="props.row.state !== 'active'"`)
    await expect(row.getByRole('button', { name: 'Retry Job' })).toHaveCount(0)
  })

  test('history cap: more than HISTORY_LIMIT completed jobs renders the truncation caption with correct numbers', async ({
    page
  }) => {
    const before = await page.request
      .get('/_api/scheduler/jobs?states=completed&limit=1')
      .then((r) => r.json())

    // -> `taskPrefix` suffixed with `uniqueSlug()` so a Playwright retry doesn't replant the same
    //    110 `e2eBulkHistoryProbe-<n>` rows under a prefix a previous attempt already used --
    //    same grouping mechanism as the worker probe test above (task 2373).
    await withDb((db) => seedCompletedHistory(db, 110, `e2eBulkHistoryProbe-${uniqueSlug()}`))

    await page.getByRole('radio', { name: 'Completed' }).click()
    await page.getByRole('button', { name: 'Refresh' }).click()

    // -> `HISTORY_LIMIT` (100) caps what the tab REQUESTS regardless of how many actually match, but
    //    it does not pin the rendered `<tr>` count at exactly 100: a task that completed more than
    //    once within that top-100 window collapses into a single summary row (OpenProject #2337's
    //    grouping, task 2373's own note on the Upcoming test above). The bulk-seeded rows above are
    //    all uniquely named and can't collide with each other, but a live `storageSyncTick` cron
    //    (`* * * * *`, ticking for the whole e2e run's one shared `webServer`) deposits its own
    //    `completed` rows under the SAME task name throughout -- and once it has ticked more than
    //    once before this test runs, its rows group into one row too, taking the rendered count
    //    below 100 even though the API cap held. Deriving the expected row count from the same
    //    grouping logic `AdminScheduler.vue` renders through -- fed the same capped response it
    //    fetches -- is what keeps this assertion honest about that instead of pinning a bare `100`.
    const rawJobs = await page.request
      .get('/_api/scheduler/jobs?states=completed&limit=100')
      .then((r) => r.json())
    const expectedRowCount = flattenJobHistoryRows(rawJobs.jobs, new Set()).length
    await expect(page.locator('table tbody tr')).toHaveCount(expectedRowCount)

    // -> The exact total is not asserted: the same live `storageSyncTick` cron deposits its own
    // `completed` rows for the whole duration of the run (see `backend/models/jobs.ts`), so the
    // real total can grow between the `before.total` read above and this assertion. Match the shape
    // and assert the captured number is at least what was seeded, which still proves the caption
    // renders, that the cap is 100 and that the seeded rows are counted -- without pinning a number
    // the running system owns.
    const captionLocator = page.getByText(/Showing the 100 most recent of (\d+) jobs\./)
    await expect(captionLocator).toBeVisible()
    const captionText = await captionLocator.textContent()
    const [, totalText] = captionText.match(/Showing the 100 most recent of (\d+) jobs\./)
    expect(Number(totalText)).toBeGreaterThanOrEqual(before.total + 110)
  })
})
