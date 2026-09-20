import { expect, test } from '@playwright/test'

// -> Importing a `backend/` script works despite this workspace having no `pg`/`drizzle-orm`: Node
//    resolves bare specifiers relative to the importing file, so they land in `backend/node_modules`.
import {
  LTR_TEST_LOCALE,
  RTL_TEST_LOCALE,
  runSeedLtrTestLocale,
  runSeedRtlTestLocale
} from '../../backend/scripts/seed-rtl-test-locale.ts'
import { createAndPublishPage, loginAsAdmin, uniqueSlug } from '../helpers/admin.js'

/**
 * `ar`/`es` are real vendored Localazy locales the backend resyncs at boot, but seeding them once
 * here is not a race against that: `refreshFromDisk()`'s `onConflictDoUpdate` only overwrites a row
 * whose current `updatedAt` is still older than the vendored file's mtime.
 */
test.beforeAll(async () => {
  await Promise.all([runSeedRtlTestLocale(), runSeedLtrTestLocale()])
})

/**
 * Goes through the real admin screen (`AdminLocale.vue`) rather than a direct API/DB write.
 * Assumes `loginAsAdmin(page)` has already run.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ name: string }[]} testLocales
 * @returns {Promise<string>} the default site's id, so a caller needing another
 *   `/_admin/:siteId/...` page afterwards doesn't re-derive it from `/_admin/sites`
 */
