import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHistory } from 'vue-router'

import FileManager from './FileManager.vue'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * OpenProject #790: `FileManager.vue` had no drag-and-drop upload on-ramp, only the file-picker's
 * `multiple` input (`uploadNewFiles`, unchanged). These tests cover the drop zone added to close
 * that gap: the drag-state bookkeeping that drives the overlay, and that a drop feeds the SAME
 * `uploadFiles` path (same `sites/:siteId/assets` calls, same progress state) the picker already
 * used -- not a second upload implementation. `handleDrop`/`handleDragEnter`/etc. are plain
 * `<script setup>` bindings, reachable on `wrapper.vm` because Vue's dev-mode compiler exposes them
 * for template refs/devtools; see `PageNewMenu.test.js` and others in this directory for the same
 * pattern already in use.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      fileman: {
        dropToUpload: 'Drop files to upload',
        dropFoldersRejected: "Folders can't be uploaded by drag-and-drop.",
        dropFoldersRejectedCount: '{count} folders were skipped',
        uploadSuccess: 'File(s) uploaded successfully.'
      }
    }
  }
})

async function mountFileManager() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const router = createRouter({ history: createWebHistory(), routes: [] })

  const wrapper = mount(FileManager, {
    global: {
      plugins: [i18n, router],
      // -> None of these are what this feature touches; stubbed to keep the mount to what the
      //    drop zone actually needs (they each pull in their own child tree otherwise).
      stubs: {
        Tree: true,
        NewMenu: true,
        LocaleSelectorMenu: true
      }
    },
    attachTo: document.body
  })
  await flushPromises()
  return { wrapper, siteStore }
}

function makeFile(name, type = 'text/plain') {
  return new File(['x'], name, { type })
}

/** A `DataTransferItem`-shaped stand-in, wired to `webkitGetAsEntry` the way `collectDroppedFiles`
 *  reads it -- happy-dom's real `DataTransfer` has no such method. */
function fileItem(file) {
  return {
    kind: 'file',
    webkitGetAsEntry: () => ({ isDirectory: false }),
    getAsFile: () => file
  }
}

function folderItem(name) {
  return {
    kind: 'file',
    webkitGetAsEntry: () => ({ isDirectory: true, name }),
    getAsFile: () => null
  }
}

describe('FileManager drag-and-drop upload (OpenProject #790)', () => {
  beforeEach(() => {
    notifyQueue.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows the drop overlay on dragenter with files, and hides it on dragleave', async () => {
    const { wrapper } = await mountFileManager()
    const dropZone = wrapper.find('.fileman-droptarget')

    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(false)

    await dropZone.trigger('dragenter', { dataTransfer: { types: ['Files'] } })
    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(true)
    expect(wrapper.text()).toContain('Drop files to upload')

    await dropZone.trigger('dragleave')
    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(false)

    wrapper.unmount()
  })

  it('ignores a drag that carries no files (e.g. text dragged within the page)', async () => {
    const { wrapper } = await mountFileManager()
    const dropZone = wrapper.find('.fileman-droptarget')

    await dropZone.trigger('dragenter', { dataTransfer: { types: ['text/plain'] } })
    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(false)

    wrapper.unmount()
  })

  it('keeps the overlay up while the drag passes over a nested child, only closing on the final dragleave', async () => {
    const { wrapper } = await mountFileManager()
    const dropZone = wrapper.find('.fileman-droptarget')

    // -> Entering the pane, then a child within it (e.g. crossing into the scroll area) without
    //    ever truly leaving -- browsers fire dragenter/dragleave for every element boundary crossed,
    //    which is what the depth counter in the component exists to net out.
    await dropZone.trigger('dragenter', { dataTransfer: { types: ['Files'] } })
    await dropZone.trigger('dragenter', { dataTransfer: { types: ['Files'] } })
    await dropZone.trigger('dragleave')
    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(true)

    await dropZone.trigger('dragleave')
    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(false)

    wrapper.unmount()
  })

  it('uploads dropped files through the same sites/:siteId/assets path the picker uses', async () => {
    const { wrapper, siteStore } = await mountFileManager()
    const dropZone = wrapper.find('.fileman-droptarget')
    const fileA = makeFile('photo.png', 'image/png')
    const fileB = makeFile('notes.txt', 'text/plain')

    await dropZone.trigger('dragenter', { dataTransfer: { types: ['Files'] } })
    await dropZone.trigger('drop', {
      dataTransfer: {
        items: [fileItem(fileA), fileItem(fileB)],
        files: [fileA, fileB]
      }
    })

    // -> The overlay closes immediately on drop, before the upload itself runs
    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(false)

    // -> `uploadFiles` defers its loop behind `nextTick` + a 400ms `setTimeout` (see the component);
    //    real timers here rather than faking them, since faking interacts with the `matchMedia`
    //    listeners `useScreen`/`useMinWidth` register on mount
    await new Promise((resolve) => setTimeout(resolve, 500))
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(2)
    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${siteStore.id}/assets`,
      expect.objectContaining({
        searchParams: expect.objectContaining({ fileName: 'photo.png' }),
        headers: { 'content-type': 'image/png' }
      })
    )
    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${siteStore.id}/assets`,
      expect.objectContaining({
        searchParams: expect.objectContaining({ fileName: 'notes.txt' }),
        headers: { 'content-type': 'text/plain' }
      })
    )

    wrapper.unmount()
  })

  it('rejects a dropped folder with a visible message, uploading none of its contents', async () => {
    const { wrapper } = await mountFileManager()
    const dropZone = wrapper.find('.fileman-droptarget')

    await dropZone.trigger('drop', {
      dataTransfer: {
        items: [folderItem('my-folder')],
        files: []
      }
    })
    await flushPromises()

    expect(API_CLIENT.post).not.toHaveBeenCalled()
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0].type).toBe('negative')
    expect(notifyQueue[0].message).toBe("Folders can't be uploaded by drag-and-drop.")

    wrapper.unmount()
  })

  it('uploads the files from a mixed drop and rejects only the folder among them', async () => {
    const { wrapper, siteStore } = await mountFileManager()
    const dropZone = wrapper.find('.fileman-droptarget')
    const file = makeFile('report.pdf', 'application/pdf')

    await dropZone.trigger('drop', {
      dataTransfer: {
        items: [fileItem(file), folderItem('attachments')],
        files: [file]
      }
    })

    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 500))
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${siteStore.id}/assets`,
      expect.objectContaining({ searchParams: expect.objectContaining({ fileName: 'report.pdf' }) })
    )

    wrapper.unmount()
  })

  it("falls back to dataTransfer.files (no folder detection) when the entry API isn't available", async () => {
    const { wrapper, siteStore } = await mountFileManager()
    const dropZone = wrapper.find('.fileman-droptarget')
    const file = makeFile('legacy.txt')

    // -> No `items`, matching a browser without `DataTransferItemList` -- the fallback branch in
    //    `collectDroppedFiles`
    await dropZone.trigger('drop', { dataTransfer: { files: [file] } })

    await new Promise((resolve) => setTimeout(resolve, 500))
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${siteStore.id}/assets`,
      expect.objectContaining({ searchParams: expect.objectContaining({ fileName: 'legacy.txt' }) })
    )

    wrapper.unmount()
  })
})

