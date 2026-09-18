import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { usePageScripts } from './pageScripts.js'

const mockRoute = reactive({ path: '/some/page' })

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute
}))

const STYLE_ID = 'page-styles'

/**
 * The composable registers a `watch(..., { immediate: true })` and an `onScopeDispose`, so it needs a
 * real component instance to attach to, the same way `adminOverlayRoute.test.js` mounts one for its
 * `onMounted`/`onBeforeUnmount` pair.
 */
function mountPageScripts() {
  return mount({
    setup() {
      usePageScripts()
      return () => null
    }
  })
}

function currentCss() {
  return document.getElementById(STYLE_ID)?.textContent ?? null
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockRoute.path = '/some/page'
})

afterEach(() => {
  // -> Each test mounts its own component; a wrapper that forgot to unmount would otherwise leak a
  //    `<style>` into the next test's `document.head`.
  document.getElementById(STYLE_ID)?.remove()
})

describe('usePageScripts()', () => {
  it('applies the page CSS on mount when the site flag is on', () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }' })

    mountPageScripts()

    expect(currentCss()).toBe('body { color: red }')
  })

  it('injects nothing while the site flag is off, even with a page and CSS in the store', () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = false
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }' })

    mountPageScripts()

    expect(currentCss()).toBeNull()
  })

  it('injects nothing for a locked page', () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }', isLocked: true })

    mountPageScripts()

    expect(currentCss()).toBeNull()
  })

  it('injects nothing on a 404', () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: '', scriptCss: '', notFound: true })

    mountPageScripts()

    expect(currentCss()).toBeNull()
  })

  it('injects nothing while an editor is open over the page (editorStore.isActive)', () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }' })
    editorStore.isActive = true

    mountPageScripts()

    expect(currentCss()).toBeNull()
  })

  it('injects nothing on the /_edit route, even before editorStore.isActive flips true', () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }' })
    mockRoute.path = '/_edit/some/page'

    mountPageScripts()

    expect(currentCss()).toBeNull()
  })

  it('injects nothing on the /_create route', () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }' })
    mockRoute.path = '/_create/markdown'

    mountPageScripts()

    expect(currentCss()).toBeNull()
  })

  it('replaces the CSS in place, rather than stacking a second element, on navigation to a page with different CSS', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }' })

    mountPageScripts()
    expect(currentCss()).toBe('body { color: red }')

    pageStore.$patch({ id: 'page-2', scriptCss: 'body { color: blue }' })
    await nextTick()

    expect(currentCss()).toBe('body { color: blue }')
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1)
  })

  it('removes the style on navigating to a page with no CSS', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }' })

    mountPageScripts()
    expect(currentCss()).toBe('body { color: red }')

    pageStore.$patch({ id: 'page-2', scriptCss: '' })
    await nextTick()

    expect(currentCss()).toBeNull()
  })

  it('blanks the style once a locked page is reached', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }' })

    mountPageScripts()
    expect(currentCss()).toBe('body { color: red }')

    // -> `pageLoad()` blanks `isLocked`/`notFound` up front and the server never sends `scriptCss`
    //    for a locked page either -- mirrored here as the store would actually end up.
    pageStore.$patch({ isLocked: true, scriptCss: '' })
    await nextTick()

    expect(currentCss()).toBeNull()
  })

  it('removes the style once the editor opens over the page on screen', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }' })

    mountPageScripts()
    expect(currentCss()).toBe('body { color: red }')

    editorStore.isActive = true
    await nextTick()

    expect(currentCss()).toBeNull()
  })

  it('clears the style when the page view itself unmounts', () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptCss: 'body { color: red }' })

    const wrapper = mountPageScripts()
    expect(currentCss()).toBe('body { color: red }')

    wrapper.unmount()

    expect(currentCss()).toBeNull()
  })
})

