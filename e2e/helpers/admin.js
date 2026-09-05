import { expect } from '@playwright/test'

import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../playwright.config.js'

export { ADMIN_EMAIL, ADMIN_PASSWORD }

/**
 * A short, collision-resistant suffix for path/hostname values a spec creates -- so re-running the
 * suite against a database that already has last run's pages and sites in it (anything short of a
 * brand new container) doesn't collide with them. Time-based rather than random: readable in a
 * failure screenshot/trace, and still unique enough for a suite that runs one worker at a time.
 */
export function uniqueSlug() {
  return Date.now().toString(36)
}

/**
 * `.account-avbtn` (`AccountMenu.vue`) only renders above `HeaderNav.vue`'s 900px
 * `isActionsCollapsed` breakpoint -- below it, the account/admin/notification buttons it would
 * otherwise show are folded into `HeaderActionsMenu.vue`'s "More Actions" dropdown instead, whose
 * trigger (`aria-label="common.header.moreActions"`) is what actually renders there. The two
 * breakpoints are mutually exclusive, so waiting on either is a correct, viewport-agnostic signal
 * that the authenticated header has rendered -- unlike a bare `.account-avbtn` wait, which
 * `viewport-narrow.spec.js`'s sub-900px `test.use({ viewport })` timed out on outright (task 2114).
 */
function authenticatedShellMarker(page) {
  return page.locator('.account-avbtn').or(page.getByRole('button', { name: 'More Actions' }))
}

/**
 * Fills the login form already on screen and submits it -- no navigation, and no assertion about
 * what comes back. Split out from `loginAsAdmin` because three specs sign in somewhere other than a
 * fresh `/login` visit (a second site's hostname reached through its own "Login" link, a second
 * browser context for a non-admin account, a `page.goto('/login')` whose RESPONSE the caller wants
 * to assert on first) and each had re-typed these three lines for itself (BLK-F6).
 *
 * What proves the login worked is the caller's own next assertion -- `expectAuthenticatedShell`,
 * or something more specific -- which is why there is none here.
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
 * Flow 1's login, factored out because flow 2 and flow 3 both need an authenticated admin before
 * their own flow starts. Drives the real login form -- see `AuthLoginPanel.vue` -- rather than
 * seeding a session cookie directly, so every spec exercises the same login path flow 1 asserts on.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function loginAsAdmin(page) {
  await page.goto('/login')
  await submitLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  await expect(authenticatedShellMarker(page)).toBeVisible()
}

/**
 * Asserts the authenticated shell is on screen: the account menu button that only renders for
 * `userStore.authenticated` (`HeaderNav.vue`), and no "Login" link standing in for it.
 *
 * Through `authenticatedShellMarker` rather than a bare `.account-avbtn`, for the viewport reason
 * that helper's own comment gives -- `loginAsAdmin` already waited on the marker, and this assertion
 * disagreeing with it below 900px was exactly the trap task 2114 hit.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function expectAuthenticatedShell(page) {
  await expect(authenticatedShellMarker(page)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Login' })).toHaveCount(0)
}

/**
 * Asserts the page shows the guest/logged-out shell: a "Login" link, and no account menu.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function expectGuestShell(page) {
  await expect(page.getByRole('link', { name: 'Login' })).toBeVisible()
  await expect(page.locator('.account-avbtn')).toHaveCount(0)
}

/**
 * Opens the markdown editor on a new page at `path`, names it `title`, and leaves the caret in the
 * body editor ready to be typed into.
 *
 * The first of the three steps `createAndPublishPage` is built out of. Split out because
 * `assets.spec.js` has to interleave a File Manager round trip between typing the body and saving,
 * which the whole-flow helper has no hook for -- so it had re-narrated the title-field and
 * Monaco-mount handling for itself (BLK-F6).
 *
 * `origin`, when given, makes the create-page navigation absolute -- required for
 * `multi-site.spec.js`'s second site, whose hostname differs from `playwright.config.js`'s
 * `baseURL`: a bare `page.goto('/_create/...')` resolves against that `baseURL` regardless of
 * which origin `page` is currently showing, which would silently create the page back on the
 * default site instead of the one this call is meant to be exercising.
 *
 * `locale`, when given, creates the page under that content locale instead of the site's default
 * (`pages/Index.vue`'s `/_create` route reads it straight off `?locale=`, per `stores/page.js`'s
 * `pageCreate`) -- for `rtl.spec.js`'s content-vs-interface-locale cases, which need a page whose
 * own locale differs from the interface locale rather than one at the site's primary.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ path: string, title: string, origin?: string, locale?: string }} args
 */
