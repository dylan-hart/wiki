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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'

import App from './App.vue'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'
import { useSiteStore } from '@/stores/site'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { useUserStore } from '@/stores/user'
import { useCommonStore } from './stores/common'

import { createTestI18n } from '../test/i18n.js'

import { buildTestRouter, createTestRouter } from '../test/router.js'
let currentWrapper

/**
 * Mounts the real `App.vue` against a fresh pinia + a memory router already settled on `/`, so
 * `applyTheme()` can be driven through the same `EVENT_BUS` event a real admin save fires, without
 * booting bootstrap fetches, real routes, or the router's own first-navigation init path.
 *
 * The router navigates to `/` and resolves BEFORE `App` is mounted, so `App.vue`'s own
 * `router.afterEach` guard (registered when its `<script setup>` runs, i.e. at mount) never actually
 * fires here — it would otherwise try to remove a `.init-loading` element this test harness has no
 * reason to render. Theme application is triggered explicitly instead, below.
 */
async function mountApp() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n()

  currentWrapper = mount(App, {
    global: { plugins: [router, i18n] }
  })

  return siteStore
}

/**
 * Fires the same `EVENT_BUS` event `AdminTheme.vue`'s `save()` fires, then lets `applyTheme()`'s
 * trailing `await applyCodeBlocksTheme()` settle — `EVENT_BUS.emit()` itself does not await its
 * listener.
 */
async function triggerApplyTheme() {
  EVENT_BUS.emit('applyTheme')
  await new Promise((resolve) => setTimeout(resolve, 0))
}

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