/**
 * The JS half (OpenProject #3405): `scriptJsLoad`/`scriptJsUnload` are never embedded as text on the
 * page -- they are `import()`ed from the external module `controllers/pageScripts.ts` serves, at
 * `/_pages/<id>/script.js`. Nothing under that path actually exists in this Vitest environment (no
 * dev-server proxy, no backend), so every real `import()` attempt here rejects -- the same
 * "the import itself fails in this environment" convention `stores/common.test.js`'s `loadBlocks()`
 * suite documents and relies on for its own dynamic `import()` coverage. That leaves two things these
 * tests CAN verify directly: (1) the gating -- an import is attempted at all only when the site flag
 * is on, the page is showing, and it actually has a script set, mirrored 1:1 off the CSS gating
 * tests above; and (2) that a failed import is caught and logged rather than left an unhandled
 * rejection. The success path (`load()`/`unload()` actually invoked) is e2e territory, not unit --
 * left to #3406's `enforceCsp` case.
 */
describe('usePageScripts(): JS half (OpenProject #3405)', () => {
  let warnSpy
  /** Tracked so `afterEach` can tear it down -- see the comment there for why that matters here. */
  let wrapper

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    wrapper = null
  })

  afterEach(() => {
    // -> Every test below that reaches an import attempt starts a REAL dynamic import(), which only
    //    settles (rejects, in this environment) asynchronously. A component left mounted past its
    //    own test keeps that watcher's closure alive, and when the rejection finally lands it calls
    //    `console.warn` -- i.e. whichever LATER test's spy happens to be active at that moment, not
    //    this test's own assertion. Unmounting here (which also exercises `onScopeDispose()`'s own
    //    `unload()` path) is what keeps each test's warning count its own.
    wrapper?.unmount()
    warnSpy.mockRestore()
  })

  it('attempts to import the page script module when the flag is on and scriptJsLoad is set', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptJsLoad: "console.log('hi')" })

    wrapper = mountPageScripts()

    // -> One warning: the real import() attempt this environment cannot serve rejected, and was
    //    caught rather than thrown. `vi.waitFor` rather than a single `flushPromises()`: the
    //    module-runner's own resolution takes more than one microtask turn to reject.
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1))
  })

  it('attempts an import when only scriptJsUnload is set', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptJsUnload: "console.log('bye')" })

    wrapper = mountPageScripts()

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1))
  })

  it('attempts no import when the page has neither scriptJsLoad nor scriptJsUnload', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptJsLoad: '', scriptJsUnload: '' })

    wrapper = mountPageScripts()
    await flushPromises()

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('attempts no import while the site flag is off, even with scriptJsLoad set', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = false
    pageStore.$patch({ id: 'page-1', scriptJsLoad: "console.log('hi')" })

    wrapper = mountPageScripts()
    await flushPromises()

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('attempts no import for a locked page', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptJsLoad: "console.log('hi')", isLocked: true })

    wrapper = mountPageScripts()
    await flushPromises()

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('attempts no import on a 404', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: '', scriptJsLoad: "console.log('hi')", notFound: true })

    wrapper = mountPageScripts()
    await flushPromises()

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('attempts no import while an editor is open over the page', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptJsLoad: "console.log('hi')" })
    editorStore.isActive = true

    wrapper = mountPageScripts()
    await flushPromises()

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('attempts no import on the /_edit route', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptJsLoad: "console.log('hi')" })
    mockRoute.path = '/_edit/some/page'

    wrapper = mountPageScripts()
    await flushPromises()

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('attempts a fresh import on navigation to a different page with its own script', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptJsLoad: "console.log('one')" })

    wrapper = mountPageScripts()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1))

    pageStore.$patch({ id: 'page-2', scriptJsLoad: "console.log('two')" })
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(2))
  })

  it('does not throw on unmount with no script ever loaded', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptJsLoad: '' })

    wrapper = mountPageScripts()
    await flushPromises()

    expect(() => wrapper.unmount()).not.toThrow()
    wrapper = null // -> Already unmounted; afterEach's own unmount() call would double-unmount.
  })

  it('does not throw on unmount while an import is in flight', () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptJsLoad: "console.log('hi')" })

    wrapper = mountPageScripts()

    // -> Unmounted synchronously, before the in-flight import's rejection has even been awaited --
    //    the generation counter this guards against is exactly for a scope disposed mid-import.
    expect(() => wrapper.unmount()).not.toThrow()
    wrapper = null // -> Already unmounted; afterEach's own unmount() call would double-unmount.
  })
})
