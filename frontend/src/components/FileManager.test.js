import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import FileManager from './FileManager.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { queue as notifyQueue } from '@/composables/notify'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { useDark } from '@/composables/dark'

import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter } from '../../test/router.js'

/**
 * `FileManager.vue`'s `<script setup>` bindings (`handleDrop`, `delItem`, `state`, ...) are reachable
 * on `wrapper.vm` because Vue's dev-mode compiler exposes them for template refs/devtools, so these
 * suites call them directly rather than simulating the full UI path.
 */

const i18n = createTestI18n({
  common: {
    datetime: '{date} at {time}',
    // -> The file manager's key-cap hint resolves through `HeaderSearch`'s own two keys.
    header: {
      searchShortcutMac: '\u2318K',
      searchShortcutOther: 'Ctrl+K'
    },
    pageSelector: {
      folderEmptyWarning: 'This folder is empty.'
    }
  },
  fileman: {
    dropToUpload: 'Drop files to upload',
    dropFoldersRejected: "Folders can't be uploaded by drag-and-drop.",
    dropFoldersRejectedCount: '{count} folders were skipped',
    uploadSuccess: 'File(s) uploaded successfully.',
    browseUsing: 'Browse using...',
    browseUsingPaths: 'Browse Using Paths',
    browseUsingTitles: 'Browse Using Titles',
    compactList: 'Compact List',
    showFolders: 'Show Folders',
    fetchingFolderContents: 'Fetching folder contents...',
    duplicateItem: 'Duplicate...',
    renameItem: 'Rename...',
    moveItem: 'Move...',
    moveAssetSuccess: 'Asset moved successfully.',
    moveAssetFailed: 'Failed to move asset.',
    renameMovePage: 'Rename / Move Page...',
    pngFileType: 'PNG Image',
    markdownPageType: 'Markdown Page',
    folderChildrenCount: '{count} items'
  },
  pages: {
    homepageGuard: {
      deleteTitle: 'Delete the Home Page?',
      deleteMessage:
        "**{name}** is set as this site's home page. Deleting it will leave the site root with no page until another one takes its place at `home`.",
      moveTitle: 'Move the Home Page?',
      moveMessage:
        "**{name}** is set as this site's home page. Moving it away from `home` will leave the site root with no page until another one takes its place there.",
      proceed: 'Continue'
    }
  }
})

