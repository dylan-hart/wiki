// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
//
// Two happy-dom defaults get in the way here, same reasoning as the two helper suites this mirrors:
//   - `enableJavaScriptEvaluation` (off by default) is required for the injectHead/injectBody
//     `<script>` assertions below to actually run the script (`helpers/injectHtml.test.js`).
//   - `disableCSSFileLoading` + `handleDisabledFileLoadingAsSuccess` quiet the `NetworkError`/
//     `NotSupportedError` noise from `applyFonts()`'s real `<link rel="stylesheet">` elements, which
//     have nothing to fetch from in this test run (`helpers/fonts.test.js`).
//
// This suite is the layer those two, and `helpers/injectCss.test.js`, don't cover: that `App.vue`'s
// `applyTheme()` actually WIRES each site-theme setting to its helper with the right field, on a path
// a real admin save takes (the `EVENT_BUS` `'applyTheme'` event `AdminTheme.vue`'s `save()` fires —
// see `helpers/injectHtml.test.js`'s "unrelated applyTheme() trigger" framing). A helper working in
// isolation doesn't prove `applyTheme()` still calls it, still passes the field it means to, or still
// calls it on every repeat trigger without piling up duplicate DOM nodes — which is exactly the shape
// of bug this feature started from (a saved setting with zero rendered effect). Every assertion below
// is written to fail if that wiring regresses, not merely to prove the helper module works.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import App from './App.vue'
import { useSiteStore } from '@/stores/site'
import { useFlagsStore } from '@/stores/flags'
import { useUserStore } from '@/stores/user'
import { useCommonStore } from './stores/common'

import { createTestI18n } from '../test/i18n.js'

import { buildTestRouter } from '../test/router.js'

let currentWrapper

afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = undefined

  document.querySelector('#theme-inject-css')?.remove()
  document.querySelector('#theme-inject-head')?.remove()
  document.querySelector('#theme-inject-body')?.remove()
  document.querySelector('#theme-content-font')?.remove()
  document.querySelectorAll('link[data-theme-font]').forEach((el) => el.remove())
  document.documentElement.style.removeProperty('--font-sans')
})

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 716: `App.vue`'s
 * `applyLocale()` must set `dir`/`lang` on `<html>` for the active locale, and must do so
 * immediately -- ahead of `router.afterEach` removing `.init-loading` -- rather than waiting on the
 * (possibly slow, possibly never-resolving in this test) locale-strings fetch.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  // -> Mirrors index.html's structure: router.afterEach() unconditionally removes this element
  document.body.insertAdjacentHTML('afterbegin', '<div class="init-loading"></div>')
})

afterEach(() => {
  document.documentElement.removeAttribute('dir')
  document.documentElement.removeAttribute('lang')
  document.body.innerHTML = ''
})

async function mountAppWithLocale(localeCode) {
  const siteStore = useSiteStore()
  const flagsStore = useFlagsStore()
  const userStore = useUserStore()
  const commonStore = useCommonStore()

  // -> Bootstrap already "loaded", so the router guard's loadBootstrap() branch is skipped and this
  //    hand-set locale data survives navigation untouched
  siteStore.$patch({
    id: 'site-1',
    locales: {
      primary: 'en',
      showMenu: true,
      active: [
        { code: 'en', language: 'en', name: 'English', nativeName: 'English', isRTL: false },
        { code: 'ar', language: 'ar', name: 'Arabic', nativeName: 'العربية', isRTL: true }
      ]
    }
  })
  flagsStore.loaded = true
  userStore.profileLoaded = true
  commonStore.setLocale(localeCode)

  // -> Never resolves: proves the dir/lang flip does not wait on the locale-strings request
  API_CLIENT.get.mockImplementationOnce(() => new Promise(() => {}))

  const router = buildTestRouter(['/'])
  const i18n = createTestI18n()

  mount(App, { global: { plugins: [router, i18n] } })

  await router.push('/')
  await router.isReady()
}

describe('App.vue applyLocale()', () => {
  it('sets dir="rtl" and lang for an RTL active locale, without waiting on locale strings', async () => {
    await mountAppWithLocale('ar')

    expect(document.documentElement.getAttribute('dir')).toBe('rtl')
    expect(document.documentElement.getAttribute('lang')).toBe('ar')
  })

  it('sets dir="ltr" for an LTR active locale', async () => {
    await mountAppWithLocale('en')

    expect(document.documentElement.getAttribute('dir')).toBe('ltr')
    expect(document.documentElement.getAttribute('lang')).toBe('en')
  })
})

/**
 * Regression coverage for OpenProject #1652: `applyLocale()` must eager-load the `en` fallback
 * dictionary alongside a non-`en` active locale, so vue-i18n's `fallbackLocale: 'en'` (boot/i18n.js)
 * has something to actually fall back to -- otherwise any key missing from the active locale (routine
 * for any real, incomplete translation) renders as its raw dotted key path instead of English.
 */
