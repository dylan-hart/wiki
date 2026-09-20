import { expect } from '@playwright/test'

import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../playwright.config.js'

export { ADMIN_EMAIL, ADMIN_PASSWORD }

/**
 * A collision-resistant suffix for paths and hostnames a spec creates, so re-running against a
 * database that still holds a previous run's pages and sites doesn't collide with them. Time-based
 * rather than random: readable in a failure trace, and unique enough for a one-worker suite.
 */
export function uniqueSlug() {
  return Date.now().toString(36)
}

/**
 * `.account-avbtn` (`AccountMenu.vue`) renders only above `HeaderNav.vue`'s 900px
 * `isActionsCollapsed` breakpoint; below it those buttons fold into `HeaderActionsMenu.vue`'s "More
 * Actions" dropdown instead. The two are mutually exclusive, so waiting on either is a
 * viewport-agnostic signal that the authenticated header rendered -- a bare `.account-avbtn` wait
 * times out outright under a sub-900px `test.use({ viewport })`.
 */
function authenticatedShellMarker(page) {
  return page.locator('.account-avbtn').or(page.getByRole('button', { name: 'More Actions' }))
}

/**
 * Longer than the suite's global 5s `expect.timeout`, because a successful login is never a router
 * push: `AuthLoginPanel.vue`'s `handleLoginResponse` burns a fixed `EXIT_FLOURISH_MS` on the exit
 * animation (unless `prefers-reduced-motion`) and then does a real `window.location.replace()` --
 * asset fetch, JS boot, another `bootstrap` fetch, mount. CI load pushes that past 5s.
 */
const AUTHENTICATED_SHELL_TIMEOUT = 15_000

/**
 * Submits the form already on screen, for a login somewhere other than a fresh `/login` visit. It
 * asserts nothing on purpose: the caller's own next assertion is what proves the login worked.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} email
 * @param {string} password
 */
export async function submitLogin(page, email, password) {
  await page.getByLabel('Email Address').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log In', exact: true }).click()
}

/**
 * Drives the real login form rather than seeding a session cookie, so every spec that needs an
 * authenticated admin exercises the same login path `auth.spec.js` asserts on.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function loginAsAdmin(page) {
  await page.goto('/login')
  await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  await expect(authenticatedShellMarker(page)).toBeVisible({ timeout: AUTHENTICATED_SHELL_TIMEOUT })
}

/**
 * @param {import('@playwright/test').Page} page
 */
export async function expectAuthenticatedShell(page) {
  await expect(authenticatedShellMarker(page)).toBeVisible({ timeout: AUTHENTICATED_SHELL_TIMEOUT })
  await expect(page.getByRole('link', { name: 'Login' })).toHaveCount(0)
}

/**
 * @param {import('@playwright/test').Page} page
 */
export async function expectGuestShell(page) {
  await expect(page.getByRole('link', { name: 'Login' })).toBeVisible()
  await expect(page.locator('.account-avbtn')).toHaveCount(0)
}

/**
 * Leaves the caret in the body editor, ready to be typed into.
 *
 * `origin` makes the create-page navigation absolute, which a second site needs: a bare
 * `page.goto('/_create/...')` resolves against `playwright.config.js`'s `baseURL` whatever origin
 * `page` is currently showing, silently creating the page back on the default site.
 *
 * `locale` creates the page under that content locale instead of the site's default (the
 * `/_create` route reads it straight off `?locale=`).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ path: string, title: string, origin?: string, locale?: string }} args
 */