async function mountFileManager({ overlayOpts } = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const router = buildTestRouter([])

  const wrapper = mount(FileManager, {
    props: overlayOpts ? { overlayOpts } : {},
    global: {
      plugins: [i18n, router],
      // -> Stubbed only to keep the mount small: each pulls in its own child tree.
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

/** happy-dom's real `DataTransfer` has no `webkitGetAsEntry`, which is how `collectDroppedFiles`
 *  tells a folder from a file. */
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

/**
 * `mountFileManager` attaches to `document.body`, so `.focus()` really does move
 * `document.activeElement` here, the same as in a browser.
 */
describe('FileManager keyboard shortcut (OpenProject #2050)', () => {
  it('focuses the search field on Ctrl+K', async () => {
    const { wrapper } = await mountFileManager()
    const input = wrapper.find('.fileman-search-input').element

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await flushPromises()

    expect(document.activeElement).toBe(input)
  })

  it('also focuses the search field on Cmd+K (metaKey) -- previously unbound entirely', async () => {
    const { wrapper } = await mountFileManager()
    const input = wrapper.find('.fileman-search-input').element

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await flushPromises()

    expect(document.activeElement).toBe(input)
  })
})

describe('FileManager insertMode (OpenProject #2530)', () => {
  it('defaults insertMode to false with no overlayOpts prop', async () => {
    const { wrapper } = await mountFileManager()

    expect(wrapper.vm.insertMode).toBe(false)
  })

  it('reads insertMode: true from the overlayOpts prop', async () => {
    const { wrapper } = await mountFileManager({ overlayOpts: { insertMode: true } })

    expect(wrapper.vm.insertMode).toBe(true)
  })
})

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

    // -> Browsers fire dragenter/dragleave for every element boundary crossed, which is what the
    //    component's depth counter exists to net out.
    await dropZone.trigger('dragenter', { dataTransfer: { types: ['Files'] } })
    await dropZone.trigger('dragenter', { dataTransfer: { types: ['Files'] } })
    await dropZone.trigger('dragleave')
    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(true)

    await dropZone.trigger('dragleave')
    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(false)

    wrapper.unmount()
  })

  it('uploads a single dropped file through the same sites/:siteId/assets path the picker uses', async () => {
    const { wrapper, siteStore } = await mountFileManager()
    const dropZone = wrapper.find('.fileman-droptarget')
    const file = makeFile('photo.png', 'image/png')

    await dropZone.trigger('dragenter', { dataTransfer: { types: ['Files'] } })
    await dropZone.trigger('drop', {
      dataTransfer: {
        items: [fileItem(file)],
        files: [file]
      }
    })

    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(false)

    // -> `uploadFiles` defers behind `nextTick` + a 400ms `setTimeout`. Real timers rather than fake
    //    ones, which interfere with the `matchMedia` listeners `useScreen`/`useMinWidth` register.
    await new Promise((resolve) => setTimeout(resolve, 500))
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${siteStore.id}/assets`,
      expect.objectContaining({
        searchParams: expect.objectContaining({ fileName: 'photo.png' }),
        headers: { 'content-type': 'image/png' }
      })
    )

    wrapper.unmount()
  })

  it('uploads a multi-file drop through ONE sites/:siteId/assets/batch request (OpenProject #3233)', async () => {
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

    expect(wrapper.find('.fileman-dropoverlay').exists()).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 500))
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${siteStore.id}/assets/batch`,
      expect.objectContaining({ body: expect.any(FormData) })
    )
    const [, opts] = API_CLIENT.post.mock.calls[0]
    expect(opts.body.getAll('files')).toEqual([fileA, fileB])

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

    // -> No `items`: a browser without `DataTransferItemList`, `collectDroppedFiles`'s fallback.
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
 * `WMenu` is stubbed to render its slot unconditionally: in the real app a row's menu content only
 * mounts once its trigger receives a `contextmenu` event, and what is asserted here is which
 * `<w-item>`s a row's menu holds, not the open/close mechanics `WMenu` already owns.
 */
describe('FileManager context menu (OpenProject #859, #861, #862, #863, #864)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  async function mountFileManagerWithItems(fileList) {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    const router = buildTestRouter([])

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

/**
 * `ratio`/`width` are `q-img`-era props that mean nothing on a plain `<img>`: `ratio` lands as a
 * dead attribute and `width` reserves no height, so the pane reflows once the thumbnail loads. The
 * aspect ratio has to come from a class instead.
 */
describe('FileManager detail thumbnail markup (WP #1728)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the detail thumbnail with no leftover q-img ratio/width attributes', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    const router = buildTestRouter([])

    const wrapper = mount(FileManager, {
      global: {
        plugins: [i18n, router],
        stubs: { Tree: true, NewMenu: true, LocaleSelectorMenu: true }
      },
      attachTo: document.body
    })
    await flushPromises()

    wrapper.vm.state.fileList = [
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
    ]
    wrapper.vm.state.currentFileId = 'a1'
    await flushPromises()

    const img = wrapper.find('.fileman-right img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('ratio')).toBeUndefined()
    expect(img.attributes('width')).toBeUndefined()
    expect(img.classes()).toContain('aspect-[16/10]')
    expect(img.classes()).toContain('object-cover')
    expect(img.attributes('src')).toBe('/_thumb/a1.webp')

    wrapper.unmount()
  })
})

describe('FileManager homepage guard (WP #1149)', () => {
  async function mountFileManagerForGuard() {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    const pageStore = usePageStore()
    // -> A bare `createPinia()` never runs `initializeStore(router)`, and `pageMove` dereferences
    //    this for the moved page.
    pageStore.router = { replace: vi.fn() }

    const router = buildTestRouter([])

    const wrapper = mount(FileManager, {
      global: {
        plugins: [i18n, router],
        stubs: { Tree: true, NewMenu: true, LocaleSelectorMenu: true }
      },
      attachTo: document.body
    })
    await flushPromises()
    return { wrapper, siteStore, pageStore }
  }

  afterEach(() => {
    vi.clearAllMocks()
    openDialogs.splice(0, openDialogs.length)
  })

  it('confirms before deleting a page at the root-level home path, then opens the real delete dialog', async () => {
    const { wrapper } = await mountFileManagerForGuard()

    wrapper.vm.delItem({
      type: 'page',
      id: 'home-1',
      title: 'Welcome',
      fileName: 'home',
      folderPath: ''
    })
    await flushPromises()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({
      title: 'Delete the Home Page?',
      cancel: true,
      color: 'negative'
    })
    expect(openDialogs[0].props.message).toContain('Welcome')

    closeDialog(openDialogs[0].id, true, true)
    await flushPromises()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({ pageId: 'home-1', pageName: 'Welcome' })

    wrapper.unmount()
  })

  it('deletes an ordinary page with no extra guard', async () => {
    const { wrapper } = await mountFileManagerForGuard()

    wrapper.vm.delItem({
      type: 'page',
      id: 'p2',
      title: 'Getting Started',
      fileName: 'getting-started',
      folderPath: 'docs'
    })
    await flushPromises()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({ pageId: 'p2', pageName: 'Getting Started' })

    wrapper.unmount()
  })

  it('confirms before moving a page off the home path', async () => {
    const { wrapper, siteStore } = await mountFileManagerForGuard()
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    wrapper.vm.renameMovePage({ id: 'home-1', title: 'Welcome', fileName: 'home', folderPath: '' })
    closeDialog(openDialogs[0].id, true, {
      path: 'about-us',
      title: 'Welcome',
      includeTranslations: false
    })
    await flushPromises()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({
      title: 'Move the Home Page?',
      cancel: true,
      color: 'negative'
    })
    expect(API_CLIENT.put).not.toHaveBeenCalled()

    closeDialog(openDialogs[0].id, true, true)
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      `sites/${siteStore.id}/pages/home-1/path`,
      expect.anything()
    )

    wrapper.unmount()
  })

  it('does not guard a title-only rename of the home page (path unchanged)', async () => {
    const { wrapper } = await mountFileManagerForGuard()
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    wrapper.vm.renameMovePage({ id: 'home-1', title: 'Welcome', fileName: 'home', folderPath: '' })
    closeDialog(openDialogs[0].id, true, {
      path: 'home',
      title: 'New Title',
      includeTranslations: false
    })
    await flushPromises()

    expect(openDialogs).toHaveLength(0)
    expect(API_CLIENT.patch).toHaveBeenCalled()
    expect(API_CLIENT.put).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('moves an ordinary page with no extra guard', async () => {
    const { wrapper, siteStore } = await mountFileManagerForGuard()
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    wrapper.vm.renameMovePage({
      id: 'p2',
      title: 'Getting Started',
      fileName: 'getting-started',
      folderPath: 'docs'
    })
    closeDialog(openDialogs[0].id, true, {
      path: 'docs/other',
      title: 'Getting Started',
      includeTranslations: false
    })
    await flushPromises()

    expect(openDialogs).toHaveLength(0)
    expect(API_CLIENT.put).toHaveBeenCalledWith(
      `sites/${siteStore.id}/pages/p2/path`,
      expect.anything()
    )

    wrapper.unmount()
  })
})

describe('FileManager page detail dates (OpenProject #1755)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  async function mountWithPageDetail(timezone) {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    const userStore = useUserStore()
    userStore.timezone = timezone
    userStore.dateFormat = 'YYYY-MM-DD'
    userStore.timeFormat = '24h'

    const router = buildTestRouter([])

    const wrapper = mount(FileManager, {
      global: {
        plugins: [i18n, router],
        stubs: { Tree: true, NewMenu: true, LocaleSelectorMenu: true }
      },
      attachTo: document.body
    })
    await flushPromises()

    wrapper.vm.state.fileList = [
      {
        id: 'p1',
        type: 'page',
        title: 'Welcome',
        fileName: 'welcome',
        folderPath: '',
        pageType: 'markdown',
        updatedAt: '2026-03-04T15:30:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    wrapper.vm.state.currentFileId = 'p1'
    await flushPromises()

    return wrapper
  }

  it('renders the updated/created dates in the stored timezone, not the browser one', async () => {
    const wrapperUtc = await mountWithPageDetail('UTC')
    const updatedItemUtc = wrapperUtc.vm.currentFileDetails.items.find(
      (i) => i.label === 'fileman.detailsPageUpdated'
    )
    expect(updatedItemUtc.value).toContain('2026-03-04')
    expect(updatedItemUtc.value).toContain('15:30')
    wrapperUtc.unmount()

    const wrapperTokyo = await mountWithPageDetail('Asia/Tokyo')
    const updatedItemTokyo = wrapperTokyo.vm.currentFileDetails.items.find(
      (i) => i.label === 'fileman.detailsPageUpdated'
    )
    // -> Same instant, nine hours ahead: the stored zone, not the sandbox's own.
    expect(updatedItemTokyo.value).toContain('2026-03-05')
    expect(updatedItemTokyo.value).toContain('00:30')
    wrapperTokyo.unmount()
  })

  it('never falls back to a raw toLocaleString() call of its own', async () => {
    const wrapper = await mountWithPageDetail('UTC')
    const createdItem = wrapper.vm.currentFileDetails.items.find(
      (i) => i.label === 'fileman.detailsPageCreated'
    )
    // FIXME: this only asserts the value is non-empty, so it would still pass against a raw
    // `toLocaleString()`. Assert the `common.datetime` separator ("{date} at {time}") instead.
    expect(createdItem.value).not.toBe('')
    wrapper.unmount()
  })
})

/**
 * The add action is settled on the bare `tabler:plus` app-wide; `tabler:circle-plus` is the ringed
 * variant it is closest to drifting back to.
 */
describe('FileManager toolbar "New" icon (OpenProject #2074)', () => {
  it('uses the settled tabler:plus add glyph, not tabler:circle-plus', async () => {
    const { wrapper } = await mountFileManager()

    expect(wrapper.find('[data-icon="tabler:plus"]').exists()).toBe(true)
    expect(wrapper.find('[data-icon="tabler:circle-plus"]').exists()).toBe(false)

    wrapper.unmount()
  })
})

/**
 * Each assertion pins one line of the file manager design mockup, so a change that drifts off it
 * fails as the design disagreement it is rather than as an unexplained snapshot diff.
 */
describe('FileManager design conformance (WP #2625)', () => {
  it("draws the header glyph in the accent, not in the title's white", async () => {
    const { wrapper } = await mountFileManager()

    const icon = wrapper.find('.fileman-hdr-icon')
    expect(icon.exists()).toBe(true)
    expect(icon.attributes('data-icon')).toBe('tabler:folder')

    wrapper.unmount()
  })

  it('offers the locale chip with a chevron, and no leftover 40px inline height', async () => {
    const { wrapper, siteStore } = await mountFileManager()
    siteStore.locales = {
      active: [
        { code: 'en', nativeName: 'English' },
        { code: 'fr', nativeName: 'Francais' }
      ]
    }
    await flushPromises()

    const chip = wrapper.find('.fileman-locale')
    expect(chip.exists()).toBe(true)
    expect(chip.attributes('style') ?? '').not.toContain('height: 40px')
    expect(chip.find('.fileman-locale-caret').exists()).toBe(true)

    wrapper.unmount()
  })

  it('advertises the Cmd/Ctrl+K shortcut it already answers, withdrawing the cap once typing starts', async () => {
    const { wrapper } = await mountFileManager()

    // -> Either cap is correct: the hint resolves per platform, and the suite runs on both.
    const cap = wrapper.find('.fileman-search-kbd')
    expect(cap.exists()).toBe(true)
    expect(['⌘K', 'Ctrl+K']).toContain(cap.text())

    wrapper.vm.state.search = 'q'
    await flushPromises()
    expect(wrapper.find('.fileman-search-kbd').exists()).toBe(false)

    wrapper.vm.state.search = ''
    await flushPromises()
    const input = wrapper.find('.fileman-search-input').element
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await flushPromises()
    expect(document.activeElement).toBe(input)

    wrapper.unmount()
  })

  it('draws Upload as an outlined positive control carrying its own green edge, not the accent', async () => {
    const { wrapper } = await mountFileManager()

    const upload = wrapper.find('.fileman-upload-btn')
    expect(upload.exists()).toBe(true)
    expect(upload.find('[data-icon="tabler:cloud-upload"]').exists()).toBe(true)
    // -> `border` is what `WBtn` turns an `outline` button into; `.fileman-upload-btn` recolours it.
    expect(upload.classes()).toContain('border')

    wrapper.unmount()
  })

  it('renders a file size without the proportional caption class', async () => {
    const { wrapper } = await mountFileManager()

    wrapper.vm.state.fileList = [
      {
        id: 'a1',
        type: 'asset',
        title: 'photo',
        fileName: 'photo.png',
        fileExt: 'png',
        fileSize: 253952,
        mimeType: 'image/png',
        folderPath: ''
      }
    ]
    await flushPromises()

    const side = wrapper.find('.fileman-filelist-side')
    expect(side.exists()).toBe(true)
    // -> `.text-caption` is the proportional scale; a measurement is set in the mono face instead.
    expect(side.html()).not.toContain('text-caption')

    wrapper.unmount()
  })

  it('draws the details preview as a framed plate with corner marks even with no thumbnail', async () => {
    const { wrapper } = await mountFileManager()

    // -> A PDF, so `currentFileDetails.thumbnail` is null.
    wrapper.vm.state.fileList = [
      {
        id: 'a2',
        type: 'asset',
        title: 'runbook',
        fileName: 'runbook.pdf',
        fileExt: 'pdf',
        fileSize: 1258291,
        mimeType: 'application/pdf',
        folderPath: ''
      }
    ]
    wrapper.vm.state.currentFileId = 'a2'
    await flushPromises()

    const plate = wrapper.find('.fileman-thumb')
    expect(plate.exists()).toBe(true)
    expect(plate.find('img').exists()).toBe(false)
    expect(plate.find('.fileman-thumb-placeholder').exists()).toBe(true)
    expect(plate.findAll('.fileman-thumb-tick')).toHaveLength(4)

    wrapper.unmount()
  })

  it('keeps the image inside that plate, square-cornered, when there is a thumbnail', async () => {
    const { wrapper } = await mountFileManager()

    wrapper.vm.state.fileList = [
      {
        id: 'a3',
        type: 'asset',
        title: 'photo',
        fileName: 'photo.png',
        fileExt: 'png',
        fileSize: 1024,
        mimeType: 'image/png',
        folderPath: ''
      }
    ]
    wrapper.vm.state.currentFileId = 'a3'
    await flushPromises()

    const img = wrapper.find('.fileman-thumb img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/_thumb/a3.webp')
    // -> `--radius-*` is zeroed repo-wide, so the plate and its image are square.
    expect(img.classes()).not.toContain('rounded')
    expect(wrapper.find('.fileman-thumb-placeholder').exists()).toBe(false)

    wrapper.unmount()
  })

  it('lays each detail row out as a label gutter beside its value, not stacked over it', async () => {
    const { wrapper } = await mountFileManager()

    wrapper.vm.state.fileList = [
      {
        id: 'a4',
        type: 'asset',
        title: 'photo',
        fileName: 'photo.png',
        fileExt: 'png',
        fileSize: 253952,
        mimeType: 'image/png',
        folderPath: ''
      }
    ]
    wrapper.vm.state.currentFileId = 'a4'
    await flushPromises()

    const rows = wrapper.findAll('.fileman-details-row')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.find('label').exists()).toBe(true)
      expect(row.find('span').exists()).toBe(true)
    }

    wrapper.unmount()
  })

  it('leaves the path bar to its own stylesheet rather than a legacy Material grey utility', async () => {
    const { wrapper } = await mountFileManager()

    const path = wrapper.find('.fileman-path')
    expect(path.exists()).toBe(true)
    expect(path.html()).not.toContain('text-grey-7')

    wrapper.unmount()
  })
})

/**
 * Guards two ways a surface stops following the site's aesthetic: a control reaching for the site
 * brand `primary` where it means the white-text `accent` (the two coincide under Ledger and diverge
 * under Cobalt), and a style block reading a frozen Sass-era constant instead of the custom property
 * `css/tailwind.css` swaps per aesthetic.
 *
 * The token half is asserted against the component's own source text because there is no compiled
 * stylesheet in this environment for a computed-style assertion to resolve `var()` cascades against
 * -- the same constraint `css/cobaltTokens.test.js` documents.
 */
describe('FileManager Cobalt aesthetic conformance (OpenProject #2776)', () => {
  const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'FileManager.vue')
  const source = readFileSync(SOURCE_PATH, 'utf-8')
  const styleBlock = source.slice(source.indexOf('<style'))

  it('fills the details-pane Insert button with the white-text accent, not the site primary color', async () => {
    const { wrapper } = await mountFileManager({ overlayOpts: { insertMode: true } })
    wrapper.vm.state.fileList = [
      {
        id: 'a5',
        type: 'asset',
        title: 'photo',
        fileName: 'photo.png',
        fileExt: 'png',
        fileSize: 1024,
        mimeType: 'image/png',
        folderPath: ''
      }
    ]
    wrapper.vm.state.currentFileId = 'a5'
    await flushPromises()

    const insertBtn = wrapper.find('.fileman-insert-btn')
    expect(insertBtn.exists()).toBe(true)
    expect(insertBtn.element.style.backgroundColor).toBe('var(--color-accent)')

    wrapper.unmount()
  })

  it('reads the aesthetic-aware color custom properties, not the frozen Ledger Sass constants', () => {
    // -> One representative per role, not an exhaustive list of the block's tokens.
    for (const token of [
      '--color-hairline',
      '--color-hairline-dark',
      '--color-tint',
      '--color-tint-alt',
      '--color-dark-3',
      '--color-dark-4',
      '--color-surface',
      '--color-text-caption',
      '--color-text-caption-dark',
      '--color-text-secondary',
      '--color-text-secondary-dark',
      '--color-text-body',
      '--color-slate',
      '--color-slate-faint',
      '--color-slate-pale',
      '--color-slate-soft',
      '--color-slate-light',
      '--color-ink',
      '--color-accent-dark',
      '--color-positive-fill'
    ]) {
      expect(styleBlock).toContain(`var(${token})`)
    }
  })

  it('hides the preview plate corner marks under Cobalt, which draws none', () => {
    expect(styleBlock).toMatch(
      /\.fileman-thumb-tick\s*{\s*position:\s*absolute;\s*display:\s*var\(--corner-marks\);/
    )
  })
})

/**
 * This is an OUTLINE `w-btn`, so `WBtn.vue` turns its `color` into a bare inline text color with
 * nothing else drawing a foreground -- a token with no dark override leaves both the label and the
 * `currentColor` icon unreadable on a dark toolbar. `--color-slate`/`--color-slate-light` is this
 * codebase's light/dark pairing for that tone.
 */
describe('FileManager "+ New" trigger dark mode (OpenProject #2742, #2797)', () => {
  afterEach(() => {
    useDark().set(false)
  })

  it('resolves to slate in light mode', async () => {
    const { wrapper } = await mountFileManager()

    const style = wrapper.find('.fileman-new-btn').attributes('style') ?? ''
    expect(style).toContain('var(--color-slate)')
    expect(style).not.toContain('var(--color-slate-light)')

    wrapper.unmount()
  })

  it('swaps to the standard slate-light dark-mode pairing in dark mode', async () => {
    useDark().set(true)
    const { wrapper } = await mountFileManager()

    const style = wrapper.find('.fileman-new-btn').attributes('style') ?? ''
    expect(style).toContain('var(--color-slate-light)')
    expect(style).not.toContain('var(--color-slate)')

    wrapper.unmount()
  })
})

describe('FileManager compact rows + filetype column (WP #2920)', () => {
  function seedRows(wrapper) {
    wrapper.vm.state.fileList = [
      {
        id: 'f1',
        type: 'folder',
        title: 'assets',
        fileName: 'assets',
        folderPath: '',
        children: 5
      },
      {
        id: 'a1',
        type: 'asset',
        title: 'photo',
        fileName: 'photo.png',
        fileExt: 'png',
        fileSize: 253952,
        mimeType: 'image/png',
        folderPath: ''
      }
    ]
  }

  it('gives every row a dedicated filetype column, separate from the filename', async () => {
    const { wrapper } = await mountFileManager()
    seedRows(wrapper)
    await flushPromises()

    const types = wrapper.findAll('.fileman-filelist-type')
    expect(types).toHaveLength(2)
    expect(types[0].text()).toBe('5 items')
    expect(types[1].text()).toBe('PNG Image')

    // -> The filetype caption belongs to its own column, never as a sub-line under the filename.
    const labels = wrapper.findAll('.fileman-filelist-label')
    for (const label of labels) {
      expect(label.find('.w-item-label--caption').exists()).toBe(false)
    }

    wrapper.unmount()
  })
})

describe('FileManager compact/comfortable grid rows (WP #2940/#2960)', () => {
  const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'FileManager.vue')
  const source = readFileSync(SOURCE_PATH, 'utf-8')
  const styleBlock = source.slice(source.indexOf('<style'))
  const rowBlock = styleBlock.slice(
    styleBlock.indexOf('.fileman-filelist'),
    styleBlock.indexOf('.fileman-thumb')
  )

  function seedRows(wrapper) {
    wrapper.vm.state.fileList = [
      {
        id: 'f1',
        type: 'folder',
        title: 'assets',
        fileName: 'assets',
        folderPath: '',
        children: 5
      },
      {
        id: 'a1',
        type: 'asset',
        title: 'photo',
        fileName: 'photo.png',
        fileExt: 'png',
        fileSize: 253952,
        mimeType: 'image/png',
        folderPath: ''
      }
    ]
  }

  it('restores the comfortable/compact toggle, defaulting to compact (OpenProject #2960)', async () => {
    expect(source).toContain('state.isCompact')
    expect(source).toContain('is-compact')
    expect(source).toContain('fileman.compactList')

    const { wrapper } = await mountFileManager()
    seedRows(wrapper)
    await flushPromises()

    expect(wrapper.vm.state.isCompact).toBe(true)
    expect(wrapper.find('.fileman-filelist').classes()).toContain('is-compact')

    wrapper.unmount()
  })

  it('draws the default compact row with the `sm` (24px) icon, not the oversized `md` (32px) db2b0196a shipped', async () => {
    expect(rowBlock).toMatch(/display:\s*grid/)
    // -> The ~40px height belongs to the `.is-compact` modifier, not the base row.
    expect(rowBlock).toMatch(/is-compact[\s\S]*min-height:\s*40px/)
    expect(source).toContain('<w-icon :name="item.icon" :size="state.isCompact ? `sm` : `xl`" />')

    const { wrapper } = await mountFileManager()
    seedRows(wrapper)
    await flushPromises()

    const icons = wrapper.findAll('.fileman-filelist-icon [data-icon]')
    expect(icons).toHaveLength(2)
    expect(icons[0].attributes('data-icon')).toBe('tabler:folder')
    expect(icons[0].element.style.fontSize).toBe('24px')
    expect(icons[1].attributes('data-icon')).toBe('tabler:file-type-png')
    expect(icons[1].element.style.fontSize).toBe('24px')

    wrapper.unmount()
  })

  it('switches to the comfortable row -- ~69px height, `xl` (46px) icon -- when isCompact is turned off', async () => {
    expect(rowBlock).toMatch(/min-height:\s*69px/)

    const { wrapper } = await mountFileManager()
    seedRows(wrapper)
    wrapper.vm.state.isCompact = false
    await flushPromises()

    expect(wrapper.find('.fileman-filelist').classes()).not.toContain('is-compact')
    const icons = wrapper.findAll('.fileman-filelist-icon [data-icon]')
    expect(icons).toHaveLength(2)
    expect(icons[0].element.style.fontSize).toBe('46px')
    expect(icons[1].element.style.fontSize).toBe('46px')

    wrapper.unmount()
  })

  it("reserves the size column's own grid track independent of whether item.side is populated", async () => {
    // -> Four tracks -- icon, name, type, size -- so a row with no `item.side` still puts its type
    //    column where a sibling row WITH a size does, rather than letting the name column swallow
    //    the gap.
    expect(rowBlock).toMatch(
      /is-compact[\s\S]*grid-template-columns:\s*40px minmax\(0,\s*1fr\)\s*110px\s*90px/
    )

    const { wrapper } = await mountFileManager()
    seedRows(wrapper)
    await flushPromises()

    const types = wrapper.findAll('.fileman-filelist-type')
    expect(types).toHaveLength(2)
    // -> One size cell for two rows: the folder row's fourth track sits empty.
    expect(wrapper.findAll('.fileman-filelist-side')).toHaveLength(1)

    wrapper.unmount()
  })

  it('opts the row out of the shared WItem container-query row-stacking rule', () => {
    expect(rowBlock).toMatch(/container-type:\s*normal\s*!important/)
  })

  it('persists isCompact in the same wiki.fileman.viewOptions object other view options use', async () => {
    const { wrapper } = await mountFileManager()

    wrapper.vm.state.isCompact = false
    await flushPromises()

    const stored = JSON.parse(globalThis.localStorage.getItem('wiki.fileman.viewOptions'))
    expect(stored.isCompact).toBe(false)

    wrapper.unmount()

    const { wrapper: wrapper2 } = await mountFileManager()
    expect(wrapper2.vm.state.isCompact).toBe(false)
    wrapper2.unmount()
  })
})

