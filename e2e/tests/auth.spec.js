import { expect, test } from '@playwright/test'

import { expectAuthenticatedShell, expectGuestShell, loginAsAdmin } from '../helpers/admin.js'

/**
 * Flow 1 (feature 424 / task 761): log in with the default local-auth admin account and confirm
 * the authenticated shell renders.
 */
test.describe('login', () => {
  test('shows the guest shell before logging in', async ({ page }) => {
    // -> Not `/`: a brand new site has no home page yet, and `Index.vue`'s route watcher sends an
    //    unauthenticated visitor straight to `/login` in that specific case -- real behaviour, but
    //    not what this test is after (`multi-site.spec.js` picks a stable not-found page for the
    //    same reason, rather than racing that redirect). Any other unknown path renders the
    //    ordinary "page not found" placeholder inside the normal shell instead.
    await page.goto('/e2e-guest-shell-check')
    await expectGuestShell(page)
  })

  test('logs in as the default admin and renders the authenticated shell', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/')
    await expectAuthenticatedShell(page)

    // -> `access:admin` is part of what a successful login actually grants here: the gear icon
    //    that opens `/_admin` only renders for it (`HeaderNav.vue`). Asserted by visiting the
    //    route directly rather than clicking the icon -- a fresh, pageless wiki's home route shows
    //    `WelcomeOverlay.vue`'s full-screen "create your home page" prompt over the header, which
    //    is real first-run behaviour this suite has no reason to fight through just to click a gear
    //    icon it can otherwise reach in one line.
    await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible()
    await page.goto('/_admin')
    await expect(page).toHaveURL(/\/_admin\/dashboard$/)
  })
})
