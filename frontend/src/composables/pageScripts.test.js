import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
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
