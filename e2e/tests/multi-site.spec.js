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
 * Flow 3 (feature 424 / task 761): multi-site switching. The one flow the task calls out as having
 * no 2.5.x precedent, so what "scopes content/permissions correctly" means is established here
 * rather than ported from an existing spec:
 *
 * - CONTENT scoping: a page created on the default site does not exist on the new site -- each
 *   site has its own page tree (`WIKI.sitesMappings[hostname]`, `index.ts`).
 * - PERMISSION/session scoping: the session cookie the login on the default site sets is host-only
 *   (`fastifySession`'s `cookie` in `index.ts` sets no `domain`), so it is not sent to the new
 *   site's hostname at all -- landing there shows the guest shell, not the still-logged-in admin.
 *   The same admin account still works there, but has to log in again: a real, verifiable
 *   consequence of sites being scoped independently, not a login the reader carries with them.
 *
 * Sites are addressed by hostname (`WIKI.sitesMappings`), so the second site needs a real,
 * resolvable one distinct from the default site's catch-all (`*`). `*.localhost` resolves to the
 * loopback address without any `/etc/hosts` entry -- RFC 6761, and honoured by every major
 * resolver and by Chromium itself -- which is what lets this test reach it by just navigating.
 */
test('creates a second site and confirms it is scoped independently', async ({ page }) => {
  const slug = uniqueSlug()
  const siteHostname = `e2e-site-${slug}.localhost`
  const siteTitle = `E2E Site ${slug}`
  const siteOnlyPagePath = `e2e-site-a-only-${slug}`
  const siteOnlyBody = 'Visible only on the default site.'

  // -> A page that exists ONLY on the default site, to prove against below.
  await loginAsAdmin(page)
  await createAndPublishPage(page, {
    path: siteOnlyPagePath,
    title: `Site A Only ${slug}`,
    body: siteOnlyBody
  })

  // -> Create the second site through the real admin UI (`AdminSites.vue` / `SiteCreateDialog.vue`)
  //    rather than the REST API directly, so this flow exercises the same screen an administrator
  //    would actually use to stand up a new site.
  await page.goto('/_admin/sites')
  await page.getByRole('button', { name: 'New Site' }).click()
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(siteTitle)
  await page.getByRole('dialog').getByLabel('Hostname').fill(siteHostname)
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText(siteHostname)).toBeVisible()

  const port = new URL(page.url()).port
  const siteBOrigin = `http://${siteHostname}${port ? `:${port}` : ''}`

  // -> CONTENT scoping (the new site has its own, empty page tree) and PERMISSION/session scoping
  //    (the admin session from the default site does not carry over -- a host-only cookie was
  //    never sent on a request to this hostname at all) confirmed by the same page load: a path
  //    that isn't `/` renders the ordinary not-found placeholder inside the normal shell rather
  //    than redirecting anywhere (`Index.vue`'s route watcher only redirects an unauthenticated
  //    visitor to `/login` for a MISSING HOME PAGE specifically), so the guest-shell check below
  //    is looking at a stable page rather than racing a client-side navigation.
  await page.goto(`${siteBOrigin}/${siteOnlyPagePath}`)
  await expect(page.locator('.page-placeholder')).toBeVisible()
  await expectGuestShell(page)

  // -> The same account works here too, once it logs in again -- a separate site, not a separate
  //    user directory.
  await page.getByRole('link', { name: 'Login' }).click()
  await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  await expectAuthenticatedShell(page)

  // -> And is a real, independently writable site, not just a read-only shell: create a page here
  //    too, confirming write access is granted per-site rather than inherited wholesale.
  const siteBPagePath = `e2e-site-b-page-${slug}`
  const siteBBody = 'Created directly on the second site.'
  await createAndPublishPage(page, {
    path: siteBPagePath,
    title: `Site B Page ${slug}`,
    body: siteBBody,
    origin: siteBOrigin
  })
  await expect(page.locator('.page-contents')).toContainText(siteBBody)

  // -> And that page is, symmetrically, invisible back on the default site -- the isolation runs
  //    both ways, not just from the older site to the new one.
  const defaultOrigin = `http://localhost${port ? `:${port}` : ''}`
  await page.goto(`${defaultOrigin}/${siteBPagePath}`)
  await expect(page.locator('.page-placeholder')).toBeVisible()
})