describe('App.vue applyTheme()', () => {
  it('injectCSS: renders the configured rule as a <style> element', async () => {
    const siteStore = await mountApp()
    siteStore.theme.injectCSS = '.probe-css { color: red; }'
    await triggerApplyTheme()

    const styleEl = document.querySelector('#theme-inject-css')
    expect(styleEl).not.toBeNull()
    expect(styleEl.tagName).toBe('STYLE')
    expect(styleEl.textContent).toContain('.probe-css { color: red; }')
  })

  it('injectCSS: an empty value removes the previously-applied <style> element', async () => {
    const siteStore = await mountApp()
    siteStore.theme.injectCSS = '.probe-css { color: red; }'
    await triggerApplyTheme()
    expect(document.querySelector('#theme-inject-css')).not.toBeNull()

    siteStore.theme.injectCSS = ''
    await triggerApplyTheme()
    expect(document.querySelector('#theme-inject-css')).toBeNull()
  })

  it('injectHead: inserts markup into <head> and executes an embedded <script>', async () => {
    const siteStore = await mountApp()
    window.__appInjectHeadProbe = undefined
    siteStore.theme.injectHead =
      '<meta name="probe-head" content="1"><script>window.__appInjectHeadProbe = 42</script>'
    await triggerApplyTheme()

    try {
      const container = document.head.querySelector('#theme-inject-head')
      expect(container).not.toBeNull()
      expect(container.querySelector('meta[name="probe-head"]')).not.toBeNull()
      // -> The concrete side effect a re-created, actually-executed <script> performs
      expect(window.__appInjectHeadProbe).toBe(42)
    } finally {
      delete window.__appInjectHeadProbe
    }
  })

  it('injectBody: inserts markup into <body> and executes an embedded <script>', async () => {
    const siteStore = await mountApp()
    window.__appInjectBodyProbe = undefined
    siteStore.theme.injectBody =
      '<div id="probe-body-el"></div><script>window.__appInjectBodyProbe = "ran"</script>'
    await triggerApplyTheme()

    try {
      const container = document.body.querySelector('#theme-inject-body')
      expect(container).not.toBeNull()
      expect(container.querySelector('#probe-body-el')).not.toBeNull()
      expect(window.__appInjectBodyProbe).toBe('ran')
    } finally {
      delete window.__appInjectBodyProbe
    }
  })

  it('baseFont: sets the --font-sans custom property on the document root', async () => {
    const siteStore = await mountApp()
    siteStore.theme.baseFont = 'inter'
    siteStore.theme.contentFont = 'user'
    await triggerApplyTheme()

    expect(document.documentElement.style.getPropertyValue('--font-sans')).toContain('Inter')
  })

  it('contentFont: sets --font-content scoped to .page-contents, independently of --font-sans', async () => {
    const siteStore = await mountApp()
    siteStore.theme.baseFont = 'user'
    siteStore.theme.contentFont = 'montserrat'
    await triggerApplyTheme()

    const styleEl = document.querySelector('#theme-content-font')
    expect(styleEl).not.toBeNull()
    expect(styleEl.textContent).toContain('.page-contents')
    expect(styleEl.textContent).toContain('Montserrat')
    // -> contentFont must not leak into the app-wide font the same call cycle also touches
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('')
  })

  it('changing only baseFont leaves --font-content (and its Montserrat family) untouched', async () => {
    const siteStore = await mountApp()
    siteStore.theme.baseFont = 'user'
    siteStore.theme.contentFont = 'montserrat'
    await triggerApplyTheme()

    siteStore.theme.baseFont = 'inter'
    await triggerApplyTheme()

    expect(document.documentElement.style.getPropertyValue('--font-sans')).toContain('Inter')
    expect(document.querySelector('#theme-content-font').textContent).toContain('Montserrat')
  })

  /*
    Regression coverage for upstream requarks/wiki #2408 (closed): head/body code injection ran only
    on content pages, never on the auth/login screen, so an admin's analytics snippet or site-wide
    banner silently vanished for every visitor who hadn't logged in yet. There is no per-page
    injection call to gate here -- `applyTheme()` lives on `App.vue` itself, one level above
    `<router-view>`, and every route (including `/login`) mounts underneath it -- so this proves the
    site-wide behaviour holds by actually navigating to a non-content route rather than by reading
    the source.
  */
  it('injectHead/injectBody/injectCSS apply on the /login route, not just content pages', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.theme.injectCSS = '.probe-css { color: red; }'
    siteStore.theme.injectHead = '<meta name="probe-head" content="1">'
    siteStore.theme.injectBody = '<div id="probe-body-el"></div>'

    const router = await createTestRouter(
      ['/', { path: '/login', component: { template: '<div class="login-stub" />' } }],
      '/login'
    )

    const i18n = createTestI18n()
    currentWrapper = mount(App, { global: { plugins: [router, i18n] } })
    await triggerApplyTheme()

    expect(router.currentRoute.value.path).toBe('/login')
    expect(document.querySelector('#theme-inject-css')).not.toBeNull()
    expect(document.head.querySelector('#theme-inject-head')).not.toBeNull()
    expect(document.body.querySelector('#theme-inject-body')).not.toBeNull()
  })

  it('repeated applyTheme() calls (e.g. route navigation) do not duplicate injected elements', async () => {
    const siteStore = await mountApp()
    siteStore.theme.injectCSS = '.probe-css { color: red; }'
    siteStore.theme.injectHead = '<meta name="probe-head" content="1">'
    siteStore.theme.injectBody = '<div id="probe-body-el"></div>'
    siteStore.theme.baseFont = 'inter'
    siteStore.theme.contentFont = 'montserrat'

    await triggerApplyTheme()
    await triggerApplyTheme()
    await triggerApplyTheme()

    expect(document.querySelectorAll('#theme-inject-css').length).toBe(1)
    expect(document.head.querySelectorAll('#theme-inject-head').length).toBe(1)
    expect(document.body.querySelectorAll('#theme-inject-body').length).toBe(1)
    expect(document.querySelectorAll('#theme-content-font').length).toBe(1)
    // -> baseFont and contentFont name different families here, so exactly two stylesheet <link>s
    expect(document.head.querySelectorAll('link[data-theme-font]').length).toBe(2)
  })
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

/**
 * Regression coverage for OpenProject #809's follow-up: the Markdown editor's saved
 * preview-shown/width/font-size preferences used to only ever be fetched from
 * `EditorMarkdown.vue`'s own `onMounted`, once the reader had already clicked Edit -- putting a
 * network round trip on the critical path of the preview pane's entrance animation, which then ran
 * well past the side nav's own fixed-duration close. Prefetching them here, the moment the session's
 * profile is confirmed loaded, gives that fetch a head start long before any Edit click exists, so
 * `EditorMarkdown.vue`'s own mount usually finds the answer already sitting in the store.
 *
 * `siteStore.id` / `flagsStore.loaded` are pre-set the same way `mountAppWithLocale` sets them above,
 * so the bootstrap branch is skipped -- this prefetch is deliberately its own guard, independent of
 * that branch (see the doc comment on `hasPrefetchedMarkdownSettings` in `App.vue`), specifically so
 * it still fires on a navigation that skips bootstrap, which is exactly what these tests exercise.
 */
describe('App.vue Markdown editor settings prefetch', () => {
  function seedLoadedSession({ authenticated }) {
    const siteStore = useSiteStore()
    const flagsStore = useFlagsStore()
    const userStore = useUserStore()
    siteStore.id = 'site-1'
    flagsStore.loaded = true
    userStore.profileLoaded = true
    userStore.authenticated = authenticated
  }

  it('prefetches once the session profile is loaded, for an authenticated user', async () => {
    seedLoadedSession({ authenticated: true })
    const fetchUserSettings = vi.spyOn(useEditorStore(), 'fetchUserSettings').mockResolvedValue({})

    const router = buildTestRouter(['/'])
    const i18n = createTestI18n()
    mount(App, { global: { plugins: [router, i18n] } })

    await router.push('/')
    await router.isReady()

    expect(fetchUserSettings).toHaveBeenCalledWith('markdown')
  })

  it('does not prefetch for a guest (unauthenticated) session', async () => {
    seedLoadedSession({ authenticated: false })
    const fetchUserSettings = vi.spyOn(useEditorStore(), 'fetchUserSettings').mockResolvedValue({})

    const router = buildTestRouter(['/'])
    const i18n = createTestI18n()
    mount(App, { global: { plugins: [router, i18n] } })

    await router.push('/')
    await router.isReady()

    expect(fetchUserSettings).not.toHaveBeenCalled()
  })

  it('fires at most once per session, across multiple navigations', async () => {
    seedLoadedSession({ authenticated: true })
    const fetchUserSettings = vi.spyOn(useEditorStore(), 'fetchUserSettings').mockResolvedValue({})

    const router = buildTestRouter(['/', '/other'])
    const i18n = createTestI18n()
    mount(App, { global: { plugins: [router, i18n] } })

    await router.push('/')
    await router.isReady()
    await router.push('/other')

    expect(fetchUserSettings).toHaveBeenCalledTimes(1)
  })
})

/**
 * Regression coverage for OpenProject #816: nothing guarded against navigating away from an editor
 * with unsaved changes -- a breadcrumb, a side-nav item, a search result or a typed address all
 * discarded the in-progress edit silently, through the router's ordinary navigation. This is the one
 * choke point every one of those vectors goes through, which is what a memory router + `router.push()`
 * exercises here the same way a real click would.
 */
describe('App.vue router.beforeEach() unsaved-changes guard', () => {
  function seedReadySession() {
    const siteStore = useSiteStore()
    const flagsStore = useFlagsStore()
    const userStore = useUserStore()
    // -> Skips the bootstrap fetch branch entirely, same as the prefetch tests above
    siteStore.id = 'site-1'
    flagsStore.loaded = true
    userStore.profileLoaded = true
  }

  function makeRouter() {
    return buildTestRouter(['/', '/other'])
  }

  const MESSAGES = {
    editor: {
      unsaved: {
        title: 'Discard Unsaved Changes?',
        body: 'You have unsaved changes. Are you sure you want to leave the editor and discard any modifications you made since the last save?'
      }
    },
    common: {
      actions: {
        discard: 'Discard'
      }
    }
  }

  async function mountReady(router) {
    const i18n = createTestI18n(MESSAGES)
    mount(App, { global: { plugins: [router, i18n] } })
    await router.push('/')
    await router.isReady()
  }

  function makeDirty() {
    const editorStore = useEditorStore()
    editorStore.$patch({
      isActive: true,
      lastSaveTimestamp: Temporal.Now.instant(),
      lastChangeTimestamp: Temporal.Now.instant().add({ seconds: 1 })
    })
    return editorStore
  }

  it('blocks navigation and shows a confirm dialog when the editor is active with pending changes', async () => {
    seedReadySession()
    const router = makeRouter()
    await mountReady(router)
    makeDirty()

    const navPromise = router.push('/other')
    await flushPromises()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({
      title: 'Discard Unsaved Changes?',
      okLabel: 'Discard'
    })
    // -> Still pending: the guard's promise has not resolved yet
    expect(router.currentRoute.value.path).toBe('/')

    closeDialog(openDialogs[0].id, false)
    await navPromise
  })

  it('allows navigation and resets the editor once the discard is confirmed', async () => {
    seedReadySession()
    const router = makeRouter()
    await mountReady(router)
    const editorStore = makeDirty()

    const navPromise = router.push('/other')
    await flushPromises()
    closeDialog(openDialogs[0].id, true, true)
    await navPromise

    expect(router.currentRoute.value.path).toBe('/other')
    expect(editorStore.isActive).toBe(false)
    expect(editorStore.editor).toBe('')
    expect(editorStore.mode).toBe('edit')
  })

  /**
   * Regression: vue-router only cancels a superseded navigation (`checkCanceledNavigation`) once
   * every `beforeEach` guard in the queue -- including this one's `await` on the confirm dialog --
   * has resolved. A second navigation fired while the first's dialog is still open therefore reaches
   * this guard's own `isActive && hasPendingChanges` check too, which without the module-level
   * `isUnsavedChangesPromptOpen` flag would stack a second dialog against the same `editorStore`.
   */
  it('blocks a second navigation that fires while the first discard prompt is still open', async () => {
    seedReadySession()
    const router = makeRouter()
    await mountReady(router)
    const editorStore = makeDirty()
    const commonStore = useCommonStore()

    const firstNav = router.push('/other')
    await flushPromises()
    expect(openDialogs).toHaveLength(1)

    const secondNav = router.push('/other')
    await flushPromises()

    // -> Not a second dialog: the second navigation was blocked outright
    expect(openDialogs).toHaveLength(1)
    expect(router.currentRoute.value.path).toBe('/')
    /*
      Regression for OpenProject #819: the guard used to clear `routerLoading` when it blocked this
      second navigation, even though the FIRST navigation -- the one that actually set it, and whose
      prompt is still open right here -- has not resolved yet. Blocking the second one is not the
      first one completing, so this must still read true.
    */
    expect(commonStore.routerLoading).toBe(true)

    closeDialog(openDialogs[0].id, true, true)
    const [, secondResult] = await Promise.all([firstNav, secondNav])

    /*
      Which of the two `push()` calls actually lands on `/other` is vue-router's own call -- issuing a
      second `push()` supersedes the first regardless of what any guard decides, same as a plain double
      click would. What this guard owns, and what matters here, is that only one dialog ever showed
      (asserted above) and `editorStore` only resolved once: the second navigation was aborted by this
      guard's own re-entrancy check, not left to open a competing prompt.
    */
    expect(isNavigationFailure(secondResult, NavigationFailureType.aborted)).toBe(true)
    expect(editorStore.isActive).toBe(false)
    expect(openDialogs).toHaveLength(0)
  })

  it('blocks the navigation when the discard is cancelled', async () => {
    seedReadySession()
    const router = makeRouter()
    await mountReady(router)
    const editorStore = makeDirty()

    const navPromise = router.push('/other')
    await flushPromises()
    closeDialog(openDialogs[0].id, false)
    await navPromise

    expect(router.currentRoute.value.path).toBe('/')
    expect(editorStore.isActive).toBe(true)
  })

  it('navigates without prompting when the editor is active but has no pending changes', async () => {
    seedReadySession()
    const router = makeRouter()
    await mountReady(router)
    const editorStore = useEditorStore()
    const savedAt = Temporal.Now.instant()
    editorStore.$patch({
      isActive: true,
      lastSaveTimestamp: savedAt,
      lastChangeTimestamp: savedAt
    })

    await router.push('/other')

    expect(openDialogs).toHaveLength(0)
    expect(router.currentRoute.value.path).toBe('/other')
  })

  it('navigates without prompting when no editor is active at all', async () => {
    seedReadySession()
    const router = makeRouter()
    await mountReady(router)

    await router.push('/other')

    expect(openDialogs).toHaveLength(0)
    expect(router.currentRoute.value.path).toBe('/other')
  })

  /**
   * Regression for OpenProject #1129: Page Properties (e.g. an edited tag list) makes the page dirty
   * without ever setting `editorStore.isActive` -- the old `isActive && hasPendingChanges` guard let
   * this navigate away silently, discarding the edit with no warning at all.
   */
  it('blocks navigation and shows a confirm dialog when there are pending changes but no editor is active', async () => {
    seedReadySession()
    const router = makeRouter()
    await mountReady(router)
    const editorStore = useEditorStore()
    editorStore.$patch({
      lastSaveTimestamp: Temporal.Now.instant(),
      lastChangeTimestamp: Temporal.Now.instant().add({ seconds: 1 })
    })

    const navPromise = router.push('/other')
    await flushPromises()

    expect(openDialogs).toHaveLength(1)
    expect(router.currentRoute.value.path).toBe('/')

    closeDialog(openDialogs[0].id, true, true)
    await navPromise

    expect(router.currentRoute.value.path).toBe('/other')
  })
})

/**
 * OpenProject #951: `beforeEach` sets `commonStore.routerLoading = true` and `afterEach` (asserted
 * throughout the describe block above) is what clears it -- but vue-router does not run `afterEach`
 * when a navigation ERRORS, as opposed to being aborted/cancelled (which it DOES still fire for).
 * With no `router.onError` handler registered anywhere, the header spinner spins forever with
 * nothing telling the reader why. A guard that throws is used here as the trigger, rather than a
 * lazily-imported route whose dynamic `import()` rejects (the real-world cause a redeploy changing a
 * built asset's hash out from under an already-open tab would produce): vue-router's own async
 * component resolution leaves that rejection as a second, separately-surfacing unhandled promise
 * internally, which is a quirk of that codepath rather than anything this app's own error handling
 * could catch -- a thrown guard reaches `onError` (and rejects `router.push()`'s own promise) the
 * same way, with none of that noise.
 */
describe('App.vue router.onError() (OpenProject #951)', () => {
  function makeErrorRouter() {
    return buildTestRouter(['/', '/broken'])
  }

  it('clears the stuck routerLoading spinner and notifies once the navigation errors', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    const commonStore = useCommonStore()
    const router = makeErrorRouter()
    const i18n = createTestI18n({ common: { error: { navigationFailed: 'Navigation failed.' } } })
    mount(App, { global: { plugins: [router, i18n] } })
    await router.push('/')
    await router.isReady()

    // -> Registered AFTER `App.vue`'s own `beforeEach` (added when it mounted, above), so App's
    //    guard -- and its `commonStore.routerLoading = true` -- still runs before this one throws.
    router.beforeEach((to) => {
      if (to.path === '/broken') {
        return Promise.reject(new Error('Simulated guard failure'))
      }
    })

    // -> `.catch()` chained in the same synchronous statement that creates the promise, not attached
    //    later: vue-router's guard runner (`runWithContext`) wraps the guard call in its own internal
    //    promise, and Node's unhandled-rejection tracking can flag that inner promise before a
    //    `.catch()` attached on a later tick reaches it, even though it IS eventually handled here.
    const failedPush = router.push('/broken').catch(() => {})
    await flushPromises()
    await failedPush
    await flushPromises()

    expect(commonStore.routerLoading).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative', message: 'Navigation failed.' })
  })
})

