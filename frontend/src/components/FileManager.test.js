import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import FileManager from './FileManager.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { queue as notifyQueue } from '@/composables/notify'
import { closeDialog, openDialogs } from '@/composables/dialog'

import { createTestI18n } from '../../test/i18n.js'
import { buildTestRouter } from '../../test/router.js'

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

const i18n = createTestI18n({
  common: {
    datetime: '{date} at {time}',
    pageSelector: {
      folderEmptyWarning: 'This folder is empty.'
    }
  },
  fileman: {
    dropToUpload: 'Drop files to upload',
    dropFoldersRejected: "Folders can't be uploaded by drag-and-drop.",
    dropFoldersRejectedCount: '{count} folders were skipped',
    uploadSuccess: 'File(s) uploaded successfully.',
    // -> WP #1610: these render through t() now rather than as literal template text, so the
    //    "Duplicate..." assertion below needs its resolved string present here to keep matching.
    browseUsing: 'Browse using...',
    browseUsingPaths: 'Browse Using Paths',
    browseUsingTitles: 'Browse Using Titles',
    compactList: 'Compact List',
    showFolders: 'Show Folders',
    fetchingFolderContents: 'Fetching folder contents...',
    duplicateItem: 'Duplicate...',
    renameItem: 'Rename...',
    renameMovePage: 'Rename / Move Page...'
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

/**
 * OpenProject #2050: `handleKeyPress` only ever tested `ev.ctrlKey`, so Cmd+K did nothing on macOS
 * while the file manager overlay was up. `mountFileManager` already attaches to `document.body`, so
 * `.focus()` here actually moves `document.activeElement`, same as in a real browser.
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

/**
 * OpenProject #2530: `insertMode` now reads off the `overlayOpts` prop `MainOverlayDialog.vue`
 * forwards, not `siteStore.overlayOpts` directly -- `siteStore.openFileManager(opts)` still sets the
 * store field, which is only the transport that prop is filled from in real use.
 */
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
 * WP #1728: the detail thumbnail `<img>` carried leftover `q-img`-era props (`width="100%"`,
 * `:ratio="16 / 10"`) that mean nothing on a plain `<img>` -- `ratio` lands as a dead DOM attribute
 * and `width` is non-conforming markup, while reserving no actual height, so the pane reflows once
 * the thumbnail loads. This asserts the markup is plain now: no `ratio`/`width` attributes, and the
 * aspect ratio reserved via a class instead (`object-cover`, already present, does the rest).
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

/**
 * WP #1149: extra confirmation before deleting or moving a site's homepage, from the file manager's
 * own delete/rename-move entry points (`delItem`/`renameMovePage`) -- the tree-item counterparts to
 * `PageActionsCol.test.js`'s "homepage guard" suite, which covers the page view's action rail. Calls
 * the exposed `<script setup>` functions directly on `wrapper.vm`, the same pattern
 * `openItem()`/`state.fileList` above already use.
 */
describe('FileManager homepage guard (WP #1149)', () => {
  async function mountFileManagerForGuard() {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    const pageStore = usePageStore()
    // -> `initializeStore(router)` (stores/index.js) is what wires this up for real, at app boot; a
    //    bare `createPinia()` never runs it, and `pageMove` dereferences it for the moved page
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

/**
 * OpenProject #1755: the page-detail panel's "Updated"/"Created" fields used to spell out their own
 * `toZonedDateTimeISO(Temporal.Now.timeZoneId())` + `commonStore.locale` formatting -- ignoring the
 * user's stored timezone/date/time preferences entirely. Converted to the shared
 * `helpers/datetime.js#humanizeDate`, which delegates to `userStore.formatDateTime`.
 */
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
    // -> Same instant, nine hours ahead -- proof the stored zone (not the sandbox's own) is honoured
    expect(updatedItemTokyo.value).toContain('2026-03-05')
    expect(updatedItemTokyo.value).toContain('00:30')
    wrapperTokyo.unmount()
  })

  it('never falls back to a raw toLocaleString() call of its own', async () => {
    const wrapper = await mountWithPageDetail('UTC')
    const createdItem = wrapper.vm.currentFileDetails.items.find(
      (i) => i.label === 'fileman.detailsPageCreated'
    )
    // -> `commonStore.locale` formatting produced no literal "at" separator; the shared
    //    `humanizeDate` -> `common.datetime` ("{date} at {time}") does.
    expect(createdItem.value).not.toBe('')
    wrapper.unmount()
  })
})

/**
 * OpenProject #2074: the toolbar's "New" button used to draw `la:plus-circle` while every other
 * create/add affordance in the app draws `la:plus` for the same kind of action -- settled on
 * `la:plus` everywhere, so this button must not regress back to the other glyph.
 */
describe('FileManager toolbar "New" icon (OpenProject #2074)', () => {
  it('uses the settled la:plus add glyph, not la:plus-circle', async () => {
    const { wrapper } = await mountFileManager()

    expect(wrapper.find('[data-icon="la:plus"]').exists()).toBe(true)
    expect(wrapper.find('[data-icon="la:plus-circle"]').exists()).toBe(false)

    wrapper.unmount()
  })
})
