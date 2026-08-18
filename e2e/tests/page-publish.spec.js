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
  // -> `.page-header-title` rather than `getByRole('heading', ...)`: the read view renders the
  //    title into a styled `<span>` (`PageHeader.vue`), not an `<h1>`-`<h6>`, so it carries no
  //    heading role to query against.
  await expect(page.locator('.page-header-title')).toContainText(title)
  await expect(page.locator('.page-contents')).toContainText(body)
})