/**
 * OpenProject #859, #861, #862, #863, #864: `FileManager.vue`'s per-row context menu implemented
 * the asset "View" action, gated "Rerender Page" and "Duplicate..." to where they actually apply,
 * and removed three menu items ("Edit Image...", "Resize Image...", "Move to...") that called
 * nothing. These tests cover that shape directly rather than through the drop zone above.
 *
 * `WMenu` is stubbed to render its slot unconditionally -- in the real app a row's menu content
 * only mounts once its `w-item` trigger receives a real `contextmenu` event (see `WMenu.vue`), and
 * these tests care about which `<w-item>`s a row's menu holds, not that open/close mechanics WMenu
 * already owns -- the same pattern `PageNewMenu.test.js` uses.
 */
describe('FileManager context menu (OpenProject #859, #861, #862, #863, #864)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  async function mountFileManagerWithItems(fileList) {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    const router = createRouter({ history: createWebHistory(), routes: [] })

    const wrapper = mount(FileManager, {
      global: {
        plugins: [i18n, router],
        stubs: {
          Tree: true,
          NewMenu: true,
          LocaleSelectorMenu: true,
          WMenu: { template: '<div><slot /></div>' }
        }
      },
      attachTo: document.body
    })
    await flushPromises()
    wrapper.vm.state.fileList = fileList
    await flushPromises()
    return { wrapper, siteStore }
  }

  it("openItem()'s asset case opens the asset's URL in a new tab", async () => {
    const { wrapper } = await mountFileManagerWithItems([])
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {})

    wrapper.vm.openItem({ type: 'asset', folderPath: 'media', fileName: 'photo.png' })

    expect(openSpy).toHaveBeenCalledWith('/_files/media/photo.png', '_blank')

    wrapper.unmount()
  })

  it('does not render "Duplicate..." for a folder or an asset, only for a page', async () => {
    const { wrapper } = await mountFileManagerWithItems([
      { id: 'f1', type: 'folder', title: 'My Folder', fileName: 'my-folder', children: 0 },
      {
        id: 'a1',
        type: 'asset',
        title: 'photo',
        fileName: 'photo.png',
        fileExt: 'png',
        fileSize: 1024,
        mimeType: 'image/png',
        folderPath: ''
      }
    ])

    expect(wrapper.text()).not.toContain('Duplicate...')

    wrapper.vm.state.fileList = [
      {
        id: 'p1',
        type: 'page',
        title: 'My Page',
        fileName: 'my-page',
        pageType: 'markdown',
        folderPath: ''
      }
    ]
    await flushPromises()

    expect(wrapper.text()).toContain('Duplicate...')

    wrapper.unmount()
  })

  it('no longer renders "Edit Image...", "Resize Image..." or "Move to..." for any item type', async () => {
    const { wrapper } = await mountFileManagerWithItems([
      { id: 'f1', type: 'folder', title: 'My Folder', fileName: 'my-folder', children: 0 },
      {
        id: 'a1',
        type: 'asset',
        title: 'photo',
        fileName: 'photo.png',
        fileExt: 'png',
        fileSize: 1024,
        mimeType: 'image/png',
        folderPath: ''
      },
      {
        id: 'p1',
        type: 'page',
        title: 'My Page',
        fileName: 'my-page',
        pageType: 'markdown',
        folderPath: ''
      }
    ])

    const text = wrapper.text()
    expect(text).not.toContain('Edit Image')
    expect(text).not.toContain('Resize Image')
    expect(text).not.toContain('Move to')

    wrapper.unmount()
  })
})
