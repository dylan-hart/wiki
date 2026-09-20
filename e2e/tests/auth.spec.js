import { expect, test } from '@playwright/test'

import { expectAuthenticatedShell, expectGuestShell, loginAsAdmin } from '../helpers/admin.js'

test.describe('login', () => {
  test('shows the guest shell before logging in', async ({ page }) => {
    // -> Not `/`: a brand new site has no home page, and `Index.vue`'s route watcher sends an
    //    unauthenticated visitor straight to `/login` in that one case. Any other unknown path
    //    renders the ordinary not-found placeholder inside the normal shell.
    await page.goto('/e2e-guest-shell-check')
    await expectGuestShell(page)
  })

  test('logs in as the default admin and renders the authenticated shell', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/')
    await expectAuthenticatedShell(page)

    // -> The gear that opens `/_admin` renders only for `access:admin` (`HeaderNav.vue`). Visited
    //    directly rather than clicked: on a pageless wiki the home route shows
    //    `WelcomeOverlay.vue`'s full-screen prompt over the header.
    await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible()
    await page.goto('/_admin')
    await expect(page).toHaveURL(/\/_admin\/dashboard$/)
  })
})
