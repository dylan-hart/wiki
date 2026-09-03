// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
//
// Same happy-dom environment options as `App.test.js`, for the same reasons (see that file's own
// header) -- `App.vue` renders the same tree either way.
//
// Split into its own file rather than folded into `App.test.js`'s "router.beforeEach() unsaved-changes
// guard" suite: `App.vue` registers the `beforeunload` listener directly in `<script setup>` (matching
// its `EVENT_BUS.on(...)` handlers) rather than in `onMounted`/`onUnmounted`, and none of `App.test.js`'s
// several `mount(App, ...)` calls ever unmount their wrapper -- each leaves its own listener attached to
// the shared `window` for the rest of that file's run. That is harmless as long as nothing dispatches a
// real `beforeunload` event there, which nothing did until this WP. Isolating this suite in its own file
// (Vitest isolates test files from one another by default) means only listeners THIS file's own tests
// register are ever in play, and the per-test cleanup below keeps them from piling up even so.
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
 * Regression coverage for OpenProject #818: the router-level unsaved-changes guard (`App.test.js`'s
 * own `router.beforeEach()` suite, OpenProject #816) only fires for an in-SPA navigation. Typing a new
 * address into the bar, following an external link, closing the tab, or refreshing a page never goes
 * through vue-router at all -- it is a `beforeunload` event on `window`, which `App.vue` now also
 * listens for.
 */
describe('App.vue window beforeunload guard', () => {
  let addEventListenerSpy
  let capturedHandler

  /**
   * Mounts the real `App.vue` with a session already "loaded" (same shortcut `App.test.js`'s router
   * guard suite uses) so the initial navigation resolves without a bootstrap fetch, then pulls the
   * exact function `App.vue` passed to `addEventListener('beforeunload', ...)` out of the spy -- so
   * each test can call it directly with a fake event, rather than dispatching a real one at `window`
   * and risking picking up a stale listener an earlier test in this file left behind.
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

  /**
   * Regression for OpenProject #1129: Page Properties (e.g. an edited tag list) makes the page dirty
   * without ever setting `editorStore.isActive` -- the old `isActive && hasPendingChanges` guard let
   * a tab close or address-bar navigation through with no warning at all in that case.
   */
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
      Equalizing the timestamps here alongside `isActive: false` is what a real discard actually
      does -- `PageHeader.vue`'s own `discardChanges` reaches it via `pageStore.cancelPageEdit()` ->
      `pageLoad()`, which resets both as its baseline -- rather than only flipping `isActive`. Guard
      condition is `hasPendingChanges` alone since OpenProject #1129 (Page Properties can dirty the
      page with `isActive` already false), so leaving the timestamps unequal here would leave this
      test asserting against a state a real discard never actually produces.
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
