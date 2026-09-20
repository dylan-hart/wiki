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

/** The composable's watchers and `onScopeDispose` need a real component scope to attach to. */
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
  // -> A wrapper that forgot to unmount leaks its `<style>` into the next test's `document.head`
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

    // -> The server never sends `scriptCss` for a locked page -- mirrored here as the store would
    //    actually end up.
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
 * Nothing serves `/_pages/<id>/script.js` in this environment, so every real `import()` here
 * rejects. That leaves the gating (whether an import is attempted at all) and that a failed import
 * is caught rather than left an unhandled rejection; the success path is e2e territory.
 */
describe('usePageScripts(): JS half (OpenProject #3405)', () => {
  let warnSpy
  let wrapper

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    wrapper = null
  })

  afterEach(() => {
    // -> A real dynamic import() settles asynchronously. A component left mounted past its own test
    //    keeps the watcher's closure alive, so the eventual rejection warns against whichever LATER
    //    test's spy is active. Unmounting here keeps each test's warning count its own.
    wrapper?.unmount()
    warnSpy.mockRestore()
  })

  it('attempts to import the page script module when the flag is on and scriptJsLoad is set', async () => {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    siteStore.features.pageScripts = true
    pageStore.$patch({ id: 'page-1', scriptJsLoad: "console.log('hi')" })

    wrapper = mountPageScripts()

    // -> `vi.waitFor` rather than a single `flushPromises()`: the module runner takes more than one
    //    microtask turn to reject.
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

    // -> Unmounted synchronously, before the in-flight import settles: the case the generation
    //    counter exists for.
    expect(() => wrapper.unmount()).not.toThrow()
    wrapper = null // -> Already unmounted; afterEach's own unmount() call would double-unmount.
  })
})