export async function openMarkdownEditor(page, { path, title, origin = '', locale }) {
  const localeQuery = locale ? `&locale=${locale}` : ''
  await page.goto(`${origin}/_create/markdown?path=${path}${localeQuery}`)

  // -> The page title: a `contenteditable="plaintext-only"` span (`PageHeader.vue`), not an
  //    <input> -- but one with `aria-label="Title"`, which is what gives a contenteditable region
  //    an accessible textbox role in the first place, so `getByLabel` resolves it like a real form
  //    field. Driven with real keystrokes rather than `.fill()`: `.fill()` sets `textContent`
  //    directly and fires one synthetic `input` event, which this non-standard contenteditable
  //    value handles inconsistently under load -- typing (and blurring, which is what commits the
  //    field's tidied value in `onEditableBlur`) is what an author actually does, and is reliable
  //    where `.fill()` was seen to flake under the full suite's slightly different timing.
  const titleField = page.getByLabel('Title', { exact: true })
  await titleField.click()
  await page.keyboard.type(title)
  await titleField.blur()

  // -> Monaco mounts into `.editor-markdown-editor` asynchronously (it is a lazy chunk -- see
  //    `EditorMarkdown.vue`), and clicking the container before it has actually rendered its own
  //    focusable surface is a click with nothing under it to focus: keystrokes then have nowhere to
  //    go but wherever focus already was, which is how a title fill was seen landing in the content
  //    editor instead. Waiting for Monaco's own `.monaco-editor` root makes the click land on a
  //    real, focusable editor rather than racing its mount.
  await page.locator('.editor-markdown-editor .monaco-editor').waitFor()
  await page.locator('.editor-markdown-editor').click()
}

/**
 * Types `body` into the already-focused markdown editor and waits for it to reach the preview pane.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} body
 * @param {{ paste?: boolean, previewWaitText?: string }} [options] `paste` pastes the whole string
 *   at once instead of typing it. `previewWaitText` is what to wait for in the rendered preview,
 *   defaulting to `body` itself.
 */
