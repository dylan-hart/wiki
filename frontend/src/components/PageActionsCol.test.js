import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('browser-fs-access', () => ({
  fileSave: vi.fn().mockResolvedValue(undefined)
}))

import { fileSave } from 'browser-fs-access'
import PageActionsCol from './PageActionsCol.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { queue as notifyQueue } from '@/composables/notify'
import { closeDialog, openDialogs } from '@/composables/dialog'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

const HOMEPAGE_GUARD_MESSAGES = {
  en: {
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
  }
}

/**
 * WP #1610: the rail's aria-labels and tooltips now resolve through `t()` rather than carrying
 * hardcoded English literals, so every mount helper below needs the real `en.json` strings present
 * (not the empty `{ en: {} }` a pre-translation mount could get away with) for its `[aria-label="…"]`
 * selectors and `.w-item` label assertions to keep matching resolved output.
 */
const PAGE_ACTIONS_MESSAGES = {
  ...HOMEPAGE_GUARD_MESSAGES.en,
  common: {
    page: {
      properties: 'Page Properties',
      data: 'Page Data',
      history: 'Page History',
      duplicate: 'Duplicate Page',
      renameMove: 'Rename / Move Page',
      rerender: 'Rerender Page',
      viewBacklinks: 'View Backlinks',
      delete: 'Delete Page'
    },
    pendingAssets: {
      title: 'Pending Asset Uploads',
      empty: 'There are no assets pending uploads.',
      newFileName: 'New file name',
      confirmRename: 'Confirm Rename',
      cancelRename: 'Cancel Rename',
      renameAsset: 'Rename Pending Asset',
      removeAsset: 'Remove Pending Asset',
      helpText:
        'Assets that are pasted or dropped onto this page will be held here until the page is saved.'
    }
  },
  pages: {
    ...HOMEPAGE_GUARD_MESSAGES.en.pages,
    export: {
      title: 'Export Page',
      markdown: 'Markdown',
      html: 'HTML',
      pdf: 'PDF'
    }
  }
}

/**
 * WP #1149: extra confirmation before deleting or moving a site's homepage (the hardcoded `home` /
 * `''` path convention -- `pageStore.isHome`). Its own mount helper because it needs
 * `delete:pages`/`manage:pages`, which none of the other mount helpers below grant together.
 */
