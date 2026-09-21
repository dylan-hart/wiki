// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
//
// Two happy-dom defaults get in the way here:
//   - `enableJavaScriptEvaluation` (off by default) is what makes the injectHead/injectBody "no
//     script runs" assertions meaningful: with it off, a script would not run either way.
//   - `disableCSSFileLoading` + `handleDisabledFileLoadingAsSuccess` quiet the `NetworkError`/
//     `NotSupportedError` noise from `applyFonts()`'s real `<link rel="stylesheet">` elements, which
//     have nothing to fetch from in this test run.
//
// The layer the per-helper suites don't cover: that `applyTheme()` WIRES the font settings to their
// helper with the right field, on the `EVENT_BUS` path a real admin save takes, without piling up
// duplicate DOM nodes on repeat triggers.
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
  it('injectCSS: the client adds no <style> element for it', async () => {
    const siteStore = await mountApp()
    siteStore.theme.injectCSS = '.probe-css { color: red; }'
    await triggerApplyTheme()

    expect(document.querySelector('#theme-inject-css')).toBeNull()
    expect(document.head.innerHTML).not.toContain('.probe-css')
  })

  it('injectHead: the client inserts nothing and runs no embedded <script>', async () => {
    const siteStore = await mountApp()
    window.__appInjectHeadProbe = undefined
    siteStore.theme.injectHead =
      '<meta name="probe-head" content="1"><script>window.__appInjectHeadProbe = 42</script>'
    await triggerApplyTheme()

    try {
      expect(document.head.querySelector('#theme-inject-head')).toBeNull()
      expect(document.head.querySelector('meta[name="probe-head"]')).toBeNull()
      expect(window.__appInjectHeadProbe).toBeUndefined()
    } finally {
      delete window.__appInjectHeadProbe
    }
  })

  it('injectBody: the client inserts nothing and runs no embedded <script>', async () => {
    const siteStore = await mountApp()
    window.__appInjectBodyProbe = undefined
    siteStore.theme.injectBody =
      '<div id="probe-body-el"></div><script>window.__appInjectBodyProbe = "ran"</script>'
    await triggerApplyTheme()

    try {
      expect(document.body.querySelector('#theme-inject-body')).toBeNull()
      expect(document.body.querySelector('#probe-body-el')).toBeNull()
      expect(window.__appInjectBodyProbe).toBeUndefined()
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

  it('injectHead/injectBody/injectCSS add nothing on the /login route either', async () => {
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
    expect(document.querySelector('#theme-inject-css')).toBeNull()
    expect(document.head.querySelector('#theme-inject-head')).toBeNull()
    expect(document.body.querySelector('#theme-inject-body')).toBeNull()
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

    expect(document.querySelectorAll('#theme-inject-css').length).toBe(0)
    expect(document.head.querySelectorAll('#theme-inject-head').length).toBe(0)
    expect(document.body.querySelectorAll('#theme-inject-body').length).toBe(0)
    expect(document.querySelectorAll('#theme-content-font').length).toBe(1)
    // -> baseFont and contentFont name different families here, so exactly two stylesheet <link>s
    expect(document.head.querySelectorAll('link[data-theme-font]').length).toBe(2)
  })
})