export async function typeBody(page, body, { paste = false, previewWaitText = body } = {}) {
  if (paste) {
    /*
      `page.keyboard.type()` sends one real keydown/keyup per character, which is exactly what
      Monaco's per-character auto-closing-bracket/quote logic (its markdown language config pairs
      `{}`, `[]`, `()`, quotes and backticks) watches for. MDC block syntax
      (`::block-x{prop="value"}`) and fenced code blocks are built entirely out of those characters,
      and a naive per-character replay of a body that nests them (an attribute list, a run of three
      backticks) risks a doubled or swallowed character the editor's own type-over-the-auto-close
      heuristic doesn't cleanly cancel out.

      A REAL clipboard paste is required, not `page.keyboard.insertText()` -- that was tried first
      and does NOT take "the same path a real paste takes" as an earlier version of this comment
      claimed. `insertText` fires a raw DOM `input` event that Monaco's `TextAreaInput` processes
      through its ordinary typed-input/auto-indent pipeline (`autoIndent: 'full'`, the app's
      untouched default), not its dedicated clipboard-paste handling. For a multi-line body whose
      content includes an indented line inside a fenced code block (a YAML block under
      `block-infobox` in `csp.spec.js`, say), that pipeline's per-newline indent computation
      mis-fires partway through and re-indents every following line by the same amount, cascading to
      the end of the document -- confirmed with a standalone repro against the pinned `monaco-editor`
      build (OpenProject #2588). Once a later `::block-x{...}` line sits at 4+ spaces of leading
      whitespace, CommonMark/MDC parses it as an indented code block instead of a block opener, so
      the custom element never renders -- which is exactly what made `block-spoiler` (and everything
      typed after it) vanish from `csp.spec.js`, while `markdown-it-mdc` itself, given the identical
      string directly, was already confirmed innocent (OpenProject #2372). A genuine clipboard paste
      does not go through that mis-firing pipeline at all: confirmed the exact same body round-trips
      unchanged through a real `navigator.clipboard.writeText()` + paste keystroke, at the same
      `autoIndent: 'full'` default. Opt-in, not the default: every existing caller keeps typing for
      real, since that is what an author actually does and plain prose has no brackets/backticks/
      indentation for either code path to ever misfire on.
    */
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate((text) => navigator.clipboard.writeText(text), body)
    await page.keyboard.press('ControlOrMeta+V')
  } else {
    await page.keyboard.type(body)
  }

  // -> `EditorMarkdown.vue` syncs Monaco's content into `pageStore.content` on a 500ms debounce
  //    (`onDidChangeModelContent`) -- clicking "Create Page" before it fires would save an empty
  //    page. Waiting on the debounced render landing in the DOM is a real signal that the sync
  //    happened, not a fixed sleep guessed at. `previewWaitText` defaults to the raw `body`, which
  //    only actually appears verbatim in the rendered preview for callers whose body is plain
  //    prose/markdown with no block/math syntax that renders into something else entirely -- a
  //    caller writing MDC blocks or KaTeX passes a plain-text sentinel found elsewhere in `body`.
  await expect(page.locator('.editor-markdown-preview-content')).toContainText(previewWaitText)
}

/**
 * Publishes what is in the editor at `path`, through the real save dialog, and waits for the
 * redirect to the new page's own URL.
 *
 * `locale` must match whatever `openMarkdownEditor` was given: the page's real URL comes out
 * locale-prefixed whenever that locale isn't the site's primary (`localizedPagePath` in
 * `helpers/pagePaths.js`, which `pageStore.editorExitPath` -- where this redirects to on save --
 * already uses), so the final URL assertion expects that prefix too.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {{ locale?: string }} [options]
 */
export async function savePage(page, path, { locale } = {}) {
  await page.getByRole('button', { name: 'Create Page' }).click()

  // -> Non-home pages go through the save dialog (`TreeBrowserDialog.vue`, `mode: 'savePage'`). Its
  //    path field auto-slugs from the title on every keystroke until the path field itself gets
  //    focused (`onPathFocus` sets `pathDirty`) -- so without this, the dialog would silently save
  //    under a title-derived path instead of the one this test asked for and asserts against below.
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Path Name').fill(path)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()

  // -> `pageSave` replaces the route with the page's real path once the create request resolves
  //    (`stores/page.js`), so this is the save completing, not a fixed wait.
  const expectedPath = locale ? `${locale}/${path}` : path
  await expect(page).toHaveURL(new RegExp(`/${expectedPath}$`))
}

/**
 * Flow 2's core: create a page at `path` in the markdown editor, type `body` into it, and publish
 * it through the real save dialog -- shared between `page-publish.spec.js` (which IS flow 2) and
 * `multi-site.spec.js` (which needs a real published page on each site to prove they don't share
 * one, without re-narrating how the editor is driven).
 *
 * Nothing but the three steps above, in order: a spec that needs to do something between two of
 * them calls them directly rather than re-inlining any of their handling.
 *
 * Leaves `page` on the new page's own URL, rendered -- not the editor -- once it resolves.
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
