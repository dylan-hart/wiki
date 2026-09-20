// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
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
 * Fetched from `EditorMarkdown.vue`'s own `onMounted` instead, the Markdown editor's saved
 * preview/width/font-size preferences put a network round trip on the critical path of the preview
 * pane's entrance animation. Prefetching the moment the session profile is confirmed loaded gives
 * that fetch a head start long before any Edit click exists.
 *
 * `siteStore.id` / `flagsStore.loaded` are pre-set so the bootstrap branch is skipped: the prefetch
 * is its own guard (`hasPrefetchedMarkdownSettings` in `App.vue`) precisely so it still fires on a
 * navigation that skips bootstrap, which is what these tests exercise.
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
