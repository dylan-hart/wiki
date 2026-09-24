import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'

vi.mock('@/composables/collab', () => ({
  startCollabSession: vi.fn(),
  stopCollabSession: vi.fn(),
  bindCollabEditor: vi.fn(),
  claimWysiwygSeed: vi.fn(async () => true),
  collabUserColor: vi.fn(() => '#1976D2'),
  collabStatusEffects: vi.fn(() => ({
    shouldBindEditor: false,
    readOnly: false,
    notifyDenied: false
  }))
}))

const { startCollabSession, stopCollabSession } = await import('@/composables/collab')
const EditorWysiwyg = (await import('./EditorWysiwyg.vue')).default

function makeFile(name, type = 'image/png') {
  return new File(['x'], name, { type })
}

function findImageNode(editor) {
  let found = null
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') {
      found = node
    }
  })
  return found
}

let wrapper = null

async function mountNoteEditor({
  content = 'Note body',
  uploadFile = null,
  collabReady = false,
  readonly = false
} = {}) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = 'PAGE STORE CONTENT'
  const editorStore = useEditorStore()
  editorStore.hideSideNav = true
  const siteStore = useSiteStore()
  siteStore.openFileManager = vi.fn()
  if (collabReady) {
    siteStore.features.collaborativeEditing = true
    const userStore = useUserStore()
    userStore.authenticated = true
    editorStore.mode = 'edit'
    pageStore.id = 'page-1'
  }

  wrapper = mount(EditorWysiwyg, {
    props: { content, uploadFile, readonly },
    global: { plugins: [createTestI18n()] }
  })
  await nextTick()
  await nextTick()
  return { wrapper, pageStore, editorStore, siteStore }
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.clearAllMocks()
})

