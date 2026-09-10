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
    // -> The key-cap hint resolves through the SAME two keys `HeaderSearch` uses; see the design
    //    conformance suite at the bottom of this file.
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
    renameMovePage: 'Rename / Move Page...',
    // -> WP #2920's dedicated filetype column reads these through the same `fileman.*FileType`/
    //    `*PageType`/`folderChildrenCount` keys the row already resolves `item.caption` from.
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
 * OpenProject #2074: the toolbar's "New" button used to draw a ringed plus while every other
 * create/add affordance in the app drew a bare one. The add action is settled on `tabler:plus`, so
 * this button must not drift back to a ringed variant -- `tabler:circle-plus` is the one sitting
 * closest to it in the set.
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
 * WP #2625: the first full comparison of this screen against `ui-redesign/Cardinal Wiki - File
 * Manager 3x.dc.html`. Each assertion below names one line of that file, so a later change that
 * drifts back off it fails as the design disagreement it is rather than as an unexplained snapshot
 * diff. What the design draws but this pass deliberately did NOT change -- the file-type icon set
 * (`helpers/fileTypes.js`, four call sites), `.card-header`'s own title size, the folder tree's row
 * rhythm (`TreeNav.vue`, four call sites) and the Insert button's `#e4676b` fill (2.9:1 under a
 * white label) -- is recorded on the work package, not asserted here.
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

    // -> Resolved through `common.header.searchShortcut*`, whichever platform the suite runs on
    const cap = wrapper.find('.fileman-search-kbd')
    expect(cap.exists()).toBe(true)
    expect(['⌘K', 'Ctrl+K']).toContain(cap.text())

    wrapper.vm.state.search = 'q'
    await flushPromises()
    expect(wrapper.find('.fileman-search-kbd').exists()).toBe(false)

    // -> ...and the key it advertises really is bound
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
    // -> `outline`, which is what `WBtn` turns into a `border` class; the class above recolours it
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
    // -> `.text-caption` is the proportional scale; a measurement is set in the mono face instead
    expect(side.html()).not.toContain('text-caption')

    wrapper.unmount()
  })

  it('draws the details preview as a framed plate with corner marks even with no thumbnail', async () => {
    const { wrapper } = await mountFileManager()

    // -> A PDF: `currentFileDetails.thumbnail` is null, which used to mean no plate at all
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
    // -> `--radius-*` is zeroed repo-wide; the plate and its image are square
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
 * OpenProject #2776 ("History + File manager: diff against Cobalt mockups, fix gaps"). Diffing this
 * screen against `Cardinal Wiki - File Manager 3x - Cobalt.dc.html` at the same width found two
 * kinds of gap, both left over from before a second aesthetic existed to tell Ledger's coincidences
 * apart from its actual roles:
 *
 * 1. The details-pane "Insert" button (`color="primary"`) and Ledger's own `#c14a52` are the SAME
 *    tone as Cobalt's white-text accent (`--q-accent`, `#c8303c`), but `--q-primary` (Cobalt's site
 *    brand blue, `#1f4fd6`) is not -- so the button rendered the wrong colour the moment the two
 *    aesthetics gave "primary" and "accent" different values. Covered directly through `WBtn`'s own
 *    resolved inline style, the same way `WBtn.test.js` does.
 * 2. Most of this file's `<style lang="scss">` block read Sass compile-time constants
 *    (`$hairline`, `$dark-4`, `$tint`, ...) instead of the CSS custom properties `css/tailwind.css`
 *    actually swaps per aesthetic (`--color-hairline`, `--color-dark-4`, `--color-tint`, ...) --
 *    identical in Ledger, since a Sass constant and its custom-property twin start at the same
 *    value, but frozen there under Cobalt too. There is no compiled stylesheet in this test
 *    environment for a computed-style assertion to resolve `var()` cascades against (the same
 *    constraint `css/cobaltTokens.test.js` documents), so this is checked the same way that suite
 *    checks a hand-edited token file: against the component's own source text.
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
    // -> One representative per role this pass converted; a regression on any of them means a
    //    component-owned surface stopped following the site's aesthetic again.
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
      /&-tick\s*{\s*position:\s*absolute;\s*display:\s*var\(--corner-marks\);/
    )
  })
})

