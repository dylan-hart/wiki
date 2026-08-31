import { expect, test } from '@playwright/test'

import { loginAsAdmin } from '../helpers/admin.js'

/**
 * Task 2114 (feature 2103): `playwright.config.js` pins every other spec's viewport at 1280x800,
 * so nothing in the repo exercises narrow-viewport behaviour -- which is how both defects feature
 * 2103 fixed (a dialog card wider than a phone screen, and `ErrorGeneric.vue`'s fixed-size type
 * bleeding off both edges) shipped unnoticed. This file overrides the viewport for just its own
 * tests via `test.use`, rather than touching the shared config, and asserts the one thing both
 * fixes are actually for: the document never grows wider than the viewport itself.
 */
test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('a wide dialog panel clamps to the viewport instead of overflowing it', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/_admin/users')

    // -> `UserCreateDialog` carries `style="min-width: 650px"` on its inner `w-card` -- one of the
    //    twelve 650px dialogs feature 2103 found overflowing a phone screen, and the easiest to
    //    reach with `loginAsAdmin` already in hand. Opened directly off the admin users page, with
    //    no save-dialog/path step to route through first (unlike `createAndPublishPage`).
    await page.getByRole('button', { name: 'Create User', exact: true }).click()

    const dialogPanel = page.getByRole('dialog')
    await expect(dialogPanel).toBeVisible()
    await expect(dialogPanel).toHaveClass(/w-dialog-panel/)

    // -> The actual regression this spec exists to catch: `.w-dialog-panel`'s
    //    `max-width: calc(100vw - 2rem)` clamp (`tailwind.css`) is what keeps a 650px card's
    //    `min-width` from winning outright and pushing the whole document wider than the viewport.
    //    Revert that rule and this fails.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(390)
  })

  test('the error screen fits a phone width with no horizontal overflow', async ({ page }) => {
    await page.goto('/_error/notfound')

    await expect(page.locator('.errorpage-code')).toHaveText('404')

    // -> The actual regression this spec exists to catch: `ErrorGeneric.vue`'s `.errorpage-code`
    //    and `.errorpage-title` used to be fixed at `12rem`/`5rem`, which bled off both edges of a
    //    390px viewport. Revert their `clamp()` sizing (or `.errorpage-content`'s
    //    `width: 100%; max-width: 100%; padding: 0 1rem`) and this fails.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(390)
  })
})