describe('EditorWysiwyg note mode', () => {
  it('renders the content prop rather than the page store', async () => {
    await mountNoteEditor({ content: 'Hello **notes**' })
    const text = wrapper.find('.ProseMirror').text()
    expect(text).toContain('Hello notes')
    expect(text).not.toContain('PAGE STORE CONTENT')
    expect(wrapper.find('.ProseMirror strong').exists()).toBe(true)
  })

  it('emits update:content with markdown and leaves the page and editor stores alone', async () => {
    const { pageStore, editorStore } = await mountNoteEditor({ content: 'One' })
    const dirtyBefore = editorStore.lastChangeTimestamp

    wrapper.vm.editor.chain().setTextSelection(4).insertContent(' two').run()
    await nextTick()

    const emitted = wrapper.emitted('update:content')
    expect(emitted).toBeTruthy()
    expect(emitted.at(-1)[0]).toBe('One two')
    expect(pageStore.content).toBe('PAGE STORE CONTENT')
    expect(editorStore.lastChangeTimestamp).toBe(dirtyBefore)
    expect(editorStore.hideSideNav).toBe(true)
  })

  it('never starts or stops a collab session, even when a page editor would', async () => {
    await mountNoteEditor({ collabReady: true })
    expect(startCollabSession).not.toHaveBeenCalled()
    expect(wrapper.vm.editor.isEditable).toBe(true)
    wrapper.unmount()
    wrapper = null
    expect(stopCollabSession).not.toHaveBeenCalled()
  })

  it('refuses typing while readonly, and allows it again once lifted, without emitting', async () => {
    await mountNoteEditor({ content: 'Locked', readonly: true })
    expect(wrapper.vm.editor.isEditable).toBe(false)
    expect(wrapper.find('.ProseMirror').attributes('contenteditable')).toBe('false')

    await wrapper.setProps({ readonly: false })
    expect(wrapper.vm.editor.isEditable).toBe(true)

    await wrapper.setProps({ readonly: true })
    expect(wrapper.vm.editor.isEditable).toBe(false)
    expect(wrapper.emitted('update:content')).toBeFalsy()
  })

  it('replaces the document when the parent swaps in different content, without echoing it', async () => {
    await mountNoteEditor({ content: 'First' })
    await wrapper.setProps({ content: 'Second note' })
    expect(wrapper.find('.ProseMirror').text()).toContain('Second note')
    expect(wrapper.emitted('update:content')).toBeFalsy()
  })

  it('uploads a pasted image and inserts the returned URL, never a blob: URL', async () => {
    let resolveUpload
    const uploadFile = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve
        })
    )
    const { editorStore } = await mountNoteEditor({ content: '', uploadFile })
    wrapper.vm.editor.commands.setTextSelection(1)

    await wrapper.find('.ProseMirror').trigger('paste', {
      clipboardData: { files: [makeFile('image.png')], types: ['Files'], getData: () => '' }
    })

    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(uploadFile.mock.calls[0][0].name).toBe('image.png')
    expect(findImageNode(wrapper.vm.editor)).toBeNull()
    expect(editorStore.pendingAssets).toHaveLength(0)

    resolveUpload({ url: '/_api/sites/s1/notes/n1/images/i1', name: 'image.png' })
    await flushPromises()

    const image = findImageNode(wrapper.vm.editor)
    expect(image?.attrs.src).toBe('/_api/sites/s1/notes/n1/images/i1')
    expect(wrapper.emitted('update:content').at(-1)[0]).toContain(
      '/_api/sites/s1/notes/n1/images/i1'
    )
    expect(wrapper.emitted('update:content').at(-1)[0]).not.toContain('blob:')
  })

  it('uploads a dropped image', async () => {
    const uploadFile = vi.fn(async () => ({ url: '/_api/sites/s1/notes/n1/images/i2' }))
    await mountNoteEditor({ content: '', uploadFile })

    await wrapper.find('.ProseMirror').trigger('drop', {
      dataTransfer: {
        files: [makeFile('photo.jpg', 'image/jpeg')],
        types: ['Files'],
        getData: () => ''
      },
      clientX: 0,
      clientY: 0
    })
    await flushPromises()

    expect(uploadFile).toHaveBeenCalledTimes(1)
    const image = findImageNode(wrapper.vm.editor)
    expect(image?.attrs.src).toBe('/_api/sites/s1/notes/n1/images/i2')
    expect(image?.attrs.alt).toBe('photo.jpg')
  })

  it('inserts nothing when the upload fails', async () => {
    const uploadFile = vi.fn(async () => {
      throw new Error('nope')
    })
    await mountNoteEditor({ content: '', uploadFile })
    wrapper.vm.editor.commands.setTextSelection(1)

    await wrapper.find('.ProseMirror').trigger('paste', {
      clipboardData: { files: [makeFile('image.png')], types: ['Files'], getData: () => '' }
    })
    await flushPromises()

    expect(findImageNode(wrapper.vm.editor)).toBeNull()
  })

  it('does not refuse files while the editor store happens to be in suggest mode', async () => {
    const uploadFile = vi.fn(async () => ({ url: '/_api/sites/s1/notes/n1/images/i3' }))
    const { editorStore } = await mountNoteEditor({ content: '', uploadFile })
    editorStore.mode = 'suggest'
    wrapper.vm.editor.commands.setTextSelection(1)

    await wrapper.find('.ProseMirror').trigger('paste', {
      clipboardData: { files: [makeFile('image.png')], types: ['Files'], getData: () => '' }
    })
    await flushPromises()

    expect(uploadFile).toHaveBeenCalledTimes(1)
  })

  it("the image toolbar button opens a file picker instead of the site's file manager", async () => {
    const uploadFile = vi.fn(async () => ({ url: '/_api/sites/s1/notes/n1/images/i4' }))
    const { siteStore } = await mountNoteEditor({ content: '', uploadFile })
    let picker = null
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      picker = this
    })

    await wrapper.find('[aria-label="editor.wysiwyg.image"]').trigger('click')

    expect(siteStore.openFileManager).not.toHaveBeenCalled()
    expect(picker?.type).toBe('file')
    expect(picker?.accept).toBe('image/*')

    Object.defineProperty(picker, 'files', { value: [makeFile('pick.png')] })
    picker.dispatchEvent(new Event('change'))
    await flushPromises()

    expect(uploadFile).toHaveBeenCalledTimes(1)
    expect(findImageNode(wrapper.vm.editor)?.attrs.src).toBe('/_api/sites/s1/notes/n1/images/i4')
    clickSpy.mockRestore()
  })
})
