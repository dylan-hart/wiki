import { expect, test } from '@playwright/test'

// -> The e2e workspace has no `pg`/`drizzle-orm` of its own (it is a plain Playwright workspace --
//    see `e2e/package.json`); `runSeed*TestLocale()` each build and close their own connection, and
//    everything IT imports resolves against `backend/`'s own `node_modules` because Node resolves
//    bare specifiers relative to the importing file's location, not this file's.
import {
  LTR_TEST_LOCALE,
  RTL_TEST_LOCALE,
  runSeedLtrTestLocale,
  runSeedRtlTestLocale
} from '../../backend/scripts/seed-rtl-test-locale.ts'
import { createAndPublishPage, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

/**
 * Feature 413 ("RTL support end-to-end"), task 727, and WP #1662 (content-vs-interface locale
 * split): seed both synthetic test locales directly into the same database the backend under test
 * boots against. `ar`/`es` are both real, vendored Localazy locales the backend's own boot-time
 * `refreshFromDisk()` resyncs -- this seed's own write is safe against that regardless of ordering
 * (OpenProject #2371: `refreshFromDisk()`'s `onConflictDoUpdate` only overwrites a row whose CURRENT
 * `updatedAt` is still older than the vendored file's mtime, re-checked atomically at write time --
 * see the seed script's header comment and `models/locales.ts#refreshFromDisk`'s own), which is what
 * makes seeding this once, ahead of every test in this file, safe rather than a race against boot.
 */
test.beforeAll(async () => {
  await Promise.all([runSeedRtlTestLocale(), runSeedLtrTestLocale()])
})

/**
 * Activates one or more test locales for the default site through the real admin screen
 * (`AdminLocale.vue`), per the original task's own instruction -- not a direct API/DB write. Shared
 * by every test in this file that needs an active non-primary locale before it can create or view a
 * locale-prefixed page; assumes the caller has already called `loginAsAdmin(page)`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ name: string }[]} testLocales
 * @returns {Promise<string>} the default site's id, resolved along the way -- handed back so a
 *   caller that needs to navigate to another `/_admin/:siteId/...` page afterward (OpenProject
 *   #1601's required-field gutter check does) doesn't have to re-derive it from `/_admin/sites`.
 */
async function activateTestLocales(page, testLocales) {
  // -> `models/locales.ts#getLocales()` answers from `WIKI.cache`, populated once at boot
  //    (`index.ts#postBoot`, via `refreshFromDisk()` then `reloadCache()`) and never invalidated on
  //    its own -- a locale inserted straight into the table (as `beforeAll` above just did) is
  //    invisible to `GET /_api/locales`, and so to `AdminLocale.vue`, until something busts that
  //    cache. `POST /_api/system/cache/flush` is the real, existing mechanism for exactly this
  //    (`AdminUtilities.vue`'s "Flush Caches" button, `core/maintenance.ts#flushCaches`) -- not a
  //    test-only workaround, and the same step a real administrator would take after loading a
  //    locale outside the normal boot-time `refreshFromDisk()` path.
  // -> Must go through `page.evaluate()`, not `page.request.post()` (OpenProject #2569 follow-up):
  //    this route sits behind `core/http/authHooks.ts`'s same-origin gate (task 2118 / WP 2105 §3),
  //    which fails closed on a missing/foreign `Origin` and no `Sec-Fetch-Site: same-origin` --
  //    exactly what Playwright's `page.request` API sends, since it is a bare HTTP client sharing
  //    the browser context's cookies but not its browsing-context origin headers. The call silently
  //    403'd every run (its result was never checked), leaving the boot-time cache permanently
  //    stale for the rest of the suite: every toggle this test waits for by a
  //    `(RTL Test)`/`(LTR Test)`-suffixed name timed out, because `AdminLocale.vue` kept rendering
  //    the pre-seed, real Localazy names instead. A real in-page `fetch()` carries a genuine
  //    same-origin `Origin`/`Sec-Fetch-Site` pair, exactly like `AdminUtilities.vue`'s own button
  //    click would.
  const flushed = await page.evaluate(async () => {
    const res = await fetch('/_api/system/cache/flush', { method: 'POST' })
    return res.ok
  })
  if (!flushed) {
    throw new Error(
      'POST /_api/system/cache/flush failed -- the locale toggles below would be stale'
    )
  }

  await page.goto('/_admin/sites')
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
  await expect(page).toHaveURL(/\/_admin\/[^/]+\/general$/)
  const siteId = new URL(page.url()).pathname.match(/\/_admin\/([^/]+)\/general/)[1]

  await page.goto(`/_admin/${siteId}/locale`)
  // -> `AdminLocale.vue#load()` re-fires on its own `watch(() => adminStore.currentSiteId, ...)`
  //    shortly after `AdminLayout.vue`'s mount resolves that id from the URL -- on a slow run that
  //    refetch can still be in flight when the toggle below is clicked, and its response (the
  //    server's still-unchanged, `en`-only list) overwrites `state.active` right back out from
  //    under the click, and a bare `waitForLoadState('networkidle')` is not late enough to rule
  //    that out. An explicit, single `load()` this test itself triggers (via the "Refresh" button)
  //    and then waits out (`aria-busy` clearing is `state.loading` reaching zero) is a fetch this
  //    test knows has already landed before it touches the toggle, which the implicit one is not.
  const refreshButton = page.getByRole('button', { name: 'Refresh', exact: true })
  await refreshButton.click()
  await expect(refreshButton).not.toHaveAttribute('aria-busy', 'true')

  for (const testLocale of testLocales) {
    const toggle = page.getByRole('switch', { name: testLocale.name })
    await toggle.waitFor()
    // -> Idempotent rather than an unconditional click: this suite's own database is not
    //    guaranteed empty of a previous run's activation (`test/db.ts`'s "fresh schema per run"
    //    convention is a `backend/` unit-test fixture, not something this e2e database gets for
    //    free), so the toggle may already be on.
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
      await toggle.click()
    }
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  }
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByText('successfully', { exact: false })).toBeVisible()

  return siteId
}

