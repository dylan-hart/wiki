import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import EditorWysiwyg from './EditorWysiwyg.vue'
import { usePageStore } from '@/stores/page'

import { createTestI18n } from '../../test/i18n.js'

/**
 * The lazy on-open fallback for a legacy row still holding raw, serialized Tiptap JSON under
 * `content` -- a page the run-once conversion job (`backend/tasks/simple/convert-wysiwyg-json.ts`)
 * has not reached, or could not parse.
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
    expect(text).toContain('Legacy Title')
    expect(text).toContain('Hello legacy')
    expect(text).not.toContain('"type":"doc"')

    // -> The marks really parsed, proving a `contentType: 'json'` load rather than a markdown
    //    reparse of the JSON string
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

    // -> A content-changing edit, so `onUpdate` definitely fires
    wrapper.vm.editor
      .chain()
      .focus()
      .insertContentAt(wrapper.vm.editor.state.doc.content.size, ' edited')
      .run()
    await nextTick()

    expect(pageStore.contentLoaded).toBe(true)
    // -> Must not still start with `{`: that is how the backend's `isLegacyWysiwygJson()` decides
    //    the save has converted the row and flips its `contentType` to markdown
    expect(pageStore.content).toContain('Legacy content')
    expect(pageStore.content).toContain('edited')
    expect(pageStore.content.startsWith('{')).toBe(false)

    wrapper.unmount()
  })

  it('malformed JSON falls back to the ordinary markdown path instead of throwing', async () => {
    const { wrapper } = mountEditor('{not valid json at all')
    await nextTick()
    await nextTick()

    // -> A throw during init would have torn the component down before this
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
