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
  `EditorWysiwyg.vue` opens `LinkPickerDialog` through the real `dialog()` composable, which just
  pushes onto a reactive list for a `<w-dialog-host>` to render elsewhere in the app -- nothing in
  this component's own tree renders that list, so a mounted `LinkPickerDialog` is never reachable
  from here. Mocking `dialog()` itself gives a test direct control of the "OK" payload a real dialog
  would have resolved with, which is all `insertLink()`'s own logic (task 487's subject) cares about.
*/
vi.mock(import('@/composables/dialog'), async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn()
}))

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
  const siteStore = useSiteStore()

  const i18n = createTestI18n()

  const wrapper = mount(EditorWysiwyg, {
    global: { plugins: [i18n] }
  })

  return { wrapper, pageStore, siteStore }
}

/**
 * Points the mocked `dialog()` at a fixed answer, the way a reader confirming `LinkPickerDialog`
 * would: `insertLink()`'s own `dialog({ component: LinkPickerDialog }).onOk(cb)` call gets `cb`
 * invoked with `payload` immediately, synchronously -- close enough to the real dialog's async
 * resolution for a test that is not exercising the dialog itself.
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
  `wysiwygMenuBar.js` translates every title through `t()` against `editor.wysiwyg.*` (OpenProject
  #3206) -- `createTestI18n()` seeds no messages, so with `missingWarn`/`fallbackWarn` off `t()`
  resolves an untranslated key to the key string itself, same as `editorMarkupShared.test.js`'s own
  `[aria-label="editor.markup.insertAssets"]` selector for `EditorMarkdown.vue`'s sibling namespace.
*/
function clickLinkButton(wrapper) {
  return wrapper.find('[aria-label="editor.wysiwyg.link"]').trigger('click')
}

/** The lone text node carrying a `link` mark, or `null` if nothing in the doc has one. */
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
    // -> Plain text is valid markdown too: `init()` loads `pageStore.content` with
    //    `contentType: 'markdown'`, so a line with no markdown syntax in it becomes a single
    //    paragraph holding that text verbatim.
    const { wrapper } = mountEditor('Hello from Cardinal.js')
    // -> `EditorContent` (from `@tiptap/vue-3`) mounts the ProseMirror view itself on its own
    //    `onMounted`, one tick after the wrapping `<div>` above it lands in the DOM -- a single
    //    `nextTick()` flushes the parent render but not that child's follow-up mount.
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

    // -> Matches the `pageCreate`/`pageUpdate` flow in `backend/models/pages.ts`: `content` is the
    //    editor's markdown serialization (`editor.getMarkdown()`, from `@tiptap/markdown`), `render`
    //    is the HTML tiptap derives from it -- `EDITOR_CONTENT_TYPES.wysiwyg` is `'markdown'` too.
    expect(pageStore.contentLoaded).toBe(true)
    expect(pageStore.render).toContain('Typed content')
    expect(pageStore.content).toBe('Typed content')

    wrapper.unmount()
  })

  /**
   * Task 3395: a WYSIWYG page saves markdown and reloads into the editor identically -- covers every
   * construct the acceptance criteria names (headings, lists, links, images, tables, code blocks).
   *
   * The serializer reflows a hand-typed table (column padding) and adjusts blank-line spacing around
   * block boundaries, so a hand-authored fixture is not itself a fixed point -- what "reloads
   * identically" actually means is that a page's own *saved* markdown (what `handleEditorUpdate`
   * writes, i.e. what `getMarkdown()` already produced once) comes back out unchanged on the next
   * load, which is what the two-editor comparison below proves rather than assuming.
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

    // -> Confirms every construct actually parsed into a real node/mark, not just surviving as
    //    literal text the renderer happens to echo back.
    const rendered = wrapper.vm.editor.getHTML()
    expect(rendered).toContain('<h1>Heading</h1>')
    expect(rendered).toContain('<table')
    expect(rendered).toContain('<img')
    expect(rendered).toContain('href="https://example.com"')
    expect(rendered).toContain('<pre><code')

    // -> What a real save actually writes -- `handleEditorUpdate`'s own `editor.getMarkdown()` call,
    //    triggered the same way it is in production, through a real (no-op) edit.
    wrapper.vm.editor.chain().focus().insertContent('').run()
    await nextTick()
    expect(pageStore.contentLoaded).toBe(true)
    const saved = pageStore.content

    // -> Loading that saved markdown into a second, independent editor -- exactly what opening the
    //    page again does -- must reproduce it byte-for-byte: the actual "reloads identically"
    //    acceptance criterion, proven on the same persisted value a real reload reads.
    const { wrapper: reloaded } = mountEditor(saved)
    await nextTick()
    await nextTick()
    expect(reloaded.vm.editor.getMarkdown()).toBe(saved)

    // -> Every construct is still real nodes/marks in the reloaded document too, not merely text
    //    that happened to look right in the first editor.
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

    // -> "Hello world" as the sole text child of the root paragraph: position 1 is right after the
    //    paragraph's opening, so "world" (chars 6..10 of the string) is doc positions 7..12.
    wrapper.vm.editor.commands.setTextSelection({ from: 7, to: 12 })
    stubLinkDialog({ href: '/target-page', openInNewTab: false, title: 'Target Page' })

    await clickLinkButton(wrapper)
    await nextTick()

    expect(dialog).toHaveBeenCalledTimes(1)
    const linked = findLinkTextNode(wrapper.vm.editor)
    // -> The selected word stays exactly as it was; only a mark was added, nothing was replaced with
    //    `title`.
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

    // -> Collapsed cursor at the very end of "Hello world" (doc position 12): nothing is selected,
    //    so there is no label to reuse -- `title` (falling back to `href`) has to be inserted first.
    wrapper.vm.editor.commands.setTextSelection({ from: 12, to: 12 })
    stubLinkDialog({ href: '/other-page', openInNewTab: true, title: 'Other Page' })

    await clickLinkButton(wrapper)
    await nextTick()

    const linked = findLinkTextNode(wrapper.vm.editor)
    expect(linked?.text).toBe('Other Page')
    const mark = linked.marks.find((m) => m.type.name === 'link')
    expect(mark.attrs.href).toBe('/other-page')
    expect(mark.attrs.target).toBe('_blank')
    // -> The original text is untouched; the new label was appended after it, not over it.
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

    // -> A blank query resolves with no items and, per `createPageMentionSuggestion`'s own doc
    //    comment, no request at all -- confirmed here rather than left to the network mock's default.
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

  /**
   * OpenProject #944, item 1: the Image toolbar button only ever opened the File Manager -- nothing
   * listened for the `insertAsset` event it emits back, so a picked image was silently dropped.
   */
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

      // -> No assertion beyond "does not throw": the destroyed editor's commands would throw against
      //    a torn-down view if the listener were still wired.
    })
  })

  /**
   * OpenProject #944, item 2: every "Text Color" entry called `toggleHighlight()` with no color, and
   * every "Highlight" entry called it with no `{ color }` despite `Highlight.configure({ multicolor:
   * true })` -- so all 16 entries produced the identical default highlight, and neither dropdown's
   * `isActive` matched a real mark name.
   */
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

  /**
   * OpenProject #944, item 3: `TextAlign` was registered unconfigured, so its default `types: []`
   * made `setTextAlign()` map over an empty node-type list and every alignment button a no-op.
   */
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
