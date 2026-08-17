import { expect, test } from '@playwright/test'

import { loginAsAdmin } from '../helpers/admin.js'
import { deleteJob, insertSyntheticJob, withDb } from '../helpers/db.js'

/**
 * End-to-end verification of AdminScheduler.vue's Schedule and Upcoming tabs, against a real
 * backend/database -- see task 579. Runs serially: several cases share the one seeded schedule and
 * its naturally-produced Upcoming queue rather than each standing up their own fixture.
 */
test.describe.configure({ mode: 'serial' })

test.describe('admin scheduler', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/_admin/scheduler')
  })

  test('Schedule tab lists the four seeded cron entries with correct cron/type/timestamps', async ({
    page
  }) => {
    await page.getByRole('radio', { name: 'Schedule' }).click()

    const rows = page.locator('table tbody tr')
    await expect(rows).toHaveCount(4)

    const expected = {
      checkVersion: '0 0 * * *',
      cleanJobHistory: '5 0 * * *',
      purgeRateLimits: '10 * * * *',
      updateLocales: '0 0 * * *'
    }

    for (const [task, cron] of Object.entries(expected)) {
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
    const workerJobId = await withDb((db) =>
      insertSyntheticJob(db, { task: 'e2eWorkerProbe', useWorker: true, waitUntilHoursFromNow: 3 })
    )
    await page.getByRole('button', { name: 'Refresh' }).click()
    // -> Matched on the row's own id (rendered as the small grey line under the task name), not
    //    just the task name: a rerun against a database that already has a prior run's rows in it
    //    (anything short of a brand new container) would otherwise match more than one row.
    const workerRow = page.locator('table tbody tr', { hasText: workerJobId })
    await expect(workerRow).toContainText('e2eWorkerProbe')
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
    const raceJobId = await withDb((db) =>
      insertSyntheticJob(db, { task: 'e2eRaceProbe', useWorker: false, waitUntilHoursFromNow: 4 })
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
})
