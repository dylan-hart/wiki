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
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import { useSiteStore } from '@/stores/site'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { useUserStore } from '@/stores/user'
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