async function mountRailForGuard({
  path = 'home',
  permissions = ['delete:pages', 'manage:pages']
} = {}) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = path
  pageStore.title = 'Welcome'
  pageStore.editor = 'markdown'
  // -> `initializeStore(router)` (stores/index.js) is what wires this up for real, at app boot; a
  //    bare `createPinia()` never runs it, and `pageMove` dereferences it for the page it just moved
  pageStore.router = { replace: vi.fn() }

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const userStore = useUserStore()
  userStore.permissions = permissions

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n(PAGE_ACTIONS_MESSAGES)

  const wrapper = mount(PageActionsCol, {
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  return { wrapper, pageStore, siteStore, userStore, router }
}

/**
 * Task 502: the standalone "Page Source" rail button is retired in favour of a single "Export Page"
 * `w-menu` offering Markdown / HTML / PDF, matching the pattern the "..." Page Actions menu below it
 * already uses. `w-menu`'s panel is teleported to `document.body` (see `WMenu.vue`), so once the
 * trigger is clicked the panel has to be queried off `document`, not off `wrapper` -- `wrapper.find`
 * only ever searches the mounted root's own subtree.
 */
async function mountRail({ pdfExportAvailable = false } = {}) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = 'docs/getting-started'
  pageStore.editor = 'markdown'

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  siteStore.pdfExportAvailable = pdfExportAvailable

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n(PAGE_ACTIONS_MESSAGES)

  const wrapper = mount(PageActionsCol, {
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  const trigger = wrapper.get('[aria-label="pageActions.exportPage"]')
  await trigger.trigger('click')
  await flushPromises()

  return { wrapper, pageStore, siteStore }
}

function menuItemLabels() {
  return [...document.querySelectorAll('.w-menu .w-item')].map((el) => el.textContent.trim())
}

function clickMenuItem(label) {
  const item = [...document.querySelectorAll('.w-menu .w-item')].find((el) =>
    el.textContent.includes(label)
  )
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/**
 * OpenProject #811: an unsaved (never-saved) page has no `pageStore.id` yet, so clicking Page
 * History must not open the overlay -- there is nothing for it to fetch. Its own mount setup, since
 * the "Page History" button is gated on `read:history` (see PageActionsCol.vue), which `mountRail`
 * above never grants.
 */
async function mountRailWithHistory({ pageId = 'page-1', creating = false } = {}) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = pageId
  pageStore.path = 'docs/getting-started'
  pageStore.editor = 'markdown'

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const userStore = useUserStore()
  userStore.permissions = ['read:history']

  // -> The ticket's actual scenario: a brand-new, never-saved page, still open in the editor
  if (creating) {
    const editorStore = useEditorStore()
    editorStore.isActive = true
    editorStore.mode = 'create'
  }

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n(PAGE_ACTIONS_MESSAGES)

  const wrapper = mount(PageActionsCol, {
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  return { wrapper, pageStore, siteStore, userStore }
}

/**
 * OpenProject #1911: Page Data / Page Data Templates was decided OUT (#1890) rather than built out --
 * the rail's disabled "Page Data" button (behind `flagsStore.experimental`, with a hardcoded
 * `disable`) and its `togglePageData` handler are gone entirely, not just re-hidden.
 */
describe('PageActionsCol Page Data removal (#1911)', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('never renders a Page Data button, even with the experimental flag on', async () => {
    ;({ wrapper } = await mountRailWithPageActions())
    const flagsStore = useFlagsStore()
    flagsStore.experimental = true
    await flushPromises()

    expect(wrapper.find('[aria-label="Page Data"]').exists()).toBe(false)
  })
})

describe('PageActionsCol page history button', () => {
  let wrapper

  beforeEach(() => {
    notifyQueue.splice(0, notifyQueue.length)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('opens the History overlay when the page has been saved', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithHistory({ pageId: 'page-1' }))

    await wrapper.get('[aria-label="pageActions.pageHistory"]').trigger('click')

    expect(ctx.siteStore.overlay).toBe('PageHistory')
    expect(notifyQueue).toHaveLength(0)
  })

  it('notifies instead of opening the overlay for an unsaved page with no id', async () => {
    let ctx
    // -> '' is the store's real default (page.js), not a stand-in like `null` -- a never-saved page
    //    has literally never been assigned an id
    ;({ wrapper } = ctx = await mountRailWithHistory({ pageId: '', creating: true }))

    await wrapper.get('[aria-label="pageActions.pageHistory"]').trigger('click')

    expect(ctx.siteStore.overlay).toBeNull()
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0]).toMatchObject({ type: 'info' })
  })
})

describe('PageActionsCol export menu', () => {
  let wrapper

  beforeEach(() => {
    API_CLIENT.get.mockReturnValue({
      text: vi.fn().mockResolvedValue(''),
      blob: vi.fn().mockResolvedValue(new Blob())
    })
    fileSave.mockClear()
    fileSave.mockResolvedValue(undefined)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('offers Markdown and HTML, but hides PDF when the site has no server-side rendering', async () => {
    ;({ wrapper } = await mountRail({ pdfExportAvailable: false }))

    const labels = menuItemLabels()
    expect(labels).toContain('Markdown')
    expect(labels).toContain('HTML')
    expect(labels).not.toContain('PDF')
  })

  it('shows PDF once the site surfaces it as available', async () => {
    ;({ wrapper } = await mountRail({ pdfExportAvailable: true }))

    expect(menuItemLabels()).toContain('PDF')
  })

  it('downloads Markdown via the export endpoint, named off the page path', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRail())
    API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('# Hello') })

    clickMenuItem('Markdown')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/export`,
      { searchParams: { format: 'markdown' } }
    )
    expect(fileSave).toHaveBeenCalledTimes(1)
    const [blob, opts] = fileSave.mock.calls[0]
    expect(blob.type).toBe('text/markdown')
    expect(opts).toMatchObject({ fileName: 'getting-started.md', extensions: ['.md'] })
  })

  it('downloads HTML via the export endpoint', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRail())
    API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('<p>Hi</p>') })

    clickMenuItem('HTML')
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/export`,
      { searchParams: { format: 'html' } }
    )
    const [blob, opts] = fileSave.mock.calls[0]
    expect(blob.type).toBe('text/html')
    expect(opts).toMatchObject({ fileName: 'getting-started.html', extensions: ['.html'] })
  })

  it('falls back to "home" for the file name when the page path is empty', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRail())
    ctx.pageStore.path = ''
    API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('# Home') })

    clickMenuItem('Markdown')
    await flushPromises()

    const [, opts] = fileSave.mock.calls[0]
    expect(opts.fileName).toBe('home.md')
  })

  /**
   * PDF is the one export that genuinely takes several real seconds (a headless Chromium render of
   * the live page view, per `models/pdfExport.ts`) rather than an instant client-side Blob, so the
   * button carries `w-btn`'s own `loading` state for the duration -- this is the "loading spinner
   * while Chromium renders" the task calls for, and it also disables the button so a second click
   * during the wait can't fire a second render.
   */
  it('shows a loading spinner on the Export button while the PDF request is in flight, and hits /export/pdf', async () => {
    let resolveBlob
    const blobPromise = new Promise((resolve) => {
      resolveBlob = resolve
    })
    let ctx
    ;({ wrapper } = ctx = await mountRail({ pdfExportAvailable: true }))
    API_CLIENT.get.mockReturnValueOnce({ blob: vi.fn().mockReturnValue(blobPromise) })

    clickMenuItem('PDF')
    await flushPromises()

    const trigger = wrapper.get('[aria-label="pageActions.exportPage"]')
    expect(trigger.attributes('aria-busy')).toBe('true')
    expect(trigger.attributes('disabled')).toBeDefined()

    expect(API_CLIENT.get).toHaveBeenCalledWith(
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/export/pdf`,
      expect.objectContaining({ timeout: expect.any(Number) })
    )

    resolveBlob(new Blob(['%PDF'], { type: 'application/pdf' }))
    await flushPromises()

    expect(trigger.attributes('aria-busy')).toBeUndefined()
    expect(fileSave).toHaveBeenCalledTimes(1)
    const [, opts] = fileSave.mock.calls[0]
    expect(opts).toMatchObject({ fileName: 'getting-started.pdf', extensions: ['.pdf'] })
  })

  it('does not treat a cancelled save picker (AbortError) as a failure', async () => {
    ;({ wrapper } = await mountRail())
    API_CLIENT.get.mockReturnValueOnce({ text: vi.fn().mockResolvedValue('# Hello') })
    fileSave.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AbortError' }))

    clickMenuItem('Markdown')
    await flushPromises()

    // -> No throw, and the trigger stays interactive: the earlier PDF test covers the failure path
    expect(
      wrapper.get('[aria-label="pageActions.exportPage"]').attributes('aria-busy')
    ).toBeUndefined()
  })
})

/**
 * OpenProject #858: Rerender Page can't just check `write:pages` -- the backend also refuses the
 * request when Puppeteer isn't installed (503) or the page's editor isn't markdown
 * (`renderUnsupportedEditor`). Mirrors the PDF export item's own availability gate above. Since
 * OpenProject #1917, `canRerenderPage` no longer decides whether the "..." Page Actions menu shows
 * at all -- View Backlinks is unconditional, so the trigger always renders; what varies here is only
 * whether Rerender Page itself appears inside it.
 */
async function mountRailWithPageActions({
  pdfExportAvailable = true,
  editor = 'markdown',
  canWritePages = true
} = {}) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = 'docs/getting-started'
  pageStore.editor = editor

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  siteStore.pdfExportAvailable = pdfExportAvailable

  const userStore = useUserStore()
  userStore.permissions = canWritePages ? ['write:pages'] : []

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n(PAGE_ACTIONS_MESSAGES)

  const wrapper = mount(PageActionsCol, {
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  return { wrapper, pageStore, siteStore, userStore }
}

/**
 * OpenProject #878: renaming a pending (not-yet-uploaded) asset from the "Pending Asset Uploads"
 * pane. Its own mount setup -- `write:pages` (the whole pane is gated on it) plus an active,
 * non-redirect editor, which none of the mount helpers above grant together.
 */
async function mountRailWithPendingAssets({ pendingAssets = [] } = {}) {
  setActivePinia(createPinia())

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = 'docs/getting-started'
  pageStore.editor = 'markdown'

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const userStore = useUserStore()
  userStore.permissions = ['write:pages']

  const editorStore = useEditorStore()
  editorStore.isActive = true
  editorStore.pendingAssets = pendingAssets

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n(PAGE_ACTIONS_MESSAGES)

  const wrapper = mount(PageActionsCol, {
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  await wrapper.get('[aria-label="pageActions.pendingAssetUploads"]').trigger('click')
  await flushPromises()

  return { wrapper, pageStore, siteStore, userStore, editorStore }
}

function clickByLabel(label) {
  document
    .querySelector(`[aria-label="${label}"]`)
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function typeInto(inputEl, value) {
  inputEl.value = value
  inputEl.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('PageActionsCol pending asset rename', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('shows the pending asset as plain text with no editable extension field', async () => {
    ;({ wrapper } = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    expect(document.body.textContent).toContain('a1b2c3.png')
    expect(document.querySelector('[aria-label="pageActions.renamePendingAsset"]')).not.toBeNull()
    expect(document.querySelector('input')).toBeNull()
  })

  it('opens an inline field pre-filled with the base name, extension shown fixed as a suffix', async () => {
    ;({ wrapper } = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()

    const input = document.querySelector('input')
    expect(input.value).toBe('a1b2c3')
    expect(document.body.textContent).toContain('.png')
  })

  it('commits a sanitized rename on Enter, keeping the fixed extension', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), 'Team Photo')
    document
      .querySelector('input')
      .dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('team-photo.png')
    // -> Back to read-only view, not left editing
    expect(document.querySelector('input')).toBeNull()
  })

  it('commits on the confirm button too', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), 'quarterly-report')
    clickByLabel('pageActions.confirmRename')
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('quarterly-report.png')
  })

  it('leaves the file name untouched when Cancel is clicked instead', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), 'should-not-stick')
    clickByLabel('pageActions.cancelRename')
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('a1b2c3.png')
    expect(document.body.textContent).toContain('a1b2c3.png')
  })

  it('leaves the file name untouched when Escape is pressed', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), 'should-not-stick')
    document
      .querySelector('input')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('a1b2c3.png')
  })

  it('does not commit a rename that sanitizes down to empty, and stays in edit mode', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'a1b2c3.png', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), '   ')
    clickByLabel('pageActions.confirmRename')
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('a1b2c3.png')
    // -> Still editing: no fileName text node, the field is still there
    expect(document.querySelector('input')).not.toBeNull()
  })

  it('preserves a pending asset with no extension at all when renamed', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPendingAssets({
      pendingAssets: [{ id: 'a1', fileName: 'screenshot', blobUrl: 'blob:a1' }]
    }))

    clickByLabel('pageActions.renamePendingAsset')
    await flushPromises()
    typeInto(document.querySelector('input'), 'renamed')
    clickByLabel('pageActions.confirmRename')
    await flushPromises()

    expect(ctx.editorStore.pendingAssets[0].fileName).toBe('renamed')
  })
})

describe('PageActionsCol page actions menu', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('offers Rerender Page when write:pages, Puppeteer and a markdown editor all line up', async () => {
    ;({ wrapper } = await mountRailWithPageActions())

    await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
    await flushPromises()

    expect(menuItemLabels()).toContain('Rerender Page')
  })

  // -> OpenProject #1917: View Backlinks is unconditional now, so unlike Rerender Page it never
  //    leaves the "..." trigger with nothing to show -- the button stays, just without Rerender Page.
  it('keeps the "..." Page Actions button visible via View Backlinks even when Rerender Page cannot run', async () => {
    ;({ wrapper } = await mountRailWithPageActions({ pdfExportAvailable: false }))

    expect(wrapper.find('[aria-label="common.header.pageActions"]').exists()).toBe(true)

    await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
    await flushPromises()

    expect(menuItemLabels()).not.toContain('Rerender Page')
    expect(menuItemLabels()).toContain('View Backlinks')
  })

  it('keeps the Page Actions menu visible for a non-markdown editor, still offering View Backlinks', async () => {
    ;({ wrapper } = await mountRailWithPageActions({ editor: 'code' }))

    expect(wrapper.find('[aria-label="common.header.pageActions"]').exists()).toBe(true)

    await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
    await flushPromises()

    expect(menuItemLabels()).not.toContain('Rerender Page')
    expect(menuItemLabels()).toContain('View Backlinks')
  })

  /**
   * OpenProject #1921: the dead menu-conversion placeholder item (and the `hasPageActions` computed
   * that existed only to keep this menu from opening empty for a guest) is gone entirely. This is the
   * scenario that computed used to guard -- a guest with neither `write:pages` nor `manage:pages` --
   * confirming the "..." trigger still renders and its menu still isn't empty, now on View Backlinks
   * alone, with no disabled placeholder standing in for the deleted entry.
   */
  it('shows a non-empty menu with only View Backlinks for a guest with no page permissions', async () => {
    ;({ wrapper } = await mountRailWithPageActions({ canWritePages: false }))

    expect(wrapper.find('[aria-label="common.header.pageActions"]').exists()).toBe(true)

    await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
    await flushPromises()

    const labels = menuItemLabels()
    expect(labels).toEqual(['View Backlinks'])
  })

  it('opens the backlinks side panel when View Backlinks is clicked', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPageActions())

    await wrapper.get('[aria-label="common.header.pageActions"]').trigger('click')
    await flushPromises()

    clickMenuItem('View Backlinks')
    await flushPromises()

    expect(ctx.siteStore.sideDialogComponent).toBe('PageBacklinksDialog')
    expect(ctx.siteStore.sideDialogShown).toBe(true)
  })
})

/**
 * OpenProject #1787: this `.onOk` handler used to call `pageStore.pageDuplicate(...)` with no
 * `await` and no `.catch` -- a rejection (the store's own `pageCreate` call, or the source-page
 * fetch before it) surfaced nowhere, leaving the reader with no feedback at all. Matches
 * `FileManager.vue`'s own duplicate handler, which already awaits and notifies.
 */
describe('PageActionsCol duplicate page (OpenProject #1787)', () => {
  let wrapper

  beforeEach(() => {
    notifyQueue.splice(0, notifyQueue.length)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    openDialogs.splice(0, openDialogs.length)
  })

  it('notifies instead of leaving an unhandled rejection when pageDuplicate fails', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPageActions())
    vi.spyOn(ctx.pageStore, 'pageDuplicate').mockRejectedValue(new Error('duplicate failed'))

    await wrapper.get('[aria-label="pageActions.duplicatePage"]').trigger('click')
    expect(openDialogs).toHaveLength(1)

    closeDialog(openDialogs[0].id, true, { path: 'copy', title: 'Copy' })
    await flushPromises()

    expect(ctx.pageStore.pageDuplicate).toHaveBeenCalledWith({
      sourcePageId: 'page-1',
      path: 'copy',
      title: 'Copy'
    })
    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0]).toMatchObject({ type: 'negative', message: 'Failed to duplicate page.' })
  })

  it('does not notify when the duplicate succeeds', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailWithPageActions())
    vi.spyOn(ctx.pageStore, 'pageDuplicate').mockResolvedValue(undefined)

    await wrapper.get('[aria-label="pageActions.duplicatePage"]').trigger('click')
    closeDialog(openDialogs[0].id, true, { path: 'copy', title: 'Copy' })
    await flushPromises()

    expect(notifyQueue).toHaveLength(0)
  })
})

describe('PageActionsCol homepage guard (WP #1149)', () => {
  let wrapper

  beforeEach(() => {
    notifyQueue.splice(0, notifyQueue.length)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    openDialogs.splice(0, openDialogs.length)
  })

  it('confirms before deleting the home page, then opens the real delete dialog', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'home' }))

    await wrapper.get('[aria-label="pageActions.deletePage"]').trigger('click')

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
    expect(openDialogs[0].props).toMatchObject({ pageId: 'page-1', pageName: 'Welcome' })
  })

  it('does not delete the home page when the guard is cancelled', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'home' }))

    await wrapper.get('[aria-label="pageActions.deletePage"]').trigger('click')
    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(openDialogs).toHaveLength(0)
  })

  it('deletes an ordinary page with no extra guard', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'docs/getting-started' }))

    await wrapper.get('[aria-label="pageActions.deletePage"]').trigger('click')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toMatchObject({ pageId: 'page-1', pageName: 'Welcome' })
  })

  it('confirms before moving the home page off `home`', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailForGuard({ path: 'home' }))
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    await wrapper.get('[aria-label="pageActions.renameMovePage"]').trigger('click')
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
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/path`,
      expect.anything()
    )
  })

  it('does not move when the homepage move guard is cancelled', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'home' }))

    await wrapper.get('[aria-label="pageActions.renameMovePage"]').trigger('click')
    closeDialog(openDialogs[0].id, true, {
      path: 'about-us',
      title: 'Welcome',
      includeTranslations: false
    })
    await flushPromises()
    closeDialog(openDialogs[0].id, false)
    await flushPromises()

    expect(API_CLIENT.put).not.toHaveBeenCalled()
    expect(openDialogs).toHaveLength(0)
  })

  it('does not guard a title-only rename of the home page (path unchanged)', async () => {
    ;({ wrapper } = await mountRailForGuard({ path: 'home' }))
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    await wrapper.get('[aria-label="pageActions.renameMovePage"]').trigger('click')
    closeDialog(openDialogs[0].id, true, {
      path: 'home',
      title: 'New Title',
      includeTranslations: false
    })
    await flushPromises()

    expect(openDialogs).toHaveLength(0)
    expect(API_CLIENT.patch).toHaveBeenCalled()
    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('moves an ordinary page with no extra guard', async () => {
    let ctx
    ;({ wrapper } = ctx = await mountRailForGuard({ path: 'docs/getting-started' }))
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    await wrapper.get('[aria-label="pageActions.renameMovePage"]').trigger('click')
    closeDialog(openDialogs[0].id, true, {
      path: 'docs/other',
      title: 'Getting Started',
      includeTranslations: false
    })
    await flushPromises()

    expect(openDialogs).toHaveLength(0)
    expect(API_CLIENT.put).toHaveBeenCalledWith(
      `sites/${ctx.siteStore.id}/pages/${ctx.pageStore.id}/path`,
      expect.anything()
    )
  })
})
