import { test, expect } from '@playwright/test'

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createAndPublishPage,
  loginAsAdmin,
  openMarkdownEditor,
  savePage,
  submitLogin,
  typeBody,
  uniqueSlug
} from '../helpers/admin.js'

/*
  The shipped `security.cspDirectives` default (`backend/base.yml`) could not be confirmed workable
  by static reading alone -- the audit that asked for this spec said so explicitly
  (docs/audit-2026-08-24/security/08-frontend-client.md §10, OpenProject #2154/#2166) -- so this is a
  live check, not a config assertion. `e2e/config.e2e.yml` turns `security.enforceCsp` on for the
  whole suite (see its own comment for why not just this file), inheriting the actual shipped
  `cspDirectives` string from `base.yml` rather than a second copy kept here -- if that string ever
  drifts from what the editor/blocks/KaTeX actually need, THIS spec is what is meant to catch it, not
  a hand-maintained duplicate.

  What "no CSP violation" means here: a `securitypolicyviolation` event on `document` (the standard,
  reliable signal -- fired for every directive Chromium enforces, script-src included) AND no console
  error mentioning the policy, as a second net for whatever a future Chromium version reports only to
  the console. Recorded via `page.addInitScript()`, which reinstalls the listener on every fresh
  document (see the two separate assertion points below -- `page.goto()` starts a new document that
  resets `window.__cspViolations`; the client-side routing the rest of the SPA relies on does not
  reload the document at all, so violations accumulate across it undisturbed).

  Deliberately excludes `block-diagram` (Mermaid) and `block-mathjax`: both bundle a layout/typeset
  engine whose own `unsafe-eval` needs, if any, are a real open question this spec's author could not
  resolve by reading alone and did not want to guess a security-relevant default around. Every other
  self-contained shipped block is covered -- `block-checklist`, `block-tabs`/`block-tab`,
  `block-infobox`, `block-spoiler`, `block-qr-code`, `block-countdown`, `block-katex`,
  `block-gallery` -- alongside inline KaTeX math, deliberately omitting the network/iframe-dependent
  blocks (`block-youtube`, `block-vimeo`, `block-dailymotion`, `block-m365-video`, `block-map`,
  `block-kroki`, `block-plantuml`, `block-drawio`, `block-openapi`, `block-pdf`, `block-asciinema`,
  `block-include`, `block-index`) whose own correctness depends on an external service or another
  page this suite has no fixture for -- a network failure there is not a CSP question.
*/

const CSP_CONSOLE_PATTERN = /content security policy|refused to/i

/**
 * Installs a `securitypolicyviolation` recorder that (re)attaches on every fresh document -- see the
 * file header for why that matters across `page.goto()` boundaries.
 *
 * @param {import('@playwright/test').Page} page
 */
async function installCspViolationRecorder(page) {
  await page.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        line: e.lineNumber
      })
    })
  })
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function readCspViolations(page) {
  return page.evaluate(() => window.__cspViolations ?? [])
}

const SENTINEL = 'CSP proof sentinel paragraph'

const BODY = `# CSP Proof Page

${SENTINEL} -- this plain sentence is what the editor's debounced preview sync is waited on for,
since none of the block/math syntax below survives markdown rendering as literal text.

Inline KaTeX renders directly in prose: $E = mc^2$. A display formula follows:

$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$

::block-checklist{runkey="csp-check"}
- First step
- Second step
::

:::block-tabs
::block-tab{label="First tab"}
Content of the first tab.
::

::block-tab{label="Second tab"}
Content of the second tab.
::
:::

::block-infobox{name="Montreal" image="https://example.com/photo.jpg"}
\`\`\`yaml
City: Montreal
Country: Canada
Public Transport:
  Metro: true
  Bus: true
\`\`\`
::

::block-spoiler{label="Reveal" hint="Click to show content"}
The content to hide.
::

::block-qr-code{value="https://example.com" caption="QR"}
::

::block-countdown{date="2030-01-01T00:00" label="New Year"}
::

::block-katex
\`\`\`latex
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
\`\`\`
::

::block-gallery
https://example.com/photo-1.jpg
https://example.com/photo-2.jpg
::
`

// -> One host element per block used above, plus the two inline KaTeX renders (`.katex` is the
//    class KaTeX itself draws its output under -- both the inline and display formula get one).
const EXPECTED_ELEMENTS = [
  'block-checklist',
  'block-tabs',
  'block-tab',
  'block-infobox',
  'block-spoiler',
  'block-qr-code',
  'block-countdown',
  'block-katex',
  'block-gallery',
  '.katex'
]

