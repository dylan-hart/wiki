// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
//
// Two happy-dom defaults get in the way here:
//   - `enableJavaScriptEvaluation` (off by default) is required for the injectHead/injectBody
//     `<script>` assertions below to actually run the script.
//   - `disableCSSFileLoading` + `handleDisabledFileLoadingAsSuccess` quiet the `NetworkError`/
//     `NotSupportedError` noise from `applyFonts()`'s real `<link rel="stylesheet">` elements, which
//     have nothing to fetch from in this test run.
//
// The layer the per-helper suites don't cover: that `applyTheme()` WIRES each site-theme setting to
// its helper with the right field, on the `EVENT_BUS` path a real admin save takes. A helper working
// in isolation doesn't prove `applyTheme()` still calls it, still passes the field it means to, or
// still calls it on every repeat trigger without piling up duplicate DOM nodes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import { useSiteStore } from '@/stores/site'
import { createTestI18n } from '../test/i18n.js'

import { createTestRouter } from '../test/router.js'

let currentWrapper

/**
 * The router navigates to `/` and resolves BEFORE `App` is mounted, so `App.vue`'s own
 * `router.afterEach` guard (registered when its `<script setup>` runs, i.e. at mount) never fires
 * here. Theme application is triggered explicitly instead, below.
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
 * The same `EVENT_BUS` event `AdminTheme.vue`'s `save()` fires. `EVENT_BUS.emit()` does not await
 * its listener, hence the tick for `applyTheme()`'s trailing `await applyCodeBlocksTheme()`.
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
    `applyTheme()` lives on `App.vue` itself, one level above `<router-view>`, so there is no
    per-page injection call to gate: the site-wide behaviour is proved by actually navigating to a
    non-content route rather than by reading the source.
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
