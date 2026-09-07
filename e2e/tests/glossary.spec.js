import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

/**
 * OpenProject #2789: a saved glossary term produced zero rendered markup for an unlinked mention
 * (no `<abbr class="glossary-term">` at all in a rendered page), and even where markup DID survive
 * a linked term's `<a class="glossary-term">` carried no dotted underline of its own -- the generic
 * link styling turns `text-decoration` off and nothing overrode it for this class.
 *
 * Exercises the real chain end to end, per the WP's own acceptance criteria ("a new test exercises
 * the real `getCachedTerms`-to-render chain end-to-end, not just a hand-passed terms array at the
 * `MarkdownRenderer` boundary"): a term saved through the same `.../glossary/save` endpoint the
 * admin screen's "Save Glossary" button calls, a page authored and published through the real
 * Markdown editor (`editorStore.fetchConfigs()` -> `MarkdownRenderer` -> `markdown-it-glossary.js`,
 * rendered and saved client-side per `models/rendering.ts`), and the resulting page read back
 * through a real browser after a full reload -- proving the markup and the `.glossary-term` CSS this
 * task adds both survive the whole round trip, not just an in-session preview.
 *
 * The narrower "a term added mid-session, after this browser tab's editor config already loaded
 * once, still shows up in the very next editor session" regression -- the actual staleness bug this
 * task's fix addresses in `stores/editor.js` -- is covered at the unit level instead
 * (`frontend/src/stores/editor.test.js`), where the SPA-session sequencing that bug depends on can be
 * asserted directly rather than reconstructed through UI navigation.
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
    The real request the admin glossary screen's "Save Glossary" button sends
    (`AdminGlossary.vue#saveGlossary`, `POST .../glossary/save`) -- a wholesale replace of the term
    list, which is why this is the one term in it rather than an addition to whatever the seeded
    instance already carries.

    `page.evaluate()`/`fetch()`, not `page.request.post()`: this route sits behind
    `core/http/authHooks.ts`'s same-origin gate, which 403s a bare HTTP client missing a genuine
    same-origin `Origin`/`Sec-Fetch-Site` pair -- see `rtl.spec.js`'s own note on exactly this trap.
    A real in-page `fetch()` carries both, same as a genuine button click would.
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

  // -> `createAndPublishPage` leaves `page` on the new page's own URL, already rendered
  const markup = page.locator('.page-contents .glossary-term', { hasText: term })
  await expect(markup).toBeVisible()
  await expect(markup).toHaveJSProperty('tagName', 'ABBR')
  await expect(markup).toHaveAttribute('title', definition)
  await expect(markup).toHaveCSS('text-decoration-line', 'underline')
  await expect(markup).toHaveCSS('text-decoration-style', 'dotted')

  /*
    The published page's OWN stored render -- not the editor's live preview -- is what a later,
    unrelated reader visit reads (`models/rendering.ts`: "what the preview shows is what gets sent
    up and stored"). A full reload is what proves the markup survived that round trip (through
    sanitization and back) rather than only ever existing in the in-session preview DOM.
  */
  await page.reload()
  await expect(page.locator('.page-contents .glossary-term', { hasText: term })).toBeVisible()
})
