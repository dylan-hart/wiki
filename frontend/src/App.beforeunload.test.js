// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
//
// `App.vue` registers its `beforeunload` listener directly in `<script setup>` rather than in
// `onMounted`/`onUnmounted`, so a `mount(App, ...)` that is never unmounted leaves the listener
// attached to the shared `window`. This suite lives in its own file (Vitest isolates test files from
// one another) so only listeners its own tests register are ever in play.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import App from './App.vue'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../test/i18n.js'

import { buildTestRouter } from '../test/router.js'

const UNSAVED_WARNING = 'You have unsaved edits. Are you sure you want to leave the editor?'

/**
 * The router-level unsaved-changes guard (`App.navGuard.test.js`) only fires for an in-SPA
 * navigation. Typing a new address into the bar, following an external link, closing the tab or
 * refreshing never goes through vue-router at all -- it is a `beforeunload` event on `window`.
 */
describe('App.vue window beforeunload guard', () => {
  let addEventListenerSpy
  let capturedHandler

  /**
   * The session is seeded as already "loaded" so the initial navigation resolves without a bootstrap
   * fetch. The handler is pulled out of the spy so each test can call it directly with a fake event,
   * rather than dispatching a real one at `window` and risking a stale listener from another test.
   */
  async function mountReady() {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    const flagsStore = useFlagsStore()
    const userStore = useUserStore()
    siteStore.id = 'site-1'
    flagsStore.loaded = true
    userStore.profileLoaded = true

    const router = buildTestRouter(['/'])
    const i18n = createTestI18n({ editor: { unsavedWarning: UNSAVED_WARNING } })

    addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    mount(App, { global: { plugins: [router, i18n] } })
    await router.push('/')
    await router.isReady()

    capturedHandler = addEventListenerSpy.mock.calls.find(([type]) => type === 'beforeunload')?.[1]
    return useEditorStore()
  }

  function makeEvent() {
    return { preventDefault: vi.fn(), returnValue: '' }
  }

  afterEach(() => {
    if (capturedHandler) {
      window.removeEventListener('beforeunload', capturedHandler)
      capturedHandler = undefined
    }
    addEventListenerSpy?.mockRestore()
  })

  it('registers a beforeunload listener on mount', async () => {
    await mountReady()

    expect(capturedHandler).toBeInstanceOf(Function)
  })

  it('prevents the unload and sets returnValue when the editor is active with pending changes', async () => {
    const editorStore = await mountReady()
    editorStore.$patch({
      isActive: true,
      lastSaveTimestamp: Temporal.Now.instant(),
      lastChangeTimestamp: Temporal.Now.instant().add({ seconds: 1 })
    })

    const event = makeEvent()
    capturedHandler(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.returnValue).toBe(UNSAVED_WARNING)
  })

  it('does not prevent the unload when the editor is active but has no pending changes', async () => {
    const editorStore = await mountReady()
    const savedAt = Temporal.Now.instant()
    editorStore.$patch({ isActive: true, lastSaveTimestamp: savedAt, lastChangeTimestamp: savedAt })

    const event = makeEvent()
    capturedHandler(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.returnValue).toBe('')
  })

  it('does not prevent the unload when no editor is active at all', async () => {
    await mountReady()

    const event = makeEvent()
    capturedHandler(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.returnValue).toBe('')
  })

  // -> Page Properties (an edited tag list, say) dirties the page without ever setting `isActive`.
  it('prevents the unload and sets returnValue when there are pending changes but no editor is active', async () => {
    const editorStore = await mountReady()
    editorStore.$patch({
      lastSaveTimestamp: Temporal.Now.instant(),
      lastChangeTimestamp: Temporal.Now.instant().add({ seconds: 1 })
    })

    const event = makeEvent()
    capturedHandler(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.returnValue).toBe(UNSAVED_WARNING)
  })

  it('does not prevent the unload once the editor is reset back to inactive after being dirty', async () => {
    const editorStore = await mountReady()
    editorStore.$patch({
      isActive: true,
      lastSaveTimestamp: Temporal.Now.instant(),
      lastChangeTimestamp: Temporal.Now.instant().add({ seconds: 1 })
    })
    /*
      Equalizing the timestamps alongside `isActive: false` is what a real discard does -- it reaches
      `pageStore.cancelPageEdit()` -> `pageLoad()`, which resets both as its baseline -- rather than
      only flipping `isActive`. The guard condition is `hasPendingChanges` alone, so leaving them
      unequal would assert against a state a real discard never produces.
    */
    const resetAt = Temporal.Now.instant()
    editorStore.$patch({
      isActive: false,
      editor: '',
      mode: 'edit',
      lastSaveTimestamp: resetAt,
      lastChangeTimestamp: resetAt
    })

    const event = makeEvent()
    capturedHandler(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.returnValue).toBe('')
  })
})
