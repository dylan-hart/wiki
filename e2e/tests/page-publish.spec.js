import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

/**
 * Flow 2 (feature 424 / task 761): create a page, edit it in an editor mode, publish it, and
 * confirm the rendered output.
 *
 * Drives the markdown editor specifically -- "at least one editor mode" per the task -- via
 * `/_create/markdown?path=...`, the same route `pageStore.pageCreate` reacts to when reached by
 * clicking through the "New Page" menu (`Index.vue`'s route watcher). Going straight there sidesteps
 * that menu's own popup, which is UI this suite has no reason to also be a regression test for.
 */
test('creates, edits and publishes a page, then renders it', async ({ page }) => {
  await loginAsAdmin(page)

  const slug = uniqueSlug()
  const path = `e2e-smoke-${slug}`
  const title = `E2E Smoke Page ${slug}`
  const body = `Published by the Playwright smoke suite at ${slug}.`

  await createAndPublishPage(page, { path, title, body })

  // -> Newly created pages default to `publishState: 'published'` (`pageCreate` in
  //    `stores/page.js`) -- there is no separate "publish" step to drive, so rendering here IS the
  //    publish confirmation the task asks for.
  // -> `getByRole('heading', { level: 1 })` since OpenProject #1630/task 1633: the read view's
  //    title used to be a plain `<div class="text-h4 page-header-title">` with no heading role at
  //    all, which is why this used to query `.page-header-title` by class instead -- it is a real
  //    `<h1>` now, so this asserts against that directly.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title)
  await expect(page.locator('.page-contents')).toContainText(body)
})

/**
 * OpenProject #1630 (task 1644): the skip link is the way past every sidebar link and header
 * control on a keyboard (WCAG 2.4.1, Bypass Blocks) -- it must be the very first tabbable element
 * on a reading page, become visible once it holds focus, and move focus into the page's own
 * `<main>` when activated. `page.goto` (rather than continuing straight from `createAndPublishPage`)
 * is what gives this a clean tab sequence to test: the editor flow leaves focus wherever saving and
 * navigating away left it, not at the top of the document.
 */
test('offers a skip link as the first tabbable element, which jumps focus into the page content', async ({
  page
}) => {
  await loginAsAdmin(page)

  const slug = uniqueSlug()
  const path = `e2e-skip-link-${slug}`
  const title = `E2E Skip Link Page ${slug}`
  await createAndPublishPage(page, { path, title, body: 'Skip link target content.' })

  await page.goto(`/${path}`)

  const skipLink = page.getByRole('link', { name: 'Skip to main content' })
  const main = page.locator('#w-page-main')

  await expect(skipLink).toBeAttached()

  // -> Tabbing once from a fresh load must land on the skip link before anything else in the
  //    header or sidebar -- the WCAG 2.4.1 requirement itself, not just that the link exists.
  await page.keyboard.press('Tab')
  await expect(skipLink).toBeFocused()

  // -> Visible only once it holds focus: `transform: translateY(-150%)` keeps it off a sighted
  //    keyboard user's screen until they reach it, without pulling it out of the accessibility
  //    tree the way `display: none` would.
  await expect(skipLink).toBeInViewport()

  await page.keyboard.press('Enter')
  await expect(main).toBeFocused()
})
