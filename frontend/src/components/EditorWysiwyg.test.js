import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { dialog } from '@/composables/dialog'

import EditorWysiwyg from './EditorWysiwyg.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

/*
  `dialog()` only pushes onto a reactive list a `<w-dialog-host>` renders elsewhere in the app, and
  nothing in this component's own tree renders that list -- so a real `LinkPickerDialog` is never
  reachable from here. The mock is what gives a test control of the "OK" payload `insertLink()` acts
  on.
*/
vi.mock(import('@/composables/dialog'), async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn()
}))

function mountEditor(initialContent) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = initialContent
  const siteStore = useSiteStore()

  const i18n = createTestI18n()

  const wrapper = mount(EditorWysiwyg, {
    global: { plugins: [i18n] }
  })

  return { wrapper, pageStore, siteStore }
}

/**
 * Invokes `onOk` synchronously rather than on a real dialog's async resolution -- close enough for
 * a test that is not exercising the dialog itself.
 */
function stubLinkDialog(payload) {
  dialog.mockReturnValue({
    onOk: (cb) => {
      cb(payload)
      return { onOk: () => {}, onCancel: () => {}, onDismiss: () => {} }
    },
    onCancel: () => {},
    onDismiss: () => {}
  })
}

/*
  `createTestI18n()` seeds no messages and has the missing-key warnings off, so a menu title
  resolves to its own `editor.wysiwyg.*` key string.
*/
function clickLinkButton(wrapper) {
  return wrapper.find('[aria-label="editor.wysiwyg.link"]').trigger('click')
}

function findLinkTextNode(editor) {
  let found = null
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === 'link')) {
      found = node
    }
  })
  return found
}

