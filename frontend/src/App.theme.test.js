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
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import { useSiteStore } from '@/stores/site'
import { createTestI18n } from '../test/i18n.js'

import { createTestRouter } from '../test/router.js'

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
