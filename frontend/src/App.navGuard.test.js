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