/**
 * Switches the READER'S interface language via `AdminLayout.vue`'s own switcher -- the only place
 * `commonStore.locale` is ever set. `LocaleSelectorMenu.vue`'s reading-view switcher (used below,
 * and by `activateTestLocales`'s own caller) deliberately does NOT touch it: its own header comment
 * calls that "a separate concern this menu does not touch", and
 * `docs/decisions/lang-dir-contract.md` §6 records why -- it navigates the CONTENT locale instead
 * (OpenProject #2596).
 *
 * Two things depend on the INTERFACE locale specifically, and neither is covered by #2596's
 * URL-based `dir`/`lang` resolution: a `/_`-prefixed route (the admin area, the markdown/wysiwyg
 * editors) has no locale segment of its own to resolve `dir`/`lang` from and falls back to
 * `commonStore.locale` (`App.vue#applyDocumentLocale`); and every chrome string rendered through
 * `t()` -- the reading view's own sidebar "Browse" button among them -- is keyed off
 * `i18n.locale.value`, which only an interface-locale change ever moves. Without this, the checks
 * below that reach a `/_` route or read translated chrome would still be running under the
 * untouched English interface locale.
 *
 * Selects by the raw, un-re-derived `nativeName` this menu shows (`adminStore.locales`, straight
 * off `GET /_api/locales`) rather than the reading view's generic CLDR spelling -- the one place
 * this file checks that the seed's own custom name ("العربية (اختبار)") actually reaches the
 * screen, per `activateTestLocales`'s own header comment above.
 *
 * `/_admin/dashboard` (not a `:siteid`-scoped admin page): the switcher lives in `AdminLayout.vue`'s
 * header, common to every admin route regardless of which site it addresses, so this needs no
 * `siteId` of its own.
 */