describe('App.vue applyLocale() en fallback eager-load', () => {
  async function mountAppWithLocaleAndRequests(localeCode, { active }) {
    const siteStore = useSiteStore()
    const flagsStore = useFlagsStore()
    const userStore = useUserStore()
    const commonStore = useCommonStore()

    siteStore.$patch({
      id: 'site-1',
      locales: { primary: 'en', showMenu: true, active }
    })
    flagsStore.loaded = true
    userStore.profileLoaded = true
    commonStore.setLocale(localeCode)

    const router = buildTestRouter(['/'])
    // -> `messages: {}`, matching the real boot/i18n.js -- not `{ en: {} }` as the other describe
    //    blocks in this file use, since that would put `en` in `availableLocales` from the start and
    //    the eager-load branch under test (`!i18n.availableLocales.includes('en')`) would never fire.
    const i18n = createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages: {} })

    mount(App, { global: { plugins: [router, i18n] } })

    await router.push('/')
    await router.isReady()
    await flushPromises()

    return { i18n }
  }

  it('requests both the active non-en locale and en, exactly once each', async () => {
    API_CLIENT.get.mockImplementation((url) => ({
      json: () =>
        Promise.resolve(
          url === 'locales/fr/strings' ? { 'common.actions.save': 'Enregistrer' } : {}
        )
    }))

    const { i18n } = await mountAppWithLocaleAndRequests('fr', {
      active: [
        { code: 'en', language: 'en', name: 'English', nativeName: 'English', isRTL: false },
        { code: 'fr', language: 'fr', name: 'French', nativeName: 'Français', isRTL: false }
      ]
    })

    const requestedUrls = API_CLIENT.get.mock.calls.map(([url]) => url)
    expect(requestedUrls.filter((url) => url === 'locales/fr/strings')).toHaveLength(1)
    expect(requestedUrls.filter((url) => url === 'locales/en/strings')).toHaveLength(1)
    expect(i18n.global.availableLocales).toEqual(expect.arrayContaining(['fr', 'en']))
  })

  it('requests en exactly once when the active locale already IS en', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve({}) }))

    await mountAppWithLocaleAndRequests('en', {
      active: [{ code: 'en', language: 'en', name: 'English', nativeName: 'English', isRTL: false }]
    })

    const requestedUrls = API_CLIENT.get.mock.calls.map(([url]) => url)
    expect(requestedUrls.filter((url) => url === 'locales/en/strings')).toHaveLength(1)
  })

  it('falls back to English instead of raw key echo when the strings backend has no row for the active locale', async () => {
    // -> `xx` is listed as one of the site's active locales, so the router guard's own
    //    not-active/not-installed correction never kicks in and silently swaps it for the primary
    //    locale before applyLocale() ever runs -- but `models/locales.ts#getStrings()` still replies
    //    with its no-row array shape for it, an installed-but-not-yet-cached code in practice.
    API_CLIENT.get.mockImplementation((url) => ({
      json: () =>
        Promise.resolve(
          url === 'locales/xx/strings' ? [] : { 'common.actions.save': 'Save' } // en reply
        )
    }))

    const { i18n } = await mountAppWithLocaleAndRequests('xx', {
      active: [
        { code: 'en', language: 'en', name: 'English', nativeName: 'English', isRTL: false },
        { code: 'xx', language: 'xx', name: 'Xx', nativeName: 'Xx', isRTL: false }
      ]
    })

    // -> The array-shaped reply for `xx` is rejected by fetchLocaleStrings(), so setLocaleMessage()
    //    is never called for it -- only `en` ends up loaded, giving the fallback something to
    //    resolve `common.actions.save` from instead of echoing the raw key.
    expect(i18n.global.availableLocales).toEqual(['en'])
    expect(i18n.global.t('common.actions.save')).toBe('Save')
  })
})

/**
 * Regression coverage for OpenProject #1769: a first navigation to a site whose primary locale isn't
 * the stored default drives `applyLocale()` through BOTH of its triggers for the same new locale
 * within a microtask of each other -- the router guard's `commonStore.setLocale(primary)` correction
 * fires the `watch(() => commonStore.locale, applyLocale)` at the top of this file, and the guard's
 * own very next line calls `applyLocale(commonStore.locale)` directly. Before this fix, neither call
 * had any way to see the other's fetch already underway, so this exact sequence issued the same
 * `GET locales/:code/strings` twice.
 */
describe('App.vue applyLocale() idempotency', () => {
  it('two overlapping calls for the same locale issue exactly one locale-strings request', async () => {
    const siteStore = useSiteStore()
    const flagsStore = useFlagsStore()
    const userStore = useUserStore()
    const commonStore = useCommonStore()

    // -> commonStore.locale defaults to 'en' (no stored value in this test's localStorage stub), which
    //    is NOT in this site's active list -- so the guard's correction branch runs, driving both
    //    triggers to 'fr' back to back.
    siteStore.$patch({
      id: 'site-1',
      locales: {
        primary: 'fr',
        showMenu: true,
        active: [
          { code: 'fr', language: 'fr', name: 'French', nativeName: 'Français', isRTL: false }
        ]
      }
    })
    flagsStore.loaded = true
    userStore.profileLoaded = true

    API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const router = buildTestRouter(['/'])
    const i18n = createTestI18n()

    mount(App, { global: { plugins: [router, i18n] } })

    await router.push('/')
    await router.isReady()
    await flushPromises()

    expect(commonStore.locale).toBe('fr')
    const localeStringsCalls = API_CLIENT.get.mock.calls.filter(
      ([url]) => url === 'locales/fr/strings'
    )
    expect(localeStringsCalls.length).toBe(1)
  })
})
