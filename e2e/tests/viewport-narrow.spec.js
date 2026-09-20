import { expect, test } from '@playwright/test'

import { loginAsAdmin } from '../helpers/admin.js'

/**
 * `playwright.config.js` pins every other spec at 1280x800, so nothing else exercises
 * narrow-viewport behaviour. The override lives in this file's own `test.use` rather than the
 * shared config, and both cases assert the same thing: the document never grows wider than the
 * viewport.
 */
test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('a wide dialog panel clamps to the viewport instead of overflowing it', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/_admin/users')

    // -> `UserCreateDialog` carries `style="min-width: 650px"` on its inner `w-card`, like every
    //    other wide dialog in the app, and is the one reachable straight off an admin page with
    //    `loginAsAdmin` already in hand.
    await page.getByRole('button', { name: 'Create User', exact: true }).click()

    const dialogPanel = page.getByRole('dialog')
    await expect(dialogPanel).toBeVisible()
    await expect(dialogPanel).toHaveClass(/w-dialog-panel/)

    // -> `.w-dialog-panel`'s `max-width: calc(100vw - 2rem)` clamp (`tailwind.css`) is what keeps
    //    the card's 650px `min-width` from winning outright and pushing the document wider than the
    //    viewport.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(390)
  })

  test('the error screen fits a phone width with no horizontal overflow', async ({ page }) => {
    await page.goto('/_error/notfound')

    await expect(page.locator('.errorpage-code')).toHaveText('404')

    // -> `ErrorGeneric.vue` sizes `.errorpage-code`/`.errorpage-title` with `clamp()` and caps
    //    `.errorpage-content` at `max-width: 100%` for this reason: fixed `12rem`/`5rem` type bleeds
    //    off both edges of a 390px viewport.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollWidth).toBeLessThanOrEqual(390)
  })
})