test.describe('Content-Security-Policy (enforced)', () => {
  test('editor session, every self-contained block, and KaTeX render with no CSP violation', async ({
    page
  }) => {
    const consoleCspErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && CSP_CONSOLE_PATTERN.test(msg.text())) {
        consoleCspErrors.push(msg.text())
      }
    })

    await installCspViolationRecorder(page)

    // -> Proves the suite is actually exercising an enforced policy, not trivially "passing" because
    //    `enforceCsp`/`cspDirectives` silently didn't take (e.g. the DB-seed wiring in
    //    `models/settings.ts` regressing back to a hardcoded, always-off literal).
    const loginResponse = await page.goto('/login')
    expect(loginResponse?.headers()['content-security-policy']).toBeTruthy()

    await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD)
    await expect(page.locator('.account-avbtn')).toBeVisible()

    // -> First checkpoint: the login flow alone, on the document `page.goto('/login')` started.
    expect(await readCspViolations(page)).toEqual([])

    const path = `csp-proof-${uniqueSlug()}`
    await createAndPublishPage(page, {
      path,
      title: 'CSP Proof',
      body: BODY,
      pasteBody: true,
      previewWaitText: SENTINEL
    })

    // -> `createAndPublishPage`'s own `/_create/markdown` navigation started a new document (which
    //    reset `window.__cspViolations`), and everything since -- Monaco mounting and syncing, the
    //    preview rendering every block and both KaTeX formulas, saving, and the client-side route
    //    replace onto the page's own URL (no further `goto()`) -- happened on that one document. Wait
    //    for every block to have actually mounted (each is a lazy, same-origin `/_blocks/` import)
    //    before reading violations, so a slow-to-load block's own CSP failure isn't missed by
    //    checking too early.
    for (const selector of EXPECTED_ELEMENTS) {
      await expect(page.locator(selector).first()).toBeVisible()
    }
    expect(await readCspViolations(page)).toEqual([])
    expect(consoleCspErrors).toEqual([])

    // -> Second checkpoint: a genuine fresh load of the published page, same as any reader following
    //    a link to it -- not just the SPA's own client-side transition onto it. `page.reload()`
    //    starts a new document too, so this checks only this reload's own violations.
    const readerResponse = await page.reload()
    expect(readerResponse?.headers()['content-security-policy']).toBeTruthy()
    for (const selector of EXPECTED_ELEMENTS) {
      await expect(page.locator(selector).first()).toBeVisible()
    }
    expect(await readCspViolations(page)).toEqual([])
    expect(consoleCspErrors).toEqual([])
  })
})

/*
  Feature #3389/OpenProject #3406: per-page scripts are the one case the suite above deliberately
  never exercises (`BODY` contains no `scriptJsLoad`/`scriptJsUnload`) -- proving them CSP-clean
  needs its own site-wide opt-in and its own page, so it gets its own `describe`. What makes this a
  real CSP case and not just a feature smoke test: `composables/pageScripts.js` never embeds the
  stored script text as an inline `<script>` (which the shipped `script-src 'self'` -- no
  `'unsafe-inline'` -- would refuse outright); it `import()`s it from `controllers/pageScripts.ts`'s
  external, same-origin `/_pages/:pageId/script.js`, which is exactly what `'self'` allows. A CSP
  regression here would surface as a `securitypolicyviolation` on `script-src`, caught the same way
  the suite above catches one on any block.
*/
test.describe('Content-Security-Policy (enforced) — per-page scripts', () => {
  test('a scripted page runs its load script via the external module, with no CSP violation', async ({
    page
  }) => {
    const consoleCspErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && CSP_CONSOLE_PATTERN.test(msg.text())) {
        consoleCspErrors.push(msg.text())
      }
    })
    await installCspViolationRecorder(page)

    await loginAsAdmin(page)

    /*
      `features.pageScripts` ships off (Task #3403) -- a scripted page injects/executes nothing at
      all until an administrator turns this site-wide switch on. Driven through the real
      `AdminGeneral.vue` "Allow Page Scripts and Styles" toggle and its "Apply" button, the same
      flow an administrator would use, rather than seeding the flag straight into the database.
    */
    await page.goto('/_admin/sites')
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await expect(page).toHaveURL(/\/_admin\/[^/]+\/general$/)
    await page.getByRole('switch', { name: 'Allow Page Scripts and Styles' }).click()
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page.locator('.w-notification').last()).toContainText(
      'Site configuration saved successfully.'
    )

    const path = `csp-script-proof-${uniqueSlug()}`
    const sentinel = 'CSP script proof sentinel paragraph'
    await openMarkdownEditor(page, { path, title: 'CSP Script Proof' })
    await typeBody(page, `# CSP Script Proof\n\n${sentinel}\n`, { previewWaitText: sentinel })

    /*
      `write:scripts` on a page being authored for the first time: `pages/userPermissions` answers
      every page permission for an administrator regardless of whether the page has ever been saved
      (`backend/api/pages/read.ts`'s own doc comment on that route), so `PagePropertiesDialog.vue`'s
      Scripts section is offered here already.
    */
    await page.getByRole('button', { name: 'Page Properties' }).click()
    await page.getByRole('button', { name: 'Javascript - On Load' }).click()

    const scriptsDialog = page.locator('.page-scripts-dialog')
    await scriptsDialog
      .getByLabel('Javascript')
      .fill(
        [
          "const el = document.createElement('div')",
          "el.id = 'csp-script-proof-marker'",
          "el.textContent = 'page script executed'",
          'document.body.appendChild(el)'
        ].join('\n')
      )
    await scriptsDialog.getByRole('button', { name: 'Save', exact: true }).click()

    // -> Closes the Page Properties side panel so the editor's own "Create Page" button underneath
    //    is reachable again -- `WDialog`'s own Escape handler, the same one `permissions.spec.js`
    //    relies on for a non-persistent dialog.
    await page.keyboard.press('Escape')

    await savePage(page, path)

    /*
      A genuine fresh load, the same reader-following-a-link checkpoint the suite above uses:
      `usePageScripts()` never runs a page's script while its own editor is still open
      (`showing` in `composables/pageScripts.js`), and `page.reload()` starts a new document, so this
      is the real external-module `import()` -- and the real enforced CSP header -- doing the work,
      not a leftover of the editor session above.
    */
    const readerResponse = await page.reload()
    expect(readerResponse?.headers()['content-security-policy']).toBeTruthy()
    await expect(page.locator('#csp-script-proof-marker')).toHaveText('page script executed')
    expect(await readCspViolations(page)).toEqual([])
    expect(consoleCspErrors).toEqual([])
  })
})
