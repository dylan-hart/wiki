// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
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

  document.querySelector('#theme-content-font')?.remove()
  document.querySelectorAll('link[data-theme-font]').forEach((el) => el.remove())
  document.documentElement.style.removeProperty('--font-sans')
})

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
  //    hand-set locale data survives navigation
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
 * vue-i18n's `fallbackLocale: 'en'` (boot/i18n.js) only helps if the `en` dictionary is actually
 * loaded alongside the active one: otherwise a key missing from an incomplete translation renders
 * as its raw dotted key path instead of English.
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
    // -> `messages: {}`, matching the real boot/i18n.js: `{ en: {} }` would put `en` in
    //    `availableLocales` from the start and the eager-load branch under test
    //    (`!i18n.availableLocales.includes('en')`) would never fire.
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
    // -> `xx` is listed active so the router guard's not-active correction never swaps it for the
    //    primary locale before applyLocale() runs, but `models/locales.ts#getStrings()` still replies
    //    with its no-row array shape -- an installed-but-not-yet-cached code in practice.
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

    // -> The array-shaped reply for `xx` is rejected by fetchLocaleStrings(), so only `en` ends up
    //    loaded -- which is what the fallback resolves `common.actions.save` from.
    expect(i18n.global.availableLocales).toEqual(['en'])
    expect(i18n.global.t('common.actions.save')).toBe('Save')
  })
})

/**
 * A first navigation to a site whose primary locale isn't the stored default drives `applyLocale()`
 * through BOTH of its triggers for the same new locale within a microtask of each other: the router
 * guard's `commonStore.setLocale(primary)` correction fires the `watch(() => commonStore.locale,
 * applyLocale)`, and the guard's own very next line calls `applyLocale(commonStore.locale)`.
 */
describe('App.vue applyLocale() idempotency', () => {
  it('two overlapping calls for the same locale issue exactly one locale-strings request', async () => {
    const siteStore = useSiteStore()
    const flagsStore = useFlagsStore()
    const userStore = useUserStore()
    const commonStore = useCommonStore()

    // -> commonStore.locale defaults to 'en', which is NOT in this site's active list, so the
    //    guard's correction branch runs and drives both triggers to 'fr' back to back.
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

/**
 * `<html dir>`/`lang` follow the locale the URL itself addresses in its leading segment, not the
 * interface locale, and do so for a destination with NO page behind it:
 * `LocaleSelectorMenu.vue#switchLocale()` navigates rather than setting the interface locale, and a
 * "page not found" screen under an RTL locale's own prefix is still text a reader reads
 * right-to-left.
 *
 * The negative half matters just as much: the segment is matched against `siteStore.locales.active`,
 * so an arbitrary first path segment cannot set `dir`/`lang` to a locale the site does not have.
 */
describe('App.vue applyDocumentLocale()', () => {
  /**
   * `/:catchAll(.*)*` mirrors `router/routes.js`'s own page route -- a locale-prefixed path and an
   * ordinary one are the same shape to the router, which is why the app has to make the locale call
   * itself. No page is ever loaded here: the document attributes settle from the URL alone.
   */
  async function mountAppAt(path, { interfaceLocale = 'en' } = {}) {
    const siteStore = useSiteStore()
    const flagsStore = useFlagsStore()
    const userStore = useUserStore()
    const commonStore = useCommonStore()

    siteStore.$patch({
      id: 'site-1',
      locales: {
        primary: 'en',
        showMenu: true,
        active: [
          { code: 'en', language: 'en', name: 'English', nativeName: 'English', isRTL: false },
          { code: 'ar', language: 'ar', name: 'Arabic', nativeName: 'العربية', isRTL: true },
          { code: 'fr', language: 'fr', name: 'French', nativeName: 'Français', isRTL: false }
        ]
      }
    })
    flagsStore.loaded = true
    userStore.profileLoaded = true
    commonStore.setLocale(interfaceLocale)

    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve({}) }))

    const router = buildTestRouter(['/', '/:catchAll(.*)*'])
    const i18n = createTestI18n()

    currentWrapper = mount(App, { global: { plugins: [router, i18n] } })

    await router.push(path)
    await router.isReady()
    await flushPromises()

    return { router, commonStore }
  }

  it('flips dir/lang for an RTL locale prefix on a path with no page behind it', async () => {
    await mountAppAt('/ar/e2e-rtl-check')

    expect(document.documentElement.getAttribute('dir')).toBe('rtl')
    expect(document.documentElement.getAttribute('lang')).toBe('ar')
  })

  it('leaves dir/lang on the interface locale for a leading segment the site does not have', async () => {
    await mountAppAt('/xx/e2e-rtl-check')

    expect(document.documentElement.getAttribute('dir')).toBe('ltr')
    expect(document.documentElement.getAttribute('lang')).toBe('en')
  })

  it('keeps the URL segment ahead of the interface locale, both ways round', async () => {
    const { router, commonStore } = await mountAppAt('/ar/e2e-rtl-check')
    expect(document.documentElement.getAttribute('dir')).toBe('rtl')

    // -> The RTL prefix survives the interface locale changing under it
    commonStore.setLocale('fr')
    await flushPromises()
    expect(document.documentElement.getAttribute('dir')).toBe('rtl')
    expect(document.documentElement.getAttribute('lang')).toBe('ar')

    // -> And an LTR prefix under an RTL interface locale reads left-to-right, not the other way
    commonStore.setLocale('ar')
    await router.push('/fr/quelque-page')
    await flushPromises()
    expect(document.documentElement.getAttribute('dir')).toBe('ltr')
    expect(document.documentElement.getAttribute('lang')).toBe('fr')
  })

  it('falls back to the interface locale once the URL stops naming one', async () => {
    const { router, commonStore } = await mountAppAt('/ar/e2e-rtl-check')
    expect(document.documentElement.getAttribute('dir')).toBe('rtl')

    // -> A `/_` route has no locale segment at all: the admin area is drawn in the reader's own
    //    interface language, so that is what its direction follows
    await router.push('/_admin/dashboard')
    await flushPromises()
    expect(document.documentElement.getAttribute('dir')).toBe('ltr')
    expect(document.documentElement.getAttribute('lang')).toBe('en')

    commonStore.setLocale('ar')
    await router.push('/some/page')
    await flushPromises()
    expect(document.documentElement.getAttribute('dir')).toBe('rtl')
    expect(document.documentElement.getAttribute('lang')).toBe('ar')
  })

  it('resolves the segment case-insensitively, to the code as the site spells it', async () => {
    await mountAppAt('/AR/e2e-rtl-check')

    expect(document.documentElement.getAttribute('dir')).toBe('rtl')
    expect(document.documentElement.getAttribute('lang')).toBe('ar')
  })
})
