import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

/**
 * Goes straight to `/_create/markdown?path=...`, the same route the "New Page" menu reaches, rather
 * than clicking through that menu's popup -- UI this suite has no reason to also cover.
 */
test('creates, edits and publishes a page, then renders it', async ({ page }) => {
  await loginAsAdmin(page)

  const slug = uniqueSlug()
  const path = `e2e-smoke-${slug}`
  const title = `E2E Smoke Page ${slug}`
  const body = `Published by the Playwright smoke suite at ${slug}.`

  await createAndPublishPage(page, { path, title, body })

  // -> A new page defaults to `publishState: 'published'` (`pageCreate` in `stores/page.js`), so
  //    there is no separate publish step to drive: rendering here IS the publish confirmation.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title)
  await expect(page.locator('.page-contents')).toContainText(body)
})

/**
 * The skip link is the keyboard's way past every sidebar link and header control (WCAG 2.4.1,
 * Bypass Blocks): first tabbable element, visible once focused, focus into `<main>` on activation.
 * `page.goto` rather than continuing straight from `createAndPublishPage` is what gives a clean tab
 * sequence -- the editor flow leaves focus wherever saving and navigating away left it.
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

  await page.keyboard.press('Tab')
  await expect(skipLink).toBeFocused()

  // -> The link is moved off screen with `transform`, not `display: none`, so that it stays in the
  //    accessibility tree until a keyboard user reaches it.
  await expect(skipLink).toBeInViewport()

  await page.keyboard.press('Enter')
  await expect(main).toBeFocused()
})