async function activateTestLocales(page, testLocales) {
  // -> `models/locales.ts#getLocales()` answers from a cache filled once at boot and never
  //    invalidated on its own, so a locale inserted straight into the table (as `beforeAll` did) is
  //    invisible to `GET /_api/locales`, and so to `AdminLocale.vue`, until the cache is flushed.
  // -> `page.evaluate()`, not `page.request.post()`: this route sits behind
  //    `core/http/authHooks.ts`'s same-origin gate, which fails closed on the missing
  //    `Origin`/`Sec-Fetch-Site: same-origin` pair Playwright's bare HTTP client sends. Only a real
  //    in-page `fetch()` carries them.
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
  // -> `AdminLocale.vue#load()` re-fires on its own `currentSiteId` watcher, and that refetch can
  //    still be in flight when the toggle below is clicked -- its stale response then overwrites
  //    `state.active` back out from under the click, and `networkidle` is not late enough to rule
  //    that out. Firing one refresh here and waiting `aria-busy` out is a fetch known to have landed.
  const refreshButton = page.getByRole('button', { name: 'Refresh', exact: true })
  await refreshButton.click()
  await expect(refreshButton).not.toHaveAttribute('aria-busy', 'true')

  for (const testLocale of testLocales) {
    const toggle = page.getByRole('switch', { name: testLocale.name })
    await toggle.waitFor()
    // -> Idempotent rather than an unconditional click: this suite's database is not guaranteed
    //    empty of a previous run's activation, so the toggle may already be on.
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
 * `AdminLayout.vue`'s switcher is the only place `commonStore.locale` is set; the reading view's
 * `LocaleSelectorMenu.vue` navigates the CONTENT locale and deliberately leaves it alone. Two
 * things follow the INTERFACE locale specifically: a `/_`-prefixed route has no locale segment to
 * resolve `dir`/`lang` from and falls back to it (`App.vue#applyDocumentLocale`), and every chrome
 * string rendered through `t()` is keyed off it.
 *
 * Matches the raw `nativeName` off `GET /_api/locales` -- the seed's own custom name, which this
 * switcher shows and the reading view's CLDR-derived spelling does not.
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

    // -> Not `/`: a fresh site's root shows `WelcomeOverlay.vue`'s full-screen prompt in front of
    //    the sidebar controls this test clicks. Any other path renders the ordinary "page not
    //    found" placeholder inside the normal shell instead.
    await page.goto('/e2e-rtl-check')

    // -> The reader's own switcher (`LocaleSelectorMenu.vue`) is what flips `dir`/`lang`
    //    (`App.vue#applyLocale`); the activation above alone does not.
    //
    //    Not `RTL_TEST_LOCALE.nativeName`: `stores/site.js#describeLocales()` re-derives the name
    //    from `Intl.DisplayNames` off the bare code rather than reading the `locales` table, so this
    //    menu shows the generic CLDR spelling, not the seed's custom one.
    await page.getByRole('button', { name: 'Switch Locale' }).click()
    await page.getByText('العربية', { exact: true }).click()

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.locator('html')).toHaveAttribute('lang', RTL_TEST_LOCALE.code)

    // -> By accessible name, not visible text: on a pageless path the sidebar renders in its
    //    icon-only "mini" mode, where the label is an `aria-label`/tooltip rather than on-screen
    //    text.
    await expect(
      page.getByRole('button', { name: RTL_TEST_LOCALE.strings['common.sidebar.browse'] })
    ).toBeVisible()

    // -> The markdown toolbar's buttons carry no visible text or static `aria-label`:
    //    `t('editor.markup.bold')` renders only into a `<w-tooltip labels>`, which associates via
    //    `aria-labelledby` while shown, so the hover is what puts an accessible name on the button.
    await page.goto(`/_create/markdown?path=e2e-rtl-md-${uniqueSlug()}`)
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await page.locator('.editor-markdown-editor .monaco-editor').waitFor()
    const boldButton = page.locator('.editor-markdown-toolbar button').first()
    await boldButton.hover()
    await expect(
      page.getByRole('button', { name: RTL_TEST_LOCALE.strings['editor.markup.bold'] })
    ).toBeVisible()

    // -> `dir` only: `wysiwyg` registers through the same `editorComponents` map as every other
    //    mode, so there is nothing editor-specific left to check here.
    await page.goto(`/_create/wysiwyg?path=e2e-rtl-wys-${uniqueSlug()}`)
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')

    // -> The admin chrome mirrors with the rest of the app rather than staying forced LTR: it is
    //    the same single-locale SPA document, and its header carries a switcher an operator can
    //    pick this very locale from.
    await page.goto('/_admin/dashboard')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.getByText(RTL_TEST_LOCALE.strings['admin.adminArea'])).toBeVisible()
  })

  /**
   * A rendered check rather than a source scan: `padding-inline-end` resolves against the
   * document's own `dir` at render time, computing as a physical `padding-left` under `dir="rtl"`.
   * A hard-coded `pr-1` in its place would keep computing as `padding-right` and still pass
   * `frontend/src/logicalSpacing.test.js`, whose patterns only match raw `padding-right:`
   * declarations and `pr-*` utilities in source. `WFieldFrame.vue`'s required-field asterisk is the
   * live example of the property in the field chrome every `w-input`/`w-select` renders through.
   */
  test("a required field's label asterisk gutter follows the document direction, not a fixed side", async ({
    page
  }) => {
    await loginAsAdmin(page)
    const siteId = await activateTestLocales(page, [RTL_TEST_LOCALE])
    // -> `/_admin/...` has no locale segment of its own, so its `dir` falls back to the INTERFACE
    //    locale (`App.vue#applyDocumentLocale`), not to the reading-view switch below.
    await switchInterfaceLocale(page, RTL_TEST_LOCALE)

    // -> Redundant for `dir` (already `rtl` from the interface locale above) -- here to exercise
    //    the content-locale navigation path as well.
    await page.goto('/e2e-rtl-required-field-check')
    await page.getByRole('button', { name: 'Switch Locale' }).click()
    await page.getByText('العربية', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')

    // -> `admin.glossary.*` is not among the keys `backend/scripts/seed-rtl-test-locale.ts` seeds
    //    for `ar`, so the button and field label render their English fallback (`fallbackLocale:
    //    'en'`) whatever the interface locale -- matching on that fallback text is deliberate.
    await page.goto(`/_admin/${siteId}/glossary`)
    await page.getByRole('button', { name: 'New Term', exact: true }).click()

    // -> `getByRole('textbox', { name })`, not `getByLabel`: the latter matches the label's raw
    //    text content, which includes `WFieldFrame.vue`'s `aria-hidden` asterisk ("Term" + nbsp +
    //    "*"), so an exact match on "Term" never lands. `aria-hidden` removes an element from the
    //    accessibility tree but not from `textContent`; accessible-name computation excludes it.
    const termField = page
      .locator('.w-input')
      .filter({ has: page.getByRole('textbox', { name: 'Term', exact: true }) })
    // -> `aria-hidden` on this decorative glyph does not affect Playwright's visibility check.
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
 * Neither case touches a locale switcher: the interface locale stays at its untouched `en` default
 * while the page being viewed carries a locale of its own, addressed by its locale-prefixed URL.
 * `<html lang>`/`dir` must follow the page, not the reader.
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

    // -> `createAndPublishPage` leaves the browser on the page's own locale-prefixed URL. The
    //    server's initial HTML stamps `dir` correctly on its own (`backend/helpers/appShell.ts`),
    //    so the failure mode here is the SPA overwriting it a tick after boot -- `toHaveAttribute`
    //    retries, making this an assertion on the settled post-hydration state.
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

    // -> `dir` proves nothing here -- both the English interface and this page's `es` resolve to
    //    `ltr`. `lang` is what this second case is for: it is wrong on any translated page, not
    //    only an RTL one.
    await expect(page.locator('html')).toHaveAttribute('lang', LTR_TEST_LOCALE.code)
  })
})
