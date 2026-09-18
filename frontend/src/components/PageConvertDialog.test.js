import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

/**
 * The headless round trip itself -- parsing the page's markdown into a copy of the WYSIWYG node
 * set and serializing it back out -- is `@tiptap/markdown` plus the constructs OpenProject
 * #3396/#3397/#3398 already cover with their own round-trip suites (`src/editor/wysiwyg/*.test.js`,
 * `helpers/wysiwygStyleAttrs.test.js`). This suite is about `PageConvertDialog.vue`'s OWN logic --
 * which editor it targets, how it reacts to the guard's verdict, and what it does when Convert is
 * clicked -- so `@tiptap/core`'s `Editor` is replaced with a controllable double rather than
 * exercising real ProseMirror parsing here too.
 */
const roundTripState = vi.hoisted(() => ({ markdown: null, throws: false }))

vi.mock('@tiptap/core', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    Editor: vi.fn().mockImplementation(function (opts) {
      if (roundTripState.throws) {
        throw new Error('could not parse this into the wysiwyg node set')
      }
      return {
        getMarkdown: () => roundTripState.markdown ?? opts.content,
        destroy: () => {}
      }
    })
  }
})

import PageConvertDialog from './PageConvertDialog.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useEditorStore } from '@/stores/editor'
import { useCommonStore } from '@/stores/common'

import { createTestI18n } from '../../test/i18n.js'

function mountDialog({ editor = 'markdown', content = '# Hello', path = 'docs/example' } = {}) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.$patch({ id: 'page-1', editor, content, path })
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  const editorStore = useEditorStore()
  // -> Already loaded, so `ensureConfigs()` only re-fetches glossary terms -- a call the ambient
  //    `API_CLIENT` stub answers with `undefined`, which `refreshGlossaryTerms()`'s own try/catch
  //    already swallows (see its doc comment in `stores/editor.js`).
  editorStore.configIsLoaded = true
  editorStore.editors = { markdown: {} }
  useCommonStore()

  const i18n = createTestI18n()
  const wrapper = mount(PageConvertDialog, {
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  return { wrapper, pageStore, siteStore, editorStore }
}

function findButton(text) {
  return [...document.body.querySelectorAll('button')].find((b) => b.textContent.includes(text))
}

describe('PageConvertDialog', () => {
  beforeEach(() => {
    roundTripState.markdown = null
    roundTripState.throws = false
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows a checking state while the guard is still running', async () => {
    const { wrapper } = mountDialog()
    // -> A couple of ticks only: enough for `useDialogComponent()`'s own `onMounted` (itself a
    //    `nextTick()`) to flip `dialogVisible` and render the panel, not enough for `runGuard()`'s
    //    awaited `ensureConfigs()` (an async call several microtask hops deeper) to have resolved.
    await nextTick()
    await nextTick()

    expect(document.body.textContent).toContain('pageConvertDialog.checking')

    wrapper.unmount()
  })

  it('targets wysiwyg for a markdown page, and markdown for a wysiwyg page', async () => {
    const markdownPage = mountDialog({ editor: 'markdown' })
    await flushPromises()
    expect(markdownPage.wrapper.vm.targetEditor).toBe('wysiwyg')
    markdownPage.wrapper.unmount()

    const wysiwygPage = mountDialog({ editor: 'wysiwyg' })
    await flushPromises()
    expect(wysiwygPage.wrapper.vm.targetEditor).toBe('markdown')
    wysiwygPage.wrapper.unmount()
  })

  it('offers Convert once the guard finds the round trip renders identically', async () => {
    roundTripState.markdown = '# Hello'
    const { wrapper } = mountDialog({ content: '# Hello' })
    await flushPromises()
    await flushPromises()

    expect(document.body.textContent).toContain('pageConvertDialog.safeToConvert')
    expect(findButton('pageConvertDialog.convert')).toBeTruthy()

    wrapper.unmount()
  })

  it('refuses and points at the first differing line when the round trip changes the content', async () => {
    roundTripState.markdown = 'Line one\nCHANGED HERE\nLine three'
    const { wrapper } = mountDialog({ content: 'Line one\nLine two\nLine three' })
    await flushPromises()
    await flushPromises()

    expect(document.body.textContent).toContain('pageConvertDialog.refused')
    expect(document.body.textContent).toContain('pageConvertDialog.firstDifferenceLine')
    expect(document.body.textContent).toContain('Line two')
    expect(document.body.textContent).toContain('CHANGED HERE')
    expect(findButton('pageConvertDialog.convert')).toBeFalsy()

    wrapper.unmount()
  })

  it('treats a parse failure as a refusal, not a crash', async () => {
    roundTripState.throws = true
    const { wrapper } = mountDialog({ content: 'anything at all' })
    await flushPromises()
    await flushPromises()

    expect(document.body.textContent).toContain('pageConvertDialog.refused')
    expect(findButton('pageConvertDialog.convert')).toBeFalsy()

    wrapper.unmount()
  })

  it('calls pageStore.convertEditor with the target editor and emits ok when Convert is clicked', async () => {
    roundTripState.markdown = '# Hello'
    const { wrapper, pageStore } = mountDialog({ editor: 'markdown', content: '# Hello' })
    await flushPromises()
    await flushPromises()
    vi.spyOn(pageStore, 'convertEditor').mockResolvedValue(undefined)

    findButton('pageConvertDialog.convert').dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(pageStore.convertEditor).toHaveBeenCalledWith({ id: 'page-1', editor: 'wysiwyg' })
    expect(wrapper.emitted('ok')).toBeTruthy()

    wrapper.unmount()
  })

  it('notifies and does not emit ok when convertEditor rejects', async () => {
    roundTripState.markdown = '# Hello'
    const { wrapper, pageStore } = mountDialog({ editor: 'markdown', content: '# Hello' })
    await flushPromises()
    await flushPromises()
    vi.spyOn(pageStore, 'convertEditor').mockRejectedValue(new Error('server said no'))

    findButton('pageConvertDialog.convert').dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('ok')).toBeFalsy()

    wrapper.unmount()
  })

  it('emits hide with no ok when cancelled', async () => {
    roundTripState.markdown = '# Hello'
    const { wrapper } = mountDialog({ content: '# Hello' })
    await flushPromises()
    await flushPromises()

    const cancelBtn = findButton('common.actions.cancel')
    expect(cancelBtn).toBeTruthy()
    cancelBtn.dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('ok')).toBeFalsy()

    wrapper.unmount()
  })
})
