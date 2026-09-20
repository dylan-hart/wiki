// @vitest-environment-options {"settings":{"enableJavaScriptEvaluation":true,"suppressInsecureJavaScriptEnvironmentWarning":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
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

describe('App.vue router.beforeEach() unsaved-changes guard', () => {
  function seedReadySession() {
    const siteStore = useSiteStore()
    const flagsStore = useFlagsStore()
    const userStore = useUserStore()
    // -> Skips the bootstrap fetch branch entirely
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
   * vue-router only cancels a superseded navigation (`checkCanceledNavigation`) once every
   * `beforeEach` guard in the queue -- including this one's `await` on the confirm dialog -- has
   * resolved. A second navigation fired while the first's dialog is still open therefore reaches
   * this guard's own check too, and without the module-level `isUnsavedChangesPromptOpen` flag would
   * stack a second dialog against the same `editorStore`.
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

    expect(openDialogs).toHaveLength(1)
    expect(router.currentRoute.value.path).toBe('/')
    // -> Blocking the second navigation is not the FIRST one completing -- its prompt is still open
    //    right here -- so the spinner it raised must still read true.
    expect(commonStore.routerLoading).toBe(true)

    closeDialog(openDialogs[0].id, true, true)
    const [, secondResult] = await Promise.all([firstNav, secondNav])

    /*
      Which of the two `push()` calls actually lands on `/other` is vue-router's own call -- a second
      `push()` supersedes the first regardless of what any guard decides. What this guard owns is
      that the second navigation was aborted by its own re-entrancy check rather than left to open a
      competing prompt.
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

  // -> Page Properties (an edited tag list, say) dirties the page without ever setting `isActive`.
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
 * `beforeEach` raises `commonStore.routerLoading` and `afterEach` clears it -- but vue-router does
 * not run `afterEach` when a navigation ERRORS, as opposed to being aborted or cancelled (which it
 * DOES still fire for), so without `router.onError` the header spinner spins forever.
 *
 * The trigger is a throwing guard rather than a route whose dynamic `import()` rejects (the
 * real-world cause: a redeploy changing a built asset's hash under an open tab). vue-router's async
 * component resolution leaves that rejection as a second, separately-surfacing unhandled promise
 * internally; a thrown guard reaches `onError` the same way with none of that noise.
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

    // -> Registered AFTER `App.vue`'s own `beforeEach`, so App's guard -- and its
    //    `commonStore.routerLoading = true` -- still runs before this one throws.
    router.beforeEach((to) => {
      if (to.path === '/broken') {
        return Promise.reject(new Error('Simulated guard failure'))
      }
    })

    // -> `.catch()` chained in the same synchronous statement, not attached later: vue-router wraps
    //    the guard call in its own internal promise, and Node's unhandled-rejection tracking can
    //    flag that inner promise before a `.catch()` attached on a later tick reaches it.
    const failedPush = router.push('/broken').catch(() => {})
    await flushPromises()
    await failedPush
    await flushPromises()

    expect(commonStore.routerLoading).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative', message: 'Navigation failed.' })
  })
})
