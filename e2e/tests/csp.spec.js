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
  A live check, not a config assertion: whether the shipped `security.cspDirectives` default
  (`backend/base.yml`) actually works for the editor, the blocks and KaTeX cannot be established by
  reading it. `e2e/config.e2e.yml` enforces CSP for the whole suite and this spec inherits that
  shipped string rather than a copy kept here, so drift in it surfaces as a failure here.

  "No CSP violation" means both a `securitypolicyviolation` event on `document` (the reliable
  signal, fired for every directive Chromium enforces) AND no console error naming the policy, as a
  second net for whatever a future Chromium reports only to the console. Recorded via
  `page.addInitScript()`, which reattaches on every fresh document: `page.goto()`/`reload()` reset
  `window.__cspViolations`, while the SPA's client-side routing does not.

  Blocks bundling a layout/typeset engine (`block-diagram`, `block-mathjax`) are excluded: their
  `unsafe-eval` needs are an open question nobody wanted to guess a security-relevant default
  around. So are the network/iframe-dependent blocks -- a failure to reach an external service is
  not a CSP question.
*/

const CSP_CONSOLE_PATTERN = /content security policy|refused to/i

/**
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

// -> `.katex` is the class KaTeX itself draws its output under; the rest are block host elements.
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

    // -> Guards against the whole spec trivially "passing" because `enforceCsp` silently didn't
    //    take and no policy is being enforced at all.
    const loginResponse = await page.goto('/login')
    expect(loginResponse?.headers()['content-security-policy']).toBeTruthy()

    await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD)
    await expect(page.locator('.account-avbtn')).toBeVisible()

    expect(await readCspViolations(page)).toEqual([])

    const path = `csp-proof-${uniqueSlug()}`
    await createAndPublishPage(page, {
      path,
      title: 'CSP Proof',
      body: BODY,
      pasteBody: true,
      previewWaitText: SENTINEL
    })

    // -> Every block is a lazy, same-origin `/_blocks/` import: wait for each to have actually
    //    mounted before reading violations, or a slow block's own CSP failure is missed by
    //    checking too early.
    for (const selector of EXPECTED_ELEMENTS) {
      await expect(page.locator(selector).first()).toBeVisible()
    }
    expect(await readCspViolations(page)).toEqual([])
    expect(consoleCspErrors).toEqual([])

    // -> A genuine fresh load, as a reader following a link gets it -- not the SPA's own
    //    client-side transition onto the page.
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
  Per-page scripts need their own site-wide opt-in and their own page, so they get their own
  `describe`. What makes this a CSP case and not just a feature smoke test:
  `composables/pageScripts.js` never embeds the stored script text as an inline `<script>`, which
  the shipped `script-src 'self'` (no `'unsafe-inline'`) would refuse outright; it `import()`s it
  from `controllers/pageScripts.ts`'s external, same-origin `/_pages/:pageId/script.js`, which is
  exactly what `'self'` allows. A regression surfaces as a `securitypolicyviolation` on
  `script-src`.
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
      `features.pageScripts` ships off -- a scripted page injects and executes nothing until an
      administrator turns this site-wide switch on. Driven through the real `AdminGeneral.vue`
      toggle rather than seeding the flag straight into the database.
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
      The Scripts section is already offered on a page that has never been saved, because
      `pages/userPermissions` answers every page permission for an administrator whether or not the
      page exists yet.
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

    // -> Closes the Page Properties panel (`WDialog`'s Escape handler) so the editor's own "Create
    //    Page" button underneath is reachable again.
    await page.keyboard.press('Escape')

    await savePage(page, path)

    /*
      The reload is required, not incidental: `usePageScripts()` never runs a page's script while
      that page's own editor is open, so only a fresh document exercises the real external-module
      `import()` against the real enforced header.
    */
    const readerResponse = await page.reload()
    expect(readerResponse?.headers()['content-security-policy']).toBeTruthy()
    await expect(page.locator('#csp-script-proof-marker')).toHaveText('page script executed')
    expect(await readCspViolations(page)).toEqual([])
    expect(consoleCspErrors).toEqual([])
  })
})

test.describe('Content-Security-Policy (enforced) — PWA shell', () => {
  test('the service worker registers and the manifest is fetchable, with no CSP violation', async ({
    page
  }) => {
    const consoleCspErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && CSP_CONSOLE_PATTERN.test(msg.text())) {
        consoleCspErrors.push(msg.text())
      }
    })
    await installCspViolationRecorder(page)

    const response = await page.goto('/login')
    expect(response?.headers()['content-security-policy']).toBeTruthy()

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(manifestHref).toBeTruthy()

    const registration = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      return { scope: reg.scope, state: reg.active?.state, scriptURL: reg.active?.scriptURL }
    })
    expect(registration.scope).toBe(new URL('/', page.url()).href)
    expect(registration.scriptURL).toBe(new URL('/sw.js', page.url()).href)
    expect(['activating', 'activated']).toContain(registration.state)

    const worker = await page.request.get('/sw.js')
    expect(worker.status()).toBe(200)
    expect(worker.headers()['content-type']).toMatch(/javascript/)
    expect(worker.headers()['cache-control']).toContain('no-cache')
    expect(worker.headers()['service-worker-allowed']).toBe('/')

    const manifestResponse = await page.request.get(manifestHref)
    expect(manifestResponse.status()).toBe(200)
    expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json')
    const manifest = await manifestResponse.json()
    expect(manifest).toMatchObject({ start_url: '/', scope: '/', display: 'standalone' })
    expect(manifest.name).toBeTruthy()
    expect(manifest.icons.length).toBeGreaterThan(0)

    expect(await readCspViolations(page)).toEqual([])
    expect(consoleCspErrors).toEqual([])
  })
})
