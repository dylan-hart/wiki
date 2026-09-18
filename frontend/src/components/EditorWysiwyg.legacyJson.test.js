import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import EditorWysiwyg from './EditorWysiwyg.vue'
import { usePageStore } from '@/stores/page'

import { createTestI18n } from '../../test/i18n.js'

/**
 * OpenProject #3400: the lazy on-open fallback for a page the run-once conversion job
 * (`backend/tasks/simple/convert-wysiwyg-json.ts`) hasn't gotten to yet, or couldn't parse -- a
 * legacy row still holding the pre-#3395 WYSIWYG editor's raw, serialized Tiptap JSON under
 * `content`. Before this fallback, `init()` always loaded `pageStore.content` with
 * `contentType: 'markdown'`, so a legacy row's `{"type":"doc",...}` text was fed to the markdown
 * parser as literal text and shown verbatim rather than as the document it actually describes.
 */
function mountEditor(initialContent) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = initialContent
  const i18n = createTestI18n()

  const wrapper = mount(EditorWysiwyg, {
    global: { plugins: [i18n] }
  })

  return { wrapper, pageStore }
}

describe('EditorWysiwyg legacy WYSIWYG JSON fallback (OpenProject #3400)', () => {
  it('loads a legacy Tiptap-JSON row as the document it describes, not as literal markdown text', async () => {
    const legacyJson = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Legacy Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'legacy' }
          ]
        }
      ]
    })

    const { wrapper } = mountEditor(legacyJson)
    await nextTick()
    await nextTick()

    const text = wrapper.find('.ProseMirror').text()
    // -> The real document's text, not the raw `{"type":"doc",...}` source that a naive markdown
    //    parse of this same string would have shown instead.
    expect(text).toContain('Legacy Title')
    expect(text).toContain('Hello legacy')
    expect(text).not.toContain('"type":"doc"')

    // -> The heading/bold marks actually parsed, not just their text -- proof this went through
    //    `contentType: 'json'`, not a markdown reparse of the JSON string.
    expect(wrapper.vm.editor.getHTML()).toContain('<h2')
    expect(wrapper.vm.editor.getHTML()).toContain('<strong>legacy</strong>')

    wrapper.unmount()
  })

  it('saving from a loaded legacy row writes real markdown, ready for updatePage() to flip contentType', async () => {
    const legacyJson = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Legacy content' }] }]
    })

    const { wrapper, pageStore } = mountEditor(legacyJson)
    await nextTick()
    await nextTick()

    // -> A real (not no-op) edit is what actually fires `onUpdate` -- an unchanged `insertContent('')`
    //    produces no transaction at all, same as it would for any other loaded content.
    wrapper.vm.editor
      .chain()
      .focus()
      .insertContentAt(wrapper.vm.editor.state.doc.content.size, ' edited')
      .run()
    await nextTick()

    expect(pageStore.contentLoaded).toBe(true)
    // -> Real markdown text, never starting with `{` -- `helpers/wysiwygHeadlessMarkdown.ts`'s
    //    `isLegacyWysiwygJson()` (mirrored here client-side) would read this as already converted,
    //    which is exactly what lets `updatePage()`'s `isLegacyWysiwygConversionSave` branch flip
    //    `contentType` to `markdown` on this same save (`backend/models/pages.ts`).
    expect(pageStore.content).toContain('Legacy content')
    expect(pageStore.content).toContain('edited')
    expect(pageStore.content.startsWith('{')).toBe(false)

    wrapper.unmount()
  })

  it('malformed JSON falls back to the ordinary markdown path instead of throwing', async () => {
    const { wrapper } = mountEditor('{not valid json at all')
    await nextTick()
    await nextTick()

    // -> Still mounts (no thrown error tore the component down) -- the literal text is shown as
    //    markdown, the same as before this fallback existed for any row this can't parse either.
    expect(wrapper.find('.ProseMirror').exists()).toBe(true)
    expect(wrapper.find('.ProseMirror').text()).toContain('not valid json at all')

    wrapper.unmount()
  })

  it('ordinary markdown content (not starting with {) is unaffected by the fallback', async () => {
    const { wrapper } = mountEditor('# A real markdown page\n\nWith a paragraph.')
    await nextTick()
    await nextTick()

    expect(wrapper.find('.ProseMirror').text()).toContain('A real markdown page')
    expect(wrapper.vm.editor.getHTML()).toContain('<h1')

    wrapper.unmount()
  })
})
