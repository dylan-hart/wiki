import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'

import EditorWysiwyg from './EditorWysiwyg.vue'
import { usePageStore } from '@/stores/page'

/**
 * Regression coverage for task 484: the eleven `@tiptap/*` packages this component imports were
 * absent from `package.json`, so `EditorWysiwyg.vue` could not build at all and its `wysiwyg` entry
 * in `Index.vue`'s `editorComponents` map stayed commented out. Two of the imports also used tiptap
 * v2's default-export shape (`import Table from '@tiptap/extension-table'`,
 * `import TextStyle from '@tiptap/extension-text-style'`) which no longer exists in the v3 line
 * pinned here — both packages only re-export the extension by name now — so the build failed with
 * `MISSING_EXPORT` even once the dependencies were installed.
 */
function mountEditor(initialContent) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = initialContent

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(EditorWysiwyg, {
    global: { plugins: [i18n] }
  })

  return { wrapper, pageStore }
}

describe('EditorWysiwyg', () => {
  it('renders the page store content into the document instead of a blank editor', async () => {
    // -> Plain text, not HTML: `init()`'s `pageStore.content.startsWith('{')` check treats anything
    //    else as plain text and wraps it in a single `<p>` itself, so wrapping it here too would
    //    nest `<p>` tags and, being invalid HTML, get silently split into an extra empty paragraph
    //    by the parser -- a pre-existing quirk of that heuristic, not what this test is after.
    const { wrapper } = mountEditor('Hello from Wiki.js')
    // -> `EditorContent` (from `@tiptap/vue-3`) mounts the ProseMirror view itself on its own
    //    `onMounted`, one tick after the wrapping `<div>` above it lands in the DOM -- a single
    //    `nextTick()` flushes the parent render but not that child's follow-up mount.
    await nextTick()
    await nextTick()

    expect(wrapper.find('.ProseMirror').exists()).toBe(true)
    expect(wrapper.find('.ProseMirror').text()).toContain('Hello from Wiki.js')

    wrapper.unmount()
  })

  it('round-trips typed content into the page store as TipTap JSON and rendered HTML', async () => {
    const { wrapper, pageStore } = mountEditor('<p></p>')
    await nextTick()

    wrapper.vm.editor.chain().focus().insertContent('Typed content').run()
    await nextTick()

    // -> Matches the `pageCreate`/`pageUpdate` flow in `backend/models/pages.ts`: `content` is the
    //    TipTap JSON document serialized to a string, `render` is the HTML tiptap derives from it.
    expect(pageStore.contentLoaded).toBe(true)
    expect(pageStore.render).toContain('Typed content')
    expect(() => JSON.parse(pageStore.content)).not.toThrow()
    expect(pageStore.content).toContain('Typed content')

    wrapper.unmount()
  })
})