export async function openMarkdownEditor(page, { path, title, origin = '', locale }) {
  const localeQuery = locale ? `&locale=${locale}` : ''
  await page.goto(`${origin}/_create/markdown?path=${path}${localeQuery}`)

  // -> The title is a `contenteditable="plaintext-only"` span (`PageHeader.vue`), not an <input>;
  //    its `aria-label="Title"` is what gives it an accessible textbox role for `getByLabel`.
  //    Driven with real keystrokes rather than `.fill()`, which sets `textContent` directly and
  //    fires one synthetic `input` event this non-standard value handles inconsistently under
  //    load. The blur is load-bearing: it commits the field's tidied value (`onEditableBlur`).
  const titleField = page.getByLabel('Title', { exact: true })
  await titleField.click()
  await page.keyboard.type(title)
  await titleField.blur()

  // -> Monaco mounts into `.editor-markdown-editor` asynchronously (a lazy chunk), and clicking
  //    the container before it has rendered its own focusable surface is a click with nothing to
  //    focus: the keystrokes then land wherever focus already was.
  await page.locator('.editor-markdown-editor .monaco-editor').waitFor()
  await page.locator('.editor-markdown-editor').click()
}

/**
 * The markdown editor must already hold focus -- `openMarkdownEditor` leaves it that way.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} body
 * @param {{ paste?: boolean, previewWaitText?: string }} [options]
 */
export async function typeBody(page, body, { paste = false, previewWaitText = body } = {}) {
  if (paste) {
    /*
      A REAL clipboard paste, not `page.keyboard.insertText()`: `insertText` fires a raw DOM `input`
      event that Monaco's `TextAreaInput` runs through its ordinary typed-input/auto-indent pipeline
      (`autoIndent: 'full'`, the app's untouched default), not its clipboard-paste handling. For a
      multi-line body with an indented line inside a fenced code block, that pipeline's per-newline
      indent computation mis-fires partway through and re-indents every following line, cascading to
      the end of the document; once a `::block-x{...}` opener sits at 4+ spaces, CommonMark/MDC
      parses it as an indented code block and the custom element never renders at all.
      Per-character typing has its own hazard -- Monaco's auto-closing of brackets, quotes and
      backticks, which MDC attribute lists and fences are built out of.

      Opt-in rather than the default: typing is what an author actually does, and plain prose has
      no brackets, backticks or indentation for either path to misfire on.
    */
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate((text) => navigator.clipboard.writeText(text), body)
    await page.keyboard.press('ControlOrMeta+V')
  } else {
    await page.keyboard.type(body)
  }

  // -> `EditorMarkdown.vue` syncs Monaco's content into `pageStore.content` on a debounce
  //    (`onDidChangeModelContent`); saving before it fires stores an empty page, and the debounced
  //    render landing in the DOM is the real signal that the sync happened. `previewWaitText`
  //    defaults to the raw `body`, which appears verbatim only for plain prose -- a caller writing
  //    MDC blocks or KaTeX passes a plain-text sentinel found elsewhere in `body`.
  await expect(page.locator('.editor-markdown-preview-content')).toContainText(previewWaitText)
}

/**
 * `locale` must match whatever `openMarkdownEditor` was given: a page's real URL comes out
 * locale-prefixed whenever that locale isn't the site's primary (`localizedPagePath` in
 * `helpers/pagePaths.js`), so the URL assertion below expects that prefix too.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {{ locale?: string }} [options]
 */
export async function savePage(page, path, { locale } = {}) {
  await page.getByRole('button', { name: 'Create Page' }).click()

  // -> The save dialog's path field auto-slugs from the title on every keystroke until the field
  //    itself is focused (`TreeBrowserDialog.vue`'s `onPathFocus` sets `pathDirty`), so filling it
  //    explicitly is what stops the page being saved under a title-derived path instead.
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Path Name').fill(path)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()

  const expectedPath = locale ? `${locale}/${path}` : path
  await expect(page).toHaveURL(new RegExp(`/${expectedPath}$`))
}

/**
 * Nothing but the three steps above, in order: a spec needing to do something between two of them
 * calls them directly rather than re-inlining their handling.
 *
 * Leaves `page` on the new page's own URL, rendered -- not the editor.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ path: string, title: string, body: string, origin?: string, pasteBody?: boolean, previewWaitText?: string, locale?: string }} args
 */
export async function createAndPublishPage(
  page,
  { path, title, body, origin = '', pasteBody = false, previewWaitText = body, locale }
) {
  await openMarkdownEditor(page, { path, title, origin, locale })
  await typeBody(page, body, { paste: pasteBody, previewWaitText })
  await savePage(page, path, { locale })
}