/**
 * OpenProject #1360/#2208 (2026-08-24 security audit §2): the `'logout'` `EVENT_BUS` handler used to
 * treat ANY `scheme://` prefix as "leaving the wiki" and call `window.location.assign()` on it
 * directly — `javascript://%0aalert(1)` matches that same generic pattern, and a browser executes it
 * as script once it decodes the `%0a` into a real newline (the `//` becomes a JS line comment, ending
 * before `alert(1)`). `redirect` is a group's `redirectOnLogout`, so the actual attacker is whoever
 * holds `manage:groups` (or `write:pages`-adjacent delegation) on the group a victim is a member of —
 * every member of that group gets this run on their next logout.
 */
describe('App.vue logout handler (OpenProject #2208)', () => {
  function makeRouter() {
    return buildTestRouter(['/', '/other'])
  }

  async function mountReady(router) {
    const i18n = createTestI18n()
    currentWrapper = mount(App, { global: { plugins: [router, i18n] } })
    await router.push('/')
    await router.isReady()
  }

  async function emitLogout(redirect) {
    EVENT_BUS.emit('logout', { redirect })
    await flushPromises()
  }

  // -> `window.location.assign` is a genuine global: a spy left in place from one test would keep
  //    wrapping itself (and keep its recorded calls) into the next one.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refuses a javascript: redirect and routes to / internally instead of assigning it', async () => {
    const router = makeRouter()
    await mountReady(router)
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await emitLogout('javascript://%0aalert(1)')

    expect(assign).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('refuses a scheme-relative //host redirect the same way', async () => {
    const router = makeRouter()
    await mountReady(router)
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await emitLogout('//attacker.example')

    expect(assign).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('still leaves the wiki via window.location.assign for a genuine https:// redirect', async () => {
    const router = makeRouter()
    await mountReady(router)
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await emitLogout('https://idp.example.com/logged-out')

    expect(assign).toHaveBeenCalledWith('https://idp.example.com/logged-out')
    // -> Not routed internally as well -- the two are mutually exclusive branches
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('still routes a same-origin path internally, unaffected by the scheme check', async () => {
    const router = makeRouter()
    await mountReady(router)
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await emitLogout('/other')

    expect(assign).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/other')
  })

  it('routes to / when no redirect is given at all', async () => {
    const router = makeRouter()
    await mountReady(router)
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})

    await emitLogout(undefined)

    expect(assign).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
  })
})
