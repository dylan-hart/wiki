import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

/**
 * The whole chain rather than the `MarkdownRenderer` boundary: a term saved through the real
 * `.../glossary/save` endpoint, a page authored and published through the real editor, and the
 * result read back after a full reload -- markup and `.glossary-term` styling both have to survive
 * that round trip, not just an in-session preview.
 */
test('a saved glossary term renders with its markup and dotted underline', async ({ page }) => {
  await loginAsAdmin(page)

  const slug = uniqueSlug().replace(/-/g, '')
  const term = `Cardinalglossaryterm${slug}`
  const definition = `A term added by the Playwright glossary suite (${slug}).`

  const siteId = await page.evaluate(async () => {
    const res = await fetch('/_api/sites/current')
    const site = await res.json()
    return site.id
  })

  /*
    `POST .../glossary/save` is a wholesale replace of the term list, which is why this sends the
    one term rather than adding to whatever the seeded instance already carries.

    `page.evaluate()`/`fetch()`, not `page.request.post()`: the route sits behind
    `core/http/authHooks.ts`'s same-origin gate, which 403s a bare HTTP client missing a genuine
    `Origin`/`Sec-Fetch-Site` pair. An in-page `fetch()` carries both, as a button click would.
  */
  const saved = await page.evaluate(
    async ({ siteId, term, definition }) => {
      const res = await fetch(`/_api/sites/${siteId}/glossary/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms: [{ term, definition }] })
      })
      return res.ok
    },
    { siteId, term, definition }
  )
  expect(saved).toBe(true)

  const pageSlug = uniqueSlug()
  const path = `e2e-glossary-${pageSlug}`
  const title = `E2E Glossary Page ${pageSlug}`
  await createAndPublishPage(page, {
    path,
    title,
    body: `This page mentions ${term} once, unlinked, in its body.`
  })

  const markup = page.locator('.page-contents .glossary-term', { hasText: term })
  await expect(markup).toBeVisible()
  await expect(markup).toHaveJSProperty('tagName', 'ABBR')
  await expect(markup).toHaveAttribute('title', definition)
  await expect(markup).toHaveCSS('text-decoration-line', 'underline')
  await expect(markup).toHaveCSS('text-decoration-style', 'dotted')

  /*
    A reader visit reads the page's OWN stored render, not the editor's live preview, so only a
    full reload proves the markup survived the save round trip through sanitization rather than
    only ever existing in the in-session preview DOM.
  */
  await page.reload()
  await expect(page.locator('.page-contents .glossary-term', { hasText: term })).toBeVisible()
})