describe('EditorWysiwyg', () => {
  beforeEach(() => {
    dialog.mockReset()
  })
  it('renders the page store content into the document instead of a blank editor', async () => {
    const { wrapper } = mountEditor('Hello from Cardinal.js')
    // -> `EditorContent` mounts the ProseMirror view on its own follow-up `onMounted`, one tick
    //    after the wrapping `<div>` lands in the DOM
    await nextTick()
    await nextTick()

    expect(wrapper.find('.ProseMirror').exists()).toBe(true)
    expect(wrapper.find('.ProseMirror').text()).toContain('Hello from Cardinal.js')

    wrapper.unmount()
  })

  it('round-trips typed content into the page store as markdown and rendered HTML', async () => {
    const { wrapper, pageStore } = mountEditor('')
    await nextTick()

    wrapper.vm.editor.chain().focus().insertContent('Typed content').run()
    await nextTick()

    // -> The shape `pageCreate`/`pageUpdate` expect: `content` is the markdown serialization,
    //    `render` the HTML tiptap derives from it
    expect(pageStore.contentLoaded).toBe(true)
    expect(pageStore.render).toContain('Typed content')
    expect(pageStore.content).toBe('Typed content')

    wrapper.unmount()
  })

  /**
   * The serializer reflows a hand-typed table's column padding and the blank lines around block
   * boundaries, so a hand-authored fixture is not itself a fixed point. "Reloads identically" is
   * therefore proven against a page's own SAVED markdown, not against the authored string.
   */
  it('round-trips headings, lists, links, images, tables and code blocks through markdown', async () => {
    const authored =
      '# Heading\n\n' +
      '- one\n' +
      '- two\n\n' +
      '[a link](https://example.com)\n\n' +
      '![alt text](https://example.com/img.png)\n\n' +
      '| a | b |\n' +
      '| --- | --- |\n' +
      '| 1 | 2 |\n\n' +
      '```js\n' +
      'const x = 1\n' +
      '```'

    const { wrapper, pageStore } = mountEditor(authored)
    await nextTick()
    await nextTick()

    // -> Proves each construct parsed into a real node/mark, not literal text echoed back
    const rendered = wrapper.vm.editor.getHTML()
    expect(rendered).toContain('<h1>Heading</h1>')
    expect(rendered).toContain('<table')
    expect(rendered).toContain('<img')
    expect(rendered).toContain('href="https://example.com"')
    expect(rendered).toContain('<pre><code')

    // -> A no-op edit drives `handleEditorUpdate`'s own `getMarkdown()`, as a real save does
    wrapper.vm.editor.chain().focus().insertContent('').run()
    await nextTick()
    expect(pageStore.contentLoaded).toBe(true)
    const saved = pageStore.content

    // -> A second, independent editor over the saved markdown is what opening the page again does
    const { wrapper: reloaded } = mountEditor(saved)
    await nextTick()
    await nextTick()
    expect(reloaded.vm.editor.getMarkdown()).toBe(saved)

    const reloadedHtml = reloaded.vm.editor.getHTML()
    expect(reloadedHtml).toContain('<h1>Heading</h1>')
    expect(reloadedHtml).toContain('<table')
    expect(reloadedHtml).toContain('<img')
    expect(reloadedHtml).toContain('href="https://example.com"')
    expect(reloadedHtml).toContain('<pre><code')

    wrapper.unmount()
    reloaded.unmount()
  })

  it('links the current selection in place, keeping its own text as the label', async () => {
    const { wrapper } = mountEditor('Hello world')
    await nextTick()
    await nextTick()

    // -> Position 1 is just inside the root paragraph, so "world" is doc positions 7..12
    wrapper.vm.editor.commands.setTextSelection({ from: 7, to: 12 })
    stubLinkDialog({ href: '/target-page', openInNewTab: false, title: 'Target Page' })

    await clickLinkButton(wrapper)
    await nextTick()

    expect(dialog).toHaveBeenCalledTimes(1)
    const linked = findLinkTextNode(wrapper.vm.editor)
    // -> Only a mark was added: `title` did not replace the selected text
    expect(linked?.text).toBe('world')
    const mark = linked.marks.find((m) => m.type.name === 'link')
    expect(mark.attrs.href).toBe('/target-page')
    expect(mark.attrs.target).toBe(null)
    expect(wrapper.vm.editor.getText()).toBe('Hello world')

    wrapper.unmount()
  })

  it('inserts and links the label text when the cursor has no selection', async () => {
    const { wrapper } = mountEditor('Hello world')
    await nextTick()
    await nextTick()

    // -> A collapsed cursor at the end: no selection to label, so `title` has to be inserted first
    wrapper.vm.editor.commands.setTextSelection({ from: 12, to: 12 })
    stubLinkDialog({ href: '/other-page', openInNewTab: true, title: 'Other Page' })

    await clickLinkButton(wrapper)
    await nextTick()

    const linked = findLinkTextNode(wrapper.vm.editor)
    expect(linked?.text).toBe('Other Page')
    const mark = linked.marks.find((m) => m.type.name === 'link')
    expect(mark.attrs.href).toBe('/other-page')
    expect(mark.attrs.target).toBe('_blank')
    expect(wrapper.vm.editor.getText()).toBe('Hello worldOther Page')

    wrapper.unmount()
  })

  it('falls back to the href as the label when the dialog answer has no title', async () => {
    const { wrapper } = mountEditor('')
    await nextTick()
    await nextTick()

    wrapper.vm.editor.commands.setTextSelection({ from: 1, to: 1 })
    stubLinkDialog({ href: 'https://example.com', openInNewTab: false, title: '' })

    await clickLinkButton(wrapper)
    await nextTick()

    const linked = findLinkTextNode(wrapper.vm.editor)
    expect(linked?.text).toBe('https://example.com')

    wrapper.unmount()
  })

  it("configures the `link` node once: no duplicate-extension warning from StarterKit's own default", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { wrapper } = mountEditor('Hello world')
    await nextTick()
    await nextTick()

    for (const call of warnSpy.mock.calls) {
      expect(call.join(' ')).not.toContain('Duplicate extension names')
    }

    warnSpy.mockRestore()
    wrapper.unmount()
  })

  it('wires the Mention extension to a real, site-scoped page-search suggestion', async () => {
    const { wrapper, siteStore } = mountEditor('Hello world')
    await nextTick()
    await nextTick()

    const mention = wrapper.vm.editor.extensionManager.extensions.find(
      (ext) => ext.name === 'mention'
    )
    const { suggestion } = mention.options
    expect(suggestion.char).toBe('@')
    expect(typeof suggestion.items).toBe('function')
    expect(typeof suggestion.render).toBe('function')

    // -> A blank query must resolve empty without issuing a request at all
    API_CLIENT.get.mockClear()
    await expect(
      suggestion.items({ query: '', editor: wrapper.vm.editor, signal: undefined })
    ).resolves.toEqual([])
    expect(API_CLIENT.get).not.toHaveBeenCalled()

    siteStore.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ results: [{ path: 'help/faq', title: 'FAQ', icon: 'tabler:help' }] })
    })
    const items = await suggestion.items({
      query: 'faq',
      editor: wrapper.vm.editor,
      signal: undefined
    })
    expect(API_CLIENT.get).toHaveBeenCalledWith(
      'sites/site-1/pages/search',
      expect.objectContaining({ searchParams: { query: 'faq', limit: 5 } })
    )
    expect(items).toEqual([{ id: 'help/faq', label: 'FAQ', path: 'help/faq', icon: 'tabler:help' }])

    wrapper.unmount()
  })

  describe('inserting assets from the file manager (OpenProject #944)', () => {
    it('inserts a real image node for an image asset', async () => {
      const { wrapper } = mountEditor('')
      await nextTick()

      EVENT_BUS.emit('insertAsset', {
        type: 'asset',
        mimeType: 'image/png',
        title: 'Photo',
        folderPath: 'media',
        fileName: 'photo.png'
      })
      await nextTick()

      const json = wrapper.vm.editor.getJSON()
      const imageNode = json.content.flatMap((n) => n.content ?? n).find((n) => n.type === 'image')
      expect(imageNode?.attrs.src).toBe('/media/photo.png')
      expect(imageNode?.attrs.alt).toBe('Photo')

      wrapper.unmount()
    })

    it('links inserted text for a non-image asset', async () => {
      const { wrapper } = mountEditor('')
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      EVENT_BUS.emit('insertAsset', {
        type: 'asset',
        mimeType: 'application/pdf',
        title: 'Report',
        folderPath: '',
        fileName: 'report.pdf'
      })
      await nextTick()

      const linked = findLinkTextNode(wrapper.vm.editor)
      expect(linked?.text).toBe('Report')
      const mark = linked.marks.find((m) => m.type.name === 'link')
      expect(mark.attrs.href).toBe('/report.pdf')

      wrapper.unmount()
    })

    it('links inserted text for a page', async () => {
      const { wrapper } = mountEditor('')
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      EVENT_BUS.emit('insertAsset', {
        type: 'page',
        title: 'Getting Started',
        folderPath: 'docs',
        fileName: 'getting-started'
      })
      await nextTick()

      const linked = findLinkTextNode(wrapper.vm.editor)
      expect(linked?.text).toBe('Getting Started')
      const mark = linked.marks.find((m) => m.type.name === 'link')
      expect(mark.attrs.href).toBe('/docs/getting-started')

      wrapper.unmount()
    })

    it('stops listening once unmounted', async () => {
      const { wrapper } = mountEditor('')
      await nextTick()

      wrapper.unmount()
      EVENT_BUS.emit('insertAsset', { type: 'asset', mimeType: 'image/png', title: 'x' })

      // -> No assertion: a listener still wired to the destroyed editor would throw on this emit
    })
  })

  describe('text color and highlight (OpenProject #944)', () => {
    function findMenuItem(wrapper, key) {
      return wrapper.vm.menuBar.find((item) => item.key === key)
    }

    function findChild(wrapper, key, childKey) {
      return findMenuItem(wrapper, key).children.find((child) => child.key === childKey)
    }

    it('applies a distinct color per Text Color entry via setColor, not toggleHighlight', async () => {
      const { wrapper } = mountEditor('Hello')
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection({ from: 1, to: 6 })

      findChild(wrapper, 'color', 'color-blue').action()
      await nextTick()
      expect(wrapper.vm.editor.getAttributes('textStyle').color).toBe('#1976D2')
      expect(wrapper.vm.editor.isActive('highlight')).toBe(false)

      findChild(wrapper, 'color', 'color-red').action()
      await nextTick()
      expect(wrapper.vm.editor.getAttributes('textStyle').color).toBe('#D32F2F')

      findChild(wrapper, 'color', 'color-remove').action()
      await nextTick()
      expect(wrapper.vm.editor.getAttributes('textStyle').color).toBeFalsy()

      wrapper.unmount()
    })

    it('applies a distinct background per Highlight entry via toggleHighlight({ color })', async () => {
      const { wrapper } = mountEditor('Hello')
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection({ from: 1, to: 6 })

      findChild(wrapper, 'highlight', 'highlight-yellow').action()
      await nextTick()
      expect(wrapper.vm.editor.getAttributes('highlight').color).toBe('#FFF59D')

      findChild(wrapper, 'highlight', 'highlight-blue').action()
      await nextTick()
      expect(wrapper.vm.editor.getAttributes('highlight').color).toBe('#90CAF9')

      findChild(wrapper, 'highlight', 'highlight-remove').action()
      await nextTick()
      expect(wrapper.vm.editor.isActive('highlight')).toBe(false)

      wrapper.unmount()
    })

    it("lights up each entry's own isActive only when its own color is applied", async () => {
      const { wrapper } = mountEditor('Hello')
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection({ from: 1, to: 6 })

      findChild(wrapper, 'color', 'color-green').action()
      await nextTick()

      expect(findChild(wrapper, 'color', 'color-green').isActive()).toBe(true)
      expect(findChild(wrapper, 'color', 'color-red').isActive()).toBe(false)
      expect(findMenuItem(wrapper, 'color').isActive()).toBe(true)

      wrapper.unmount()
    })
  })

  describe('text alignment (OpenProject #944)', () => {
    it('actually sets alignment on the current paragraph', async () => {
      const { wrapper } = mountEditor('Hello world')
      await nextTick()
      wrapper.vm.editor.commands.setTextSelection(1)

      const alignItem = wrapper.vm.menuBar.find((item) => item.key === 'align')
      const centerChild = alignItem.children.find((child) => child.key === 'align-center')

      expect(centerChild.isActive()).toBe(false)
      centerChild.action()
      await nextTick()

      expect(centerChild.isActive()).toBe(true)
      expect(wrapper.vm.editor.getAttributes('paragraph').textAlign).toBe('center')

      wrapper.unmount()
    })
  })
})