async function switchInterfaceLocale(page, testLocale) {
  await page.goto('/_admin/dashboard')
  await page.getByRole('button', { name: 'EN', exact: true }).click()
  await page.getByText(testLocale.nativeName, { exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('dir', testLocale.isRTL ? 'rtl' : 'ltr')
  await expect(page.locator('html')).toHaveAttribute('lang', testLocale.code)
}

test.describe('RTL locale activation and dir="rtl" end-to-end', () => {
  test('activating the synthetic RTL locale via AdminLocale.vue flips dir/lang across the reading view, both editors, and the admin area', async ({
    page
  }) => {
    await loginAsAdmin(page)
    await activateTestLocales(page, [RTL_TEST_LOCALE])
    await switchInterfaceLocale(page, RTL_TEST_LOCALE)

    // -> Not `/`: a brand new site has no home page yet, and `Index.vue`'s route watcher sends an
    //    unauthenticated visitor straight to `/login` in that case -- irrelevant here since this
    //    session is authenticated, but the same fresh site shows `WelcomeOverlay.vue`'s full-screen
    //    prompt over the header on `/` regardless of auth state, which would sit in front of the
    //    sidebar controls this test needs to click. Any other path renders the ordinary "page not
    //    found" placeholder inside the normal shell instead (see `auth.spec.js`).
    await page.goto('/e2e-rtl-check')

    // -> Switch the READER's own display locale to the RTL test locale, via the real switcher
    //    (`LocaleSelectorMenu.vue`, fed from `siteStore.locales.active` -- which is empty until the
    //    activation above lands). This is what actually flips `dir`/`lang`
    //    (`App.vue#applyLocale`), not the activation alone.
    //
    //    Not `RTL_TEST_LOCALE.nativeName`: this reader-facing menu does not read the `locales`
    //    table's own `name`/`nativeName` columns at all -- `stores/site.js#describeLocales()`
    //    deliberately re-derives both from `Intl.DisplayNames` off the bare code instead (see its own
    //    header comment), so it shows the generic CLDR spelling ("العربية") rather than this seed's
    //    custom one ("العربية (اختبار)"). The admin's OWN language-switcher (`AdminLayout.vue`,
    //    already used above via `switchInterfaceLocale`) reads the raw API response and does show
    //    the custom name.
    await page.getByRole('button', { name: 'Switch Locale' }).click()
    await page.getByText('العربية', { exact: true }).click()

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.locator('html')).toHaveAttribute('lang', RTL_TEST_LOCALE.code)

    // -> Translated chrome text actually renders, not just the attribute flip -- the reading view's
    //    "Browse" sidebar action, in Arabic. By accessible name (its `aria-label`), not visible text:
    //    on a pageless path like this one the sidebar renders in its icon-only "mini" mode
    //    (`MainLayout.vue`'s `isSidebarMini`), where the label is an `aria-label`/tooltip rather than
    //    on-screen text.
    await expect(
      page.getByRole('button', { name: RTL_TEST_LOCALE.strings['common.sidebar.browse'] })
    ).toBeVisible()

    // -> Markdown editor: dir survives navigating into it, and its toolbar (mirrored by task 721)
    //    mounts under it. The toolbar's own buttons carry no visible text or static `aria-label` --
    //    `t('editor.markup.bold')` renders only into a `<w-tooltip labels>`, which associates via
    //    `aria-labelledby` while shown (`WTooltip.vue`'s `labels` prop, WP #1588) -- so a hover is
    //    still what puts the name on the button, but the check itself is now by accessible name
    //    (`getByRole`), not a raw text scrape.
    await page.goto(`/_create/markdown?path=e2e-rtl-md-${uniqueSlug()}`)
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await page.locator('.editor-markdown-editor .monaco-editor').waitFor()
    const boldButton = page.locator('.editor-markdown-toolbar button').first()
    await boldButton.hover()
    await expect(
      page.getByRole('button', { name: RTL_TEST_LOCALE.strings['editor.markup.bold'] })
    ).toBeVisible()

    // -> WYSIWYG editor: NOT checked beyond `dir` surviving the navigation. `pages/Index.vue`'s own
    //    `editorComponents` map has the `wysiwyg` entry commented out (only `markdown` and
    //    `redirect` are registered) -- discovered live, during this task's own walk, rather than
    //    assumed from the file existing: `/_create/wysiwyg` never mounts `EditorWysiwyg.vue` at all
    //    right now, under any locale or direction, with no console error to say so. That is a
    //    pre-existing gap this task did not introduce and has no business fixing on its way through
    //    (wiring up a whole editor mode is not an RTL change) -- recorded in `docs/variances.md`
    //    instead. What IS still genuine here is that the app shell around the (empty) editor slot
    //    keeps `dir="rtl"`, which is what this asserts.
    await page.goto(`/_create/wysiwyg?path=e2e-rtl-wys-${uniqueSlug()}`)
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')

    // -> Admin area: this fork's decision (documented in `docs/variances.md`, given no 2.5.x source
    //    was available in this sandbox to confirm against) is that the admin chrome mirrors along
    //    with the rest of the app rather than staying forced LTR -- it is, after all, the same
    //    single-locale SPA document, and the admin header carries its own locale switcher
    //    (`AdminLayout.vue`) that lets an operator pick this very locale directly from within it.
    await page.goto('/_admin/dashboard')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.getByText(RTL_TEST_LOCALE.strings['admin.adminArea'])).toBeVisible()
  })

  /**
   * OpenProject #1601's "Done when" bullet: a rendered check on one converted required-field
   * form, proving the asterisk gutter actually follows reading direction rather than merely
   * asserting against source text (the way `frontend/src/logicalSpacing.test.js` does for every
   * other declaration this epic converted). `WFieldFrame.vue`'s required-field asterisk
   * (`<span class="text-negative pe-1" aria-hidden="true">`, beside the glossary "Term" field's
   * top-of-field label -- Cardinal's re-skin dropped the Material floating label entirely, see that
   * component's own header comment) is the one live example of `padding-inline-end` in the shared
   * field chrome every `w-input`/`w-select` in the app renders through.
   *
   * `padding-inline-end` resolves against the DOCUMENT's own `dir` at render time, not anything
   * this test controls directly -- under `dir="rtl"` it computes as a physical `padding-left`, not
   * `padding-right`. That is exactly the distinction a hand-written physical gutter (`pe-1` swapped
   * back for a hard-coded `pr-1`, say) would get wrong: it would keep computing as `padding-right`
   * regardless of `dir`, which is what this assertion would catch -- a real regression in the
   * shared field chrome, not just a source-text scan, would fail this test and pass
   * `logicalSpacing.test.js` (that scan's DECLARATION_PATTERN matches raw `padding-right:`
   * declarations and Tailwind `pr-*` utilities, not a component's own logical Tailwind class
   * resolving the "wrong" way at render time).
   */
  test("a required field's label asterisk gutter follows the document direction, not a fixed side", async ({
    page
  }) => {
    await loginAsAdmin(page)
    const siteId = await activateTestLocales(page, [RTL_TEST_LOCALE])
    // -> The glossary dialog lives under `/_admin/<siteId>/glossary`, a `/_`-prefixed route with no
    //    locale segment of its own -- its `dir` falls back to the INTERFACE locale
    //    (`App.vue#applyDocumentLocale`), not to whatever the reading-view switch below does. See
    //    `switchInterfaceLocale`'s own header comment.
    await switchInterfaceLocale(page, RTL_TEST_LOCALE)

    // -> Same reader-facing switch as the test above -- exercises the content-locale navigation
    //    path (OpenProject #2596) on top of the interface-locale switch just above; `dir` is
    //    already `rtl` either way once the interface locale is active.
    await page.goto('/e2e-rtl-required-field-check')
    await page.getByRole('button', { name: 'Switch Locale' }).click()
    await page.getByText('العربية', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')

    // -> The glossary's "New Term" dialog: an outlined `w-input` with `required` set
    //    (`GlossaryTermDialog.vue`), the same field chrome every other required `w-input`/
    //    `w-select` in the app shares via `WFieldFrame.vue`. `admin.glossary.*` isn't among the
    //    curated keys `backend/scripts/seed-rtl-test-locale.ts` seeds for `ar` (see its own header
    //    comment), so both the button and the field label render their English fallback text
    //    (`fallbackLocale: 'en'`, `boot/i18n.js`) regardless of the active interface locale --
    //    asserting on that fallback text is deliberate, not an oversight.
    await page.goto(`/_admin/${siteId}/glossary`)
    await page.getByRole('button', { name: 'New Term', exact: true }).click()

    const termField = page
      .locator('.w-input')
      .filter({ has: page.getByLabel('Term', { exact: true }) })
    // -> The one asterisk `WFieldFrame.vue` renders for a required field, beside the label text --
    //    `aria-hidden` (the label's own text already says "Term"; the glyph is decorative), which
    //    does not affect Playwright's visibility check.
    const asterisk = termField.locator('label .text-negative')
    await expect(asterisk).toBeVisible()

    const padding = await asterisk.evaluate((el) => {
      const style = getComputedStyle(el)
      return { left: style.paddingLeft, right: style.paddingRight }
    })
    expect(
      padding.left,
      'padding-inline-end should resolve to padding-left under dir="rtl"'
    ).not.toBe('0px')
    expect(
      padding.right,
      'padding-inline-end should not also carry a physical padding-right under dir="rtl"'
    ).toBe('0px')
  })
})

/**
 * WP #1662, part of epic #1655 ("Resolve <html lang>/dir from the page's content locale, not the
 * interface locale"): `App.vue#applyLocale` used to derive both `<html lang>` and `dir` from
 * `commonStore.locale` -- the reader's INTERFACE language -- even though the server's own app-shell
 * stamp (`backend/helpers/appShell.ts`) already gets both right from the page's own CONTENT locale.
 * The fix (`applyContentLocale`, driven by `pageStore.locale`) is what these two cases exist to
 * fail without and pass with.
 *
 * Neither case here ever touches `LocaleSelectorMenu.vue` (the reader's own interface-locale
 * switcher) -- the whole point is that the interface locale is left at its untouched default (`en`,
 * per `stores/common.js`'s `commonStore.locale` fallback) while the PAGE being viewed carries a
 * different locale of its own, addressed directly by its locale-prefixed URL.
 */
test.describe("<html lang>/dir follow the page's own content locale, not the interface locale", () => {
  test('an RTL-locale page keeps dir="rtl" after hydration while the interface locale stays English', async ({
    page
  }) => {
    await loginAsAdmin(page)
    await activateTestLocales(page, [RTL_TEST_LOCALE, LTR_TEST_LOCALE])

    const path = `e2e-content-locale-rtl-${uniqueSlug()}`
    await createAndPublishPage(page, {
      path,
      title: `Content locale RTL ${uniqueSlug()}`,
      body: 'Content page under the RTL test locale, for the content-vs-interface-locale e2e coverage.',
      locale: RTL_TEST_LOCALE.code
    })

    // -> `createAndPublishPage` already leaves `page` on the page's own real, locale-prefixed URL
    //    (`/ar/<path>`) -- this is the buggy behaviour's own failure mode: the server's initial HTML
    //    response gets `dir="rtl"` right (`resolveAppShellLocale` in `backend/helpers/appShell.ts`),
    //    and the pre-fix `App.vue#applyLocale` then overwrites it back to `dir="ltr"` within a tick
    //    of the SPA booting, because it reads the still-English interface locale instead of this
    //    page's own `ar`. `toHaveAttribute` retries until it settles, so this asserts the FINAL,
    //    post-hydration state, not merely the server's first response.
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  })

  test('a non-RTL translation reflects its own locale in <html lang>, not the interface locale', async ({
    page
  }) => {
    await loginAsAdmin(page)
    await activateTestLocales(page, [RTL_TEST_LOCALE, LTR_TEST_LOCALE])

    const path = `e2e-content-locale-ltr-${uniqueSlug()}`
    await createAndPublishPage(page, {
      path,
      title: `Content locale LTR ${uniqueSlug()}`,
      body: 'Content page under the non-RTL test locale, for the content-vs-interface-locale e2e coverage.',
      locale: LTR_TEST_LOCALE.code
    })

    // -> `LTR_TEST_LOCALE.isRTL` is false, so `dir` alone can't tell the buggy behaviour from the
    //    fixed one here (both the English interface and this page's own `es` resolve to `ltr`) --
    //    that is the point of this second case, per WP #1655's own framing: the `lang` half is wrong
    //    on ANY translated page regardless of direction, not only an RTL one. Pre-fix,
    //    `App.vue#applyLocale` sets `lang` from `commonStore.locale` ("en"); fixed, it comes from
    //    this page's own `pageStore.locale` ("es").
    await expect(page.locator('html')).toHaveAttribute('lang', LTR_TEST_LOCALE.code)
  })
})
