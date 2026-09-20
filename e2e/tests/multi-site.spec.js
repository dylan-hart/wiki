import { expect, test } from '@playwright/test'

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createAndPublishPage,
  expectAuthenticatedShell,
  expectGuestShell,
  loginAsAdmin,
  submitLogin,
  uniqueSlug
} from '../helpers/admin.js'

/**
 * What "scopes content/permissions correctly" is taken to mean here:
 *
 * - CONTENT: a page created on the default site does not exist on the new site -- each site has
 *   its own page tree (`CARDINAL.sitesMappings[hostname]`, `index.ts`).
 * - PERMISSION/session: the session cookie the default site's login sets is host-only
 *   (`fastifySession`'s `cookie` sets no `domain`), so it is never sent to the new site's hostname
 *   at all. The same admin account works there, but has to log in again.
 *
 * Sites are addressed by hostname, so the second site needs a real, resolvable one distinct from
 * the default site's catch-all (`*`). `*.localhost` resolves to the loopback address with no
 * `/etc/hosts` entry (RFC 6761, honoured by Chromium), which is what lets this test reach it by
 * just navigating.
 */
test('creates a second site and confirms it is scoped independently', async ({ page }) => {
  const slug = uniqueSlug()
  const siteHostname = `e2e-site-${slug}.localhost`
  const siteTitle = `E2E Site ${slug}`
  const siteOnlyPagePath = `e2e-site-a-only-${slug}`
  const siteOnlyBody = 'Visible only on the default site.'

  await loginAsAdmin(page)
  await createAndPublishPage(page, {
    path: siteOnlyPagePath,
    title: `Site A Only ${slug}`,
    body: siteOnlyBody
  })

  // -> Through the real admin UI rather than the REST API, so this exercises the same screen an
  //    administrator would use to stand up a new site.
  await page.goto('/_admin/sites')
  await page.getByRole('button', { name: 'New Site' }).click()
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(siteTitle)
  await page.getByRole('dialog').getByLabel('Hostname').fill(siteHostname)
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText(siteHostname)).toBeVisible()

  const port = new URL(page.url()).port
  const siteBOrigin = `http://${siteHostname}${port ? `:${port}` : ''}`

  // -> Both scoping claims off one page load. A path that isn't `/` renders the not-found
  //    placeholder inside the normal shell -- `Index.vue`'s route watcher only redirects an
  //    unauthenticated visitor to `/login` for a MISSING HOME PAGE -- so the guest-shell check
  //    below looks at a stable page instead of racing a client-side navigation.
  await page.goto(`${siteBOrigin}/${siteOnlyPagePath}`)
  await expect(page.locator('.page-placeholder')).toBeVisible()
  await expectGuestShell(page)

  // -> The same account works here, once it logs in again: a separate site, not a separate user
  //    directory.
  await page.getByRole('link', { name: 'Login' }).click()
  await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  await expectAuthenticatedShell(page)

  // -> A real, independently writable site, not just a read-only shell: write access is granted
  //    per-site rather than inherited wholesale.
  const siteBPagePath = `e2e-site-b-page-${slug}`
  const siteBBody = 'Created directly on the second site.'
  await createAndPublishPage(page, {
    path: siteBPagePath,
    title: `Site B Page ${slug}`,
    body: siteBBody,
    origin: siteBOrigin
  })
  await expect(page.locator('.page-contents')).toContainText(siteBBody)

  // -> The isolation runs both ways, not just from the older site to the new one.
  const defaultOrigin = `http://localhost${port ? `:${port}` : ''}`
  await page.goto(`${defaultOrigin}/${siteBPagePath}`)
  await expect(page.locator('.page-placeholder')).toBeVisible()
})