/**
 * OpenProject #2742: the "+ New" trigger's `color` prop was a flat `slate`, with no dark-mode
 * counterpart. Because this is an OUTLINE `w-btn`, `WBtn.vue` turns a non-solid `color` into a bare
 * `color: var(--color-<name>)` inline style with nothing else drawing a foreground, so
 * `--color-slate` (`#38465f`, no dark override) is what both the label text and the `tabler:plus`
 * icon (inheriting `currentColor`) rendered in against a dark toolbar.
 *
 * OpenProject #2797: the dark-mode counterpart #2742 introduced was the ad-hoc `text-secondary-dark`
 * token rather than `slate-light`, the pairing this codebase uses everywhere else for slate's
 * dark-mode tone (see `AdminBlocks.vue` and `tailwind.css`'s `--color-slate`/`--color-slate-light`).
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

/**
 * OpenProject #2920 ("File Manager: compact row height + dedicated filetype column"). The filetype
 * caption ("PNG Image", "5 items", ...) used to be a sub-line under the filename, hidden entirely in
 * compact mode; it now lives in its own column between the filename and the size.
 */
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

    // -> The filename column is exclusive now -- no more sub-line caption under it
    const labels = wrapper.findAll('.fileman-filelist-label')
    for (const label of labels) {
      expect(label.find('.w-item-label--caption').exists()).toBe(false)
    }

    wrapper.unmount()
  })
})

/**
 * OpenProject #2940 ("File manager rows are 69px tall (should be 40px/compact-default), size
 * column misaligns, icons aren't 100% Tabler") and OpenProject #2960 ("restore comfortable row
 * density as a user preference, compact stays default; compact icons too large"). #2940 laid the
 * row out on CSS Grid rather than flex so the size column's width is reserved whether or not a
 * given row actually has one -- that part stands for both densities. It ALSO deleted comfortable
 * mode outright rather than merely defaulting away from it, which #2960 restores: `state.isCompact`
 * and the "Compact List" view-options toggle are back, `isCompact` now starting `true` so compact
 * still ships as the default, and its icon corrected from the oversized `md` (32px) #2940 shipped
 * to `sm` (24px) -- matching `TreeBrowserDialog.vue`'s own row icon for the same kind of list.
 */
describe('FileManager compact/comfortable grid rows (WP #2940/#2960)', () => {
  const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'FileManager.vue')
  const source = readFileSync(SOURCE_PATH, 'utf-8')
  const styleBlock = source.slice(source.indexOf('<style'))
  const rowBlock = styleBlock.slice(styleBlock.indexOf('&-filelist'), styleBlock.indexOf('&-thumb'))

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

    // -> `isCompact` starts `true` -- db2b0196a's over-correction deleted comfortable outright
    //    rather than merely defaulting away from it; #2960 restores the choice but keeps compact
    //    as what a reader sees with no preference saved yet.
    expect(wrapper.vm.state.isCompact).toBe(true)
    expect(wrapper.find('.fileman-filelist').classes()).toContain('is-compact')

    wrapper.unmount()
  })

  it('draws the default compact row with the `sm` (24px) icon, not the oversized `md` (32px) db2b0196a shipped', async () => {
    expect(rowBlock).toMatch(/display:\s*grid/)
    // -> The ~40px height lives under the `.is-compact` modifier now, not the base row
    expect(rowBlock).toMatch(/is-compact[\s\S]*min-height:\s*40px/)
    expect(source).toContain('<w-icon :name="item.icon" :size="state.isCompact ? `sm` : `xl`" />')

    const { wrapper } = await mountFileManager()
    seedRows(wrapper)
    await flushPromises()

    // -> Both rows resolve a real icon -- a folder and a mapped file extension -- at the compact
    //    default's `sm` (24px) size, matching `TreeBrowserDialog.vue`'s own row icon
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
    // -> Four fixed/flexible tracks -- icon, name, type, size -- so a row with no `item.side` (a
    //    folder or a page) still leaves the type column exactly where a sibling row WITH a size
    //    puts it, rather than letting the name column grow to swallow the gap. Checked against the
    //    default compact density's own track widths.
    expect(rowBlock).toMatch(
      /is-compact[\s\S]*grid-template-columns:\s*40px minmax\(0,\s*1fr\)\s*110px\s*90px/
    )

    const { wrapper } = await mountFileManager()
    seedRows(wrapper)
    await flushPromises()

    // -> The folder row (no size) still renders its type column
    const types = wrapper.findAll('.fileman-filelist-type')
    expect(types).toHaveLength(2)
    // -> Only the file row renders a size cell at all -- the folder row's fourth track sits empty
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

    // -> A fresh mount picks the stored value back up, not the `true` default
    const { wrapper: wrapper2 } = await mountFileManager()
    expect(wrapper2.vm.state.isCompact).toBe(false)
    wrapper2.unmount()
  })
})