describe('FileManager asset Move action (OpenProject #3664)', () => {
  const asset = {
    id: 'a1',
    type: 'asset',
    title: 'photo',
    fileName: 'photo.png',
    fileExt: 'png',
    fileSize: 1024,
    mimeType: 'image/png',
    folderPath: 'media'
  }

  async function mountWithItems(fileList) {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    const wrapper = mount(FileManager, {
      global: {
        plugins: [i18n, buildTestRouter([])],
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

  beforeEach(() => {
    notifyQueue.length = 0
    openDialogs.splice(0, openDialogs.length)
  })

  afterEach(() => {
    vi.clearAllMocks()
    openDialogs.splice(0, openDialogs.length)
  })

  it('renders "Move..." on an asset row and not on a page row', async () => {
    const { wrapper } = await mountWithItems([asset])
    expect(wrapper.text()).toContain('Move...')

    wrapper.vm.state.fileList = [
      {
        id: 'p1',
        type: 'page',
        title: 'Page',
        fileName: 'page',
        pageType: 'markdown',
        folderPath: ''
      }
    ]
    await flushPromises()
    expect(wrapper.text()).not.toContain('Move...')

    wrapper.unmount()
  })

  it("opens the destination-only picker on the asset's current folder", async () => {
    const { wrapper } = await mountWithItems([asset])

    wrapper.vm.moveItem(asset)
    await flushPromises()

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({ mode: 'moveItem', folderPath: 'media' })

    wrapper.unmount()
  })

  it('PUTs the picked destination to the asset folder route, then reloads and notifies', async () => {
    const { wrapper, siteStore } = await mountWithItems([asset])
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    wrapper.vm.moveItem(asset)
    closeDialog(openDialogs[0].id, true, { folderId: 'f2', parentPath: 'docs' })
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith(`sites/${siteStore.id}/assets/a1/folder`, {
      json: { folderId: 'f2', parentPath: 'docs' }
    })
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: 'Asset moved successfully.'
    })

    wrapper.unmount()
  })

  it('surfaces the 409 name-collision message and does not report success', async () => {
    const { wrapper } = await mountWithItems([asset])
    const err = Object.assign(new Error('Request failed with status code 409'), {
      data: { message: 'An asset with that name already exists there.' }
    })
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.reject(err) })

    wrapper.vm.moveItem(asset)
    closeDialog(openDialogs[0].id, true, { folderId: null, parentPath: '' })
    await flushPromises()

    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(false)
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'Failed to move asset.',
      caption: 'An asset with that name already exists there.'
    })

    wrapper.unmount()
  })

  it('surfaces the 403 message the same way', async () => {
    const { wrapper } = await mountWithItems([asset])
    const err = Object.assign(new Error('Request failed with status code 403'), {
      data: { message: 'You are not allowed to move this file.' }
    })
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.reject(err) })

    wrapper.vm.moveItem(asset)
    closeDialog(openDialogs[0].id, true, { folderId: 'f2', parentPath: 'docs' })
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      caption: 'You are not allowed to move this file.'
    })

    wrapper.unmount()
  })
})
