import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import EditorWysiwyg from './EditorWysiwyg.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useEditorStore } from '@/stores/editor'

import { createTestI18n } from '../../test/i18n.js'

/**
 * End-to-end coverage for OpenProject #3397's constructs (GitHub alerts, footnotes, TeX, glossary
 * term highlighting, icon shortcodes, task lists) THROUGH the real component's `buildExtensions()`
 * -- `src/editor/wysiwyg/*.test.js` already covers each extension's own parse/render/round-trip in
 * isolation; this file only proves they are actually wired in, not re-testing their internals.
 *
 * A separate file rather than an addition to `EditorWysiwyg.test.js`, deliberately: that file is
 * also being changed this round by sibling work packages (#3396, #3398, #3400) touching the same
 * `buildExtensions()` region, per the epic's coordination note -- a new file has nothing there to
 * conflict with.
 */
function mountEditor(initialContent, { glossaryTerms } = {}) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = initialContent
  useSiteStore()
  if (glossaryTerms) {
    useEditorStore().editors.markdown = { glossaryTerms }
  }

  const i18n = createTestI18n()
  const wrapper = mount(EditorWysiwyg, { global: { plugins: [i18n] } })
  return { wrapper, pageStore }
}

describe('EditorWysiwyg constructs (OpenProject #3397)', () => {
  it('round-trips a GitHub-style alert, a footnote, TeX and an icon shortcode together', async () => {
    const authored =
      '> [!WARNING] Careful\n' +
      '>\n' +
      '> This has a footnote[^1].\n\n' +
      '[^1]: The source.\n\n' +
      'Inline math $x^2$ and an icon :mdi:information: here.\n\n' +
      '- [ ] todo one\n' +
      '- [x] todo two'

    const { wrapper, pageStore } = mountEditor(authored)
    await nextTick()
    await nextTick()

    const { editor } = wrapper.vm
    const typeNames = new Set()
    editor.state.doc.descendants((node) => {
      typeNames.add(node.type.name)
    })
    expect(typeNames).toContain('blockquote')
    expect(typeNames).toContain('footnoteReference')
    expect(typeNames).toContain('footnoteDefinition')
    expect(typeNames).toContain('texMath')
    expect(typeNames).toContain('iconShortcode')
    expect(typeNames).toContain('taskItem')

    // -> A real (no-op) edit, the same way `EditorWysiwyg.test.js`'s own round-trip test triggers
    //    `handleEditorUpdate` -> `editor.getMarkdown()` -> `pageStore.content`.
    editor.chain().focus().insertContent('').run()
    await nextTick()
    const saved = pageStore.content

    const { wrapper: reloaded } = mountEditor(saved)
    await nextTick()
    await nextTick()
    expect(reloaded.vm.editor.getMarkdown()).toBe(saved)

    wrapper.unmount()
    reloaded.unmount()
  })

  it('falls through to a plain blockquote when there is no alert marker', async () => {
    const { wrapper } = mountEditor('> An ordinary quote.')
    await nextTick()
    await nextTick()

    let blockquote = null
    wrapper.vm.editor.state.doc.descendants((node) => {
      if (node.type.name === 'blockquote') {
        blockquote = node
      }
    })
    expect(blockquote).not.toBeNull()
    expect(blockquote.attrs.kind).toBeNull()

    wrapper.unmount()
  })

  it('highlights a configured glossary term without changing the saved markdown', async () => {
    const authored = 'Call the API today.'
    const { wrapper, pageStore } = mountEditor(authored, {
      glossaryTerms: [{ term: 'API', definition: 'Application Programming Interface', link: null }]
    })
    await nextTick()
    await nextTick()

    expect(wrapper.find('.wysiwyg-glossary-term').exists()).toBe(true)

    wrapper.vm.editor.chain().focus().insertContent('').run()
    await nextTick()
    expect(pageStore.content).toBe(authored)

    wrapper.unmount()
  })

  /**
   * Matches `EditorWysiwyg.test.js`'s own "text color and highlight" convention for a dropdown's
   * children: call the menu entry's `.action()` directly (exposed via `menuBar`) rather than driving
   * a `w-menu` open through the DOM, which its own tests don't do either.
   */
  function findMenuItem(wrapper, key) {
    return wrapper.vm.menuBar.find((item) => item.key === key)
  }

  function findChild(wrapper, key, childKey) {
    return findMenuItem(wrapper, key).children.find((child) => child.key === childKey)
  }

  it('inserts a GitHub alert from the toolbar as a real, editable node', async () => {
    const { wrapper } = mountEditor('')
    await nextTick()
    await nextTick()

    findChild(wrapper, 'cardinalconstructs', 'insert-alert').action()
    await nextTick()

    let hasAlert = false
    wrapper.vm.editor.state.doc.descendants((node) => {
      if (node.type.name === 'blockquote' && node.attrs.kind === 'note') {
        hasAlert = true
      }
    })
    expect(hasAlert).toBe(true)

    wrapper.unmount()
  })

  it('inserts a TeX formula and an icon shortcode from the toolbar', async () => {
    const { wrapper } = mountEditor('')
    await nextTick()
    await nextTick()

    findChild(wrapper, 'cardinalconstructs', 'insert-tex').action()
    findChild(wrapper, 'cardinalconstructs', 'insert-icon').action()
    await nextTick()

    const typeNames = new Set()
    wrapper.vm.editor.state.doc.descendants((node) => {
      typeNames.add(node.type.name)
    })
    expect(typeNames).toContain('texMath')
    expect(typeNames).toContain('iconShortcode')

    wrapper.unmount()
  })
})
