import { expect, test } from '@playwright/test'

import { createAndPublishPage, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

/**
 * WP #2166 (part of #2154): the `cspDirectives` default shipped in `backend/base.yml` /
 * `backend/models/settings.ts#init` is authored to cover the editor (Monaco), the blocks loader
 * (a same-origin dynamic `import()`) and KaTeX -- but the audit that asked for this WP could not
 * confirm any of that statically ("the audit could not confirm a workable policy statically, so a
 * live check is the deliverable"). This spec IS that check: it collects every
 * `securitypolicyviolation` event and every "Refused to ..." CSP console message the browser raises
 * across a full editor session, a published page carrying a block, and a KaTeX expression, and
 * fails if there are any.
 *
 * Runs with `enforceCsp` ON, against the exact string this WP ships: `e2e/config.e2e.yml`'s
 * `security:` block sets both, which land in the fresh test database's `security` settings row via
 * `models/settings.ts#init` on this suite's very first boot -- there is no live-reload path,
 * `index.ts` reads `WIKI.config.security` once, at server start, to decide whether to register
 * helmet's CSP plugin at all, so the policy really is on for every spec in this run, not just this
 * one file.
 */

/**
 * Attaches a collector for every CSP violation `page` sees, from this call onward, across
 * navigations (`addInitScript` re-runs on every new document in the same browser context). Returns
 * a function that reads back everything collected so far.
 *
 * Two channels, because a browser doesn't report every kind of CSP failure the same way: an actual
 * blocked resource load (script/style/img/connect/worker/...) fires a real
 * `securitypolicyviolation` DOM event with structured detail, while some engines are inconsistent
 * about routing every blocked case through that event and always echo a "Refused to ..." message to
 * the console regardless -- watching both is what makes this a real live check rather than one that
 * could pass with a genuine violation the first channel alone missed.
 *
 * @param {import('@playwright/test').Page} page
 */
async function collectCspViolations(page) {
  const violations = []

  page.on('console', (msg) => {
    const text = msg.text()
    if (/content security policy|refused to/i.test(text)) {
      violations.push(`console: ${text}`)
    }
  })

  await page.exposeFunction('__reportCspViolation', (detail) => {
    violations.push(`securitypolicyviolation: ${detail}`)
  })
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      // -> `window.__reportCspViolation` is bound by `page.exposeFunction` above, before this init
      //    script is registered -- Playwright guarantees the binding exists in every new document
      //    this script itself runs in.
      window.__reportCspViolation(
        `${event.violatedDirective} blocked "${event.blockedURI}" on ${location.pathname}`
      )
    })
  })

  return () => violations
}

test('editor, a block and a KaTeX expression all load clean under the enforced CSP', async ({
  page
}) => {
  const getViolations = await collectCspViolations(page)

  await loginAsAdmin(page)

  const slug = uniqueSlug()
  const path = `e2e-csp-${slug}`
  const title = `E2E CSP Page ${slug}`
  const body = [
    'A KaTeX expression: $E = mc^2$',
    '',
    '::block-checklist',
    '- Verify the shipped CSP default',
    '- Confirm no directive was violated',
    '::'
  ].join('\n')

  // -> `createAndPublishPage` itself already exercises the editor-session half of this spec:
  //    Monaco mounts (`worker-src`), the body is typed in, and the preview pane re-renders it
  //    (`script-src`/`style-src` for the app's own same-origin bundle) before the save round-trips.
  await createAndPublishPage(page, { path, title, body })

  // -> The published render: `block-checklist` resolves through the dynamic, same-origin
  //    `import()` that `commonStore.loadBlocks()` performs (`script-src 'self'`) and actually
  //    upgrades past `:not(:defined)` into a real custom element -- proving the blocks loader
  //    works under the policy, not just that the tag text made it into the markup.
  const checklist = page.locator('block-checklist')
  await expect(checklist).toBeVisible()
  await expect
    .poll(() => checklist.evaluate((el) => customElements.get(el.tagName.toLowerCase()) != null))
    .toBe(true)

  // -> KaTeX renders every formula as a tree of inline `style="..."` attributes
  //    (`frontend/src/renderers/markdown.js`'s `texMathHtml`) -- these are checked against
  //    `style-src` the same as an external stylesheet would be, so a missing `'unsafe-inline'`
  //    there shows up here as a collected violation, not a silent layout failure.
  await expect(page.locator('.katex')).toBeVisible()

  // -> Re-open the editor on the same page: `EditorMarkdown.vue`'s Monaco instance spins up its
  //    language-service workers again on this fresh navigation (`worker-src 'self' blob:`), a
  //    second, independent exercise of that directive beyond the create flow above.
  await page.goto(`/_edit/${path}`)
  await page.locator('.editor-markdown-editor .monaco-editor').waitFor()

  expect(getViolations(), 'expected no CSP violation across the editor/block/KaTeX flows').toEqual(
    []
  )
})
